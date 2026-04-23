import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCompetitorById, getCompetitorWithScanHistory } from '@/lib/queries/competitors';

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

export default async function CompetitorDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const [competitor, competitorWithScans] = await Promise.all([
    getCompetitorById(params.id),
    getCompetitorWithScanHistory(params.id),
  ]);

  if (!competitor) {
    notFound();
  }

  const scanRuns = competitorWithScans?.scanRuns ?? [];

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
        {competitor.facebookPageUrl && (
          <p>
            <strong>Facebook page:</strong>{' '}
            <a href={competitor.facebookPageUrl} target="_blank" rel="noreferrer">
              {competitor.facebookPageUrl}
            </a>
          </p>
        )}
        <p><strong>Last scanned:</strong> {formatDate(competitor.lastScannedAt)}</p>
      </div>

      <div className="card">
        <h2>Summary</h2>
        <p>Total ads: {competitor._count.ads}</p>
        <p>Qualified ads: {competitor.ads.length}</p>
        <p>Scan runs: {competitor._count.scanRuns}</p>
      </div>

      <div className="card">
        <h2>Recent qualified ads</h2>
        {competitor.ads.length === 0 ? (
          <p>No qualified ads found for this competitor.</p>
        ) : (
          competitor.ads.map((ad) => (
            <div className="card" key={ad.id}>
              <p>
                <strong>{ad.productOrService ?? 'No product name'}</strong> · Score{' '}
                {ad.score.toFixed(1)} / 10
              </p>
              <p><strong>Format:</strong> {ad.adFormat}</p>
              <p><strong>Headline:</strong> {ad.headline ?? 'No headline available'}</p>
              <p>
                <Link href={`/ads/${ad.id}`}>Open ad detail</Link>
                {' | '}
                <a href={ad.adLink} target="_blank" rel="noreferrer">
                  Open Facebook ad
                </a>
              </p>
            </div>
          ))
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
