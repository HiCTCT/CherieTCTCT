/**
 * Queries for the Meta ad review workflow.
 *
 * Intentionally isolated from lib/queries/ads.ts so that pending-ad logic
 * never bleeds into the qualified library queries.
 *
 * All functions here target:
 *   adSource = 'meta_api'
 *   reviewStatus = 'PENDING'
 *
 * These ads are discovered activity — not curated library entries.
 */

import { db } from '@/lib/db';

export type PendingAdsFilter = {
  competitorId?: string;
};

/**
 * Returns all pending Meta ads for the review queue.
 * Ordered by score descending so high-potential ads surface first.
 */
export function getPendingAds(filter: PendingAdsFilter = {}) {
  return db.ad.findMany({
    where: {
      adSource: 'meta_api',
      reviewStatus: 'PENDING',
      ...(filter.competitorId ? { competitorId: filter.competitorId } : {}),
    },
    include: {
      competitor: { select: { id: true, name: true } },
      analysis: {
        select: {
          overallScore: true,
          finalVerdict: true,
          copyScore: true,
          headlineScore: true,
          descriptionScore: true,
        },
      },
    },
    orderBy: { score: 'desc' },
  });
}

/**
 * Returns the count of pending Meta ads for a specific competitor.
 * Used on the competitor detail page to surface the review queue link.
 */
export function getPendingAdCount(competitorId: string): Promise<number> {
  return db.ad.count({
    where: {
      adSource: 'meta_api',
      reviewStatus: 'PENDING',
      competitorId,
    },
  });
}
