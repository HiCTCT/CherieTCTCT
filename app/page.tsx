import Link from 'next/link';
import { db } from '@/lib/db';

type PageProps = {
  searchParams?: {
    competitor?: string;
  };
};

export default async function Page({ searchParams }: PageProps) {
  const rawCompetitor = searchParams?.competitor ?? '';
  const competitorFilter = rawCompetitor.trim();

  const adWhere = {
    qualified: true,
    ...(competitorFilter
      ? {
          competitor: {
            name: {
              contains: competitorFilter,
            },
          },
        }
      : {}),
  };

  const [industryCount, clientCount, adCount, latestAds] = await Promise.all([
    db.industry.count(),
    db.client.count(),
    db.ad.count({ where: adWhere }),
    db.ad.findMany({
      where: adWhere,
      include: { competitor: true, industry: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  return (
    <section>
      <h1>Meta Competitor Ad Library</h1>

      <p>
        <Link href="/industries">View industries</Link>
      </p>

      <form method="GET" className="card">
        <label htmlFor="competitor">
          <strong>Competitor name</strong>
        </label>
        <div style={{ marginTop: '12px' }}>
          <input
            id="competitor"
            name="competitor"
            type="text"
            defaultValue={rawCompetitor}
            placeholder="e.g. Seed Competitor"
            style={{ padding: '8px', marginRight: '8px', minWidth: '260px' }}
          />
          <button type="submit" style={{ padding: '8px 12px', marginRight: '8px' }}>
            Apply
          </button>
          <Link href="/">Clear</Link>
        </div>
      </form>

      <div className="card">Industries: {industryCount}</div>
      <div className="card">Clients: {clientCount}</div>
      <div className="card">Qualified ads: {adCount}</div>

      <h2>Latest qualified ads</h2>
      {latestAds.length === 0 ? (
        <div className="card">
          <p>No qualified ads found for this filter.</p>
        </div>
      ) : (
        latestAds.map((ad) => (
          <div className="card" key={ad.id}>
            <p>
              <strong>{ad.competitor.name}</strong> · {ad.industry.name} · Score{' '}
              {ad.score.toFixed(1)}
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
