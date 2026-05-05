/**
 * /meta-review
 *
 * Review queue for Meta API-discovered ads.
 * Shows only ads where adSource='meta_api' AND reviewStatus='PENDING'.
 *
 * Supports optional competitorId filtering:
 *   /meta-review?competitorId=xxx
 *
 * Token safety:
 *   adLink is never rendered as a raw href — it goes through safeUrlLabel()
 *   first. If a token is present the field shows as plain text only.
 *   No other URL fields are rendered.
 */

import Link from 'next/link';
import { getPendingAds } from '@/lib/queries/pendingAds';
import { safeUrlLabel } from '@/lib/providers/meta/redact';

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function truncate(str: string | null | undefined, max = 160): string {
  if (!str) return '—';
  return str.length > max ? `${str.substring(0, max)}…` : str;
}

function fmt(score: number | null | undefined): string {
  if (score === null || score === undefined) return 'N/A';
  return score.toFixed(1);
}

const VERDICT_LABELS: Record<string, string> = {
  STRONG_READY_TO_TEST: '✅ Strong — ready to test',
  GOOD_NEEDS_SHARPENING: '🟡 Good — needs sharpening',
  CLEAR_IDEA_WEAK_SIGNALS: '🟠 Clear idea — weak signals',
  TOO_VAGUE_MAJOR_REWORK: '🔴 Too vague — major rework',
  INSUFFICIENT_INFORMATION: '⚪ Insufficient information',
};

// ─── page ────────────────────────────────────────────────────────────────────

export default async function MetaReviewPage({
  searchParams,
}: {
  searchParams: { competitorId?: string };
}) {
  const competitorId = searchParams.competitorId?.trim() || undefined;
  const ads = await getPendingAds({ competitorId });

  const pageTitle = competitorId
    ? `Pending Meta ads — competitor filter active`
    : 'Pending Meta ads';

  return (
    <section>
      <p>
        <Link href="/">← Dashboard</Link>
        {' | '}
        <Link href="/competitors">Competitors</Link>
      </p>

      <h1>{pageTitle}</h1>

      {competitorId && (
        <p>
          Filtering by competitor ID: <code>{competitorId}</code>{' '}
          <Link href="/meta-review">Clear filter</Link>
        </p>
      )}

      <div className="card">
        <p>
          <strong>Pending ads:</strong> {ads.length}
        </p>
        <p>
          These ads were discovered via the Meta Ad Library API. They are stored
          as discovered activity and are not yet part of the qualified library.
          Review each ad and approve or reject it.
        </p>
        <p>
          <strong>Approve (score ≥ 7.0):</strong> promotes to qualified library.
          <br />
          <strong>Approve (score &lt; 7.0):</strong> acknowledged for tracking
          only — does not enter the library.
          <br />
          <strong>Reject:</strong> removes from queue, keeps record for scan
          history.
        </p>
      </div>

      {ads.length === 0 ? (
        <div className="card">
          <p>No pending Meta ads{competitorId ? ' for this competitor' : ''}.</p>
          <p>
            Run <code>npm run meta:ingest</code> to fetch new ads from the Meta
            Ad Library.
          </p>
        </div>
      ) : (
        ads.map((ad) => {
          const a = ad.analysis;
          const verdict = a?.finalVerdict
            ? (VERDICT_LABELS[a.finalVerdict] ?? a.finalVerdict)
            : '—';

          // Token safety: never render adLink as a raw href
          const adLinkLabel = safeUrlLabel(ad.adLink);
          const adLinkIsSafe =
            ad.adLink &&
            adLinkLabel !== 'N/A' &&
            adLinkLabel !== 'present (token redacted)';

          return (
            <div className="card" key={ad.id}>
              {/* ── Identity ── */}
              <p>
                <strong>{ad.competitor.name}</strong>
                {' · '}
                {ad.adFormat}
                {' · '}
                <strong>Score: {ad.score.toFixed(1)} / 10</strong>
                {ad.score >= 7.0 && (
                  <span> · 🔑 qualifies for library on approval</span>
                )}
              </p>
              <p>
                <strong>Verdict:</strong> {verdict}
              </p>

              {/* ── Content ── */}
              {ad.headline && (
                <p>
                  <strong>Headline:</strong> {ad.headline}
                </p>
              )}
              {ad.primaryCopy && (
                <p>
                  <strong>Copy:</strong> {truncate(ad.primaryCopy)}
                </p>
              )}
              {ad.description && (
                <p>
                  <strong>Description:</strong> {truncate(ad.description)}
                </p>
              )}

              {/* ── Component scores ── */}
              {a && (
                <p>
                  <strong>Component scores:</strong>{' '}
                  Copy {fmt(a.copyScore)}
                  {' · '}
                  Headline {fmt(a.headlineScore)}
                  {' · '}
                  Desc {fmt(a.descriptionScore)}
                </p>
              )}

              {/* ── Metadata ── */}
              <p>
                <strong>Ad status:</strong> {ad.adStatus}
                {' · '}
                <strong>First seen:</strong> {formatDate(ad.firstSeenAt)}
                {' · '}
                <strong>Last seen:</strong> {formatDate(ad.lastSeenAt)}
              </p>

              {/* ── External link — token-safe ── */}
              <p>
                <strong>Ad link:</strong>{' '}
                {adLinkIsSafe ? (
                  <a href={ad.adLink!} target="_blank" rel="noreferrer noopener">
                    Open ad ↗
                  </a>
                ) : (
                  <span>{adLinkLabel}</span>
                )}
              </p>

              {/* ── Review actions ── */}
              <p>
                <form
                  method="POST"
                  action={`/api/ads/${ad.id}/review`}
                  style={{ display: 'inline' }}
                >
                  <input type="hidden" name="action" value="APPROVE" />
                  <button type="submit">
                    {ad.score >= 7.0 ? 'Approve → Add to library' : 'Approve (tracking only)'}
                  </button>
                </form>
                {'  '}
                <form
                  method="POST"
                  action={`/api/ads/${ad.id}/review`}
                  style={{ display: 'inline' }}
                >
                  <input type="hidden" name="action" value="REJECT" />
                  <button type="submit">Reject</button>
                </form>
              </p>

              {/* ── Meta ID (for audit / debugging) ── */}
              {ad.metaAdId && (
                <p style={{ fontSize: '0.85em', color: '#666' }}>
                  Meta Ad ID: {ad.metaAdId}
                </p>
              )}
            </div>
          );
        })
      )}
    </section>
  );
}
