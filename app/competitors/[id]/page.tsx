import Link from 'next/link';
import { notFound } from 'next/navigation';
import CompetitorMetaConfigForm from '@/app/components/CompetitorMetaConfigForm';
import {
  getCompetitorById,
  getCompetitorWithScanHistory,
  getCompetitorAdsRanked,
} from '@/lib/queries/competitors';
import { getPendingAdCount } from '@/lib/queries/pendingAds';
import {
  tierLabel,
  confidenceLabel,
  evidenceLabel,
  creativeSourceLabel,
} from '@/lib/analysis/competitorScoring';

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return 'N/A';
  return new Date(date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getMetaReadiness(metaPageId: string | null, lastScannedAt: Date | null) {
  if (!metaPageId) {
    return {
      label: 'Not ready - Meta page ID missing',
      detail: 'Add a Meta Page ID below to enable competitor-specific Meta ingestion.',
    };
  }

  if (!lastScannedAt) {
    return {
      label: 'Ready - not yet scanned',
      detail: 'This competitor has a Meta Page ID and is ready for its first Meta ingestion run.',
    };
  }

  return {
    label: 'Ready - previously scanned',
    detail: `This competitor has a Meta Page ID and was last scanned on ${formatDate(lastScannedAt)}.`,
  };
}

export default async function CompetitorDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const [competitor, competitorWithScans, pendingAdCount, rankedAds] = await Promise.all([
    getCompetitorById(params.id),
    getCompetitorWithScanHistory(params.id),
    getPendingAdCount(params.id),
    getCompetitorAdsRanked(params.id),
  ]);

  if (!competitor) {
    notFound();
  }

  const scanRuns = competitorWithScans?.scanRuns ?? [];
  const metaReadiness = getMetaReadiness(competitor.metaPageId, competitor.lastScannedAt);

  // ── Benchmark summary (computed from the ranked ads) ──
  const scoredAds = rankedAds.filter((ad) => ad.competitorBenchmarkScore != null);
  const avgBenchmark =
    scoredAds.length > 0
      ? scoredAds.reduce((sum, ad) => sum + (ad.competitorBenchmarkScore as number), 0) / scoredAds.length
      : null;
  const tierMix = { STRONG: 0, MODERATE: 0, WEAK: 0, LOW: 0 };
  for (const ad of rankedAds) {
    if (ad.benchmarkTier && ad.benchmarkTier in tierMix) {
      tierMix[ad.benchmarkTier as keyof typeof tierMix] += 1;
    }
  }
  const highConfidenceCount = rankedAds.filter((ad) => ad.benchmarkConfidence === 'HIGH').length;
  const notScoredCount = rankedAds.length - scoredAds.length;

  return (
    <section>
      <p>
        <Link href="/competitors">Back to competitors</Link>
      </p>

      <h1>{competitor.name}</h1>

      <div className="card">
        <h2>Overview</h2>
        <p><strong>Client:</strong> {competitor.client.name}</p>
        <p><strong>Industry:</strong> {competitor.industry.name}</p>
        <p><strong>Status:</strong> {competitor.status}</p>
        <p><strong>Discovery source:</strong> {competitor.discoverySource}</p>
        <p>
          <strong>Facebook page:</strong>{' '}
          {competitor.facebookPageUrl ? (
            <a href={competitor.facebookPageUrl} target="_blank" rel="noreferrer">
              {competitor.facebookPageUrl}
            </a>
          ) : (
            'Not set'
          )}
        </p>
        <p>
          <strong>Meta Page ID:</strong>{' '}
          {competitor.metaPageId ? <code>{competitor.metaPageId}</code> : 'Not set'}
        </p>
        <p><strong>Readiness:</strong> {metaReadiness.label}</p>
        <p><strong>Last scanned:</strong> {formatDate(competitor.lastScannedAt)}</p>
      </div>

      <div className="card">
        <h2>Meta configuration</h2>
        <p>{metaReadiness.detail}</p>
        {competitor.metaPageId && (
          <p>
            Ingestion command:{' '}
            <code>COMPETITOR_ID={competitor.id} npm run meta:ingest</code>
          </p>
        )}
        <CompetitorMetaConfigForm
          competitorId={competitor.id}
          facebookPageUrl={competitor.facebookPageUrl}
          metaPageId={competitor.metaPageId}
        />
      </div>

      <div className="card">
        <h2>Summary</h2>
        <p>Total ads: {competitor._count.ads}</p>
        <p>
          Average benchmark (scored):{' '}
          {avgBenchmark !== null ? `${avgBenchmark.toFixed(1)} / 10` : 'N/A'}
        </p>
        <p>
          Tier mix: Strong {tierMix.STRONG} · Moderate {tierMix.MODERATE} · Weak{' '}
          {tierMix.WEAK} · Low {tierMix.LOW}
        </p>
        <p>High-confidence ads (Vision): {highConfidenceCount}</p>
        <p>Not scored yet: {notScoredCount}</p>
        <p>Scan runs: {competitor._count.scanRuns}</p>
      </div>

      {pendingAdCount > 0 && (
        <div className="card">
          <h2>Pending Meta ads</h2>
          <p>
            <strong>{pendingAdCount}</strong> ad
            {pendingAdCount !== 1 ? 's' : ''} discovered via the Meta Ad Library
            API {pendingAdCount !== 1 ? 'are' : 'is'} awaiting review.
          </p>
          <p>
            <Link href={`/meta-review?competitorId=${competitor.id}`}>
              Review pending ads
            </Link>
          </p>
        </div>
      )}

      <div className="card">
        <h2>Competitor ads — ranked by benchmark</h2>
        {rankedAds.length === 0 ? (
          <p>No ads found for this competitor yet.</p>
        ) : (
          rankedAds.map((ad) => {
            const scored = ad.competitorBenchmarkScore != null;
            return (
              <div className="card" key={ad.id}>
                <p>
                  <strong>
                    {scored
                      ? `${(ad.competitorBenchmarkScore as number).toFixed(1)} / 10`
                      : 'Not scored yet'}
                  </strong>
                  {scored && <> · {tierLabel(ad.benchmarkTier)}</>}
                  {' · '}
                  <span className="badge">{confidenceLabel(ad.benchmarkConfidence)}</span>
                </p>
                <p>
                  <strong>Format:</strong> {ad.adFormat}
                  {' · '}
                  <strong>Creative:</strong> {creativeSourceLabel(ad.creativeSource)}
                  {' · '}
                  <strong>Evidence:</strong> {evidenceLabel(ad.evidenceSource)}
                </p>
                <p>
                  <strong>Headline:</strong>{' '}
                  {ad.headline ?? ad.metaAdId ?? 'No headline available'}
                </p>
                <p className="muted" style={{ fontSize: '12px' }}>
                  Internal QA score: {ad.score.toFixed(1)} / 10 (for comparison only)
                </p>
                <p>
                  <Link href={`/ads/${ad.id}`}>Open ad detail</Link>
                  {' | '}
                  <a href={ad.adLink} target="_blank" rel="noreferrer">
                    Open Facebook ad
                  </a>
                </p>
              </div>
            );
          })
        )}
      </div>

      <div className="card">
        <h2>Scan run history</h2>
        {scanRuns.length === 0 ? (
          <p>No scan runs recorded for this competitor.</p>
        ) : (
          scanRuns.map((run) => (
            <div className="card" key={run.id}>
              <p>
                <strong>{run.source}</strong> · {run.status}
              </p>
              <p><strong>Started:</strong> {formatDate(run.startedAt)}</p>
              {run.completedAt && (
                <p><strong>Completed:</strong> {formatDate(run.completedAt)}</p>
              )}
              <p>
                New: {run.newAdsFound} · Removed: {run.adsRemoved} · Unchanged: {run.adsUnchanged}
              </p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
