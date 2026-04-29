import Link from 'next/link';
import { getCompetitors } from '@/lib/queries/competitors';

function formatDate(date: Date | null | undefined): string {
  if (!date) return 'Not yet scanned';
  return new Date(date).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default async function CompetitorsPage() {
  const competitors = await getCompetitors();

  return (
    <section>
      <p>
        <Link href="/">Back to dashboard</Link>
      </p>

      <h1>Competitors</h1>
      <p>Browse tracked competitors in the Meta Competitor Ad Library.</p>

      {competitors.length === 0 ? (
        <div className="card">
          <p>No competitors found.</p>
        </div>
      ) : (
        competitors.map((competitor) => (
          <div className="card" key={competitor.id}>
            <p>
              <strong>{competitor.name}</strong>
            </p>
            <p>Client: {competitor.client.name}</p>
            <p>Industry: {competitor.industry.name}</p>
            <p>Status: {competitor.status}</p>
            <p>Ads: {competitor._count.ads}</p>
            <p>Scan runs: {competitor._count.scanRuns}</p>
            <p>Last scanned: {formatDate(competitor.lastScannedAt)}</p>
            <p>
              <Link href={`/competitors/${competitor.id}`}>Open competitor</Link>
            </p>
          </div>
        ))
      )}
    </section>
  );
}
