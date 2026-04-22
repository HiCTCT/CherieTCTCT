import Link from 'next/link';
import { getDashboardCounts, getQualifiedAds } from '@/lib/queries/ads';

export default async function DashboardPage() {
  const [industryCount, clientCount, qualifiedAdCount] = await getDashboardCounts();
  const latestAds = await getQualifiedAds(12);

  return (
    <section>
      <h1>Meta Competitor Ad Library</h1>

      <div className="card">
        <p><strong>Industries:</strong> {industryCount}</p>
        <p><strong>Clients:</strong> {clientCount}</p>
        <p><strong>Qualified ads:</strong> {qualifiedAdCount}</p>
      </div>

      <p>
        <Link href="/industries">Browse industries</Link>
      </p>

      <h2>Latest qualified ads</h2>
      {latestAds.length === 0 ? (
        <div className="card">
          <p>No qualified ads found.</p>
        </div>
      ) : (
        latestAds.map((ad) => (
          <div className="card" key={ad.id}>
            <p>
              <strong>{ad.competitor.name}</strong> &middot; {ad.industry.name}
            </p>
            <p>
              Format: <strong>{ad.adFormat}</strong> &middot; Score{' '}
              <strong>{ad.score.toFixed(1)}</strong> / 10
            </p>
            <p>
              <Link href={`/ads/${ad.id}`}>Open ad detail</Link>
            </p>
          </div>
        ))
      )}
    </section>
  );
}
