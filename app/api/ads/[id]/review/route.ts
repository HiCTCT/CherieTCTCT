/**
 * POST /api/ads/[id]/review
 *
 * Approve or reject a pending Meta ad.
 *
 * Approval rules (enforced server-side — score is read from the database,
 * never trusted from the request body):
 *
 *   APPROVE + score >= 7.0  →  reviewStatus='APPROVED', qualified=true
 *   APPROVE + score <  7.0  →  reviewStatus='APPROVED', qualified=false
 *   REJECT                  →  reviewStatus='REJECTED',  qualified=false
 *
 * Rejected ads stay in the database for deduplication and scan history.
 * This route never touches adLink — no token exposure risk.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

const VALID_ACTIONS = ['APPROVE', 'REJECT'] as const;
type ReviewAction = (typeof VALID_ACTIONS)[number];

function isValidAction(value: unknown): value is ReviewAction {
  return typeof value === 'string' && (VALID_ACTIONS as readonly string[]).includes(value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const adId = params.id;

  // Parse action from form body or JSON
  let action: unknown;
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const formData = await request.formData();
    action = formData.get('action');
  } else {
    try {
      const body = await request.json() as { action?: unknown };
      action = body.action;
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
  }

  if (!isValidAction(action)) {
    return NextResponse.json(
      { error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}` },
      { status: 400 },
    );
  }

  // Load the ad — score is read from DB, never from the request
  const ad = await db.ad.findUnique({
    where: { id: adId },
    select: { id: true, adSource: true, reviewStatus: true, score: true },
  });

  if (!ad) {
    return NextResponse.json({ error: 'Ad not found' }, { status: 404 });
  }

  // Only Meta API ads in PENDING state are reviewable via this route
  if (ad.adSource !== 'meta_api') {
    return NextResponse.json(
      { error: 'Only Meta API ads can be reviewed via this route' },
      { status: 422 },
    );
  }

  if (ad.reviewStatus !== 'PENDING') {
    return NextResponse.json(
      { error: `Ad is already ${ad.reviewStatus}. Only PENDING ads can be reviewed.` },
      { status: 422 },
    );
  }

  // Apply the review decision
  if (action === 'APPROVE') {
    // Score >= 7.0: promote to qualified library
    // Score <  7.0: approved for tracking only, not added to library
    const qualified = ad.score >= 7.0;
    await db.ad.update({
      where: { id: adId },
      data: { reviewStatus: 'APPROVED', qualified },
    });
  } else {
    // REJECT: keep record for deduplication and scan history
    await db.ad.update({
      where: { id: adId },
      data: { reviewStatus: 'REJECTED', qualified: false },
    });
  }

  // Redirect back to the review queue, preserving any competitorId filter
  const referer = request.headers.get('referer') ?? '/meta-review';
  const redirectUrl = referer.includes('/meta-review') ? referer : '/meta-review';

  return NextResponse.redirect(new URL(redirectUrl, request.url));
}
