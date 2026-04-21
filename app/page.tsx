import Link from 'next/link';
import { db } from '@/lib/db';

type PageProps = {
  searchParams?: {
    competitor?: string;
    industry?: string;
  };
};

function truncateText(value: string | null | undefined, maxLength = 140): string {
  if (!value) return 'No analysis available.';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trim()}...`;
}

export default async function Page({ searchParams }: PageProps) {
  const rawCompetitor = searchParams?.competitor ?? '';
  const rawIndustry = searchParams?.industry ?? '';

  const competitorFilter = rawCompetitor.trim();
  const industryFilter = rawIndustry.trim();

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
    ...(industryFilter
      ? {
          industry: {
            slug: industryFilter,
          },
        }
      : {}),
  };

  const [industryCount, clientCount, adCount, latestAds, industries] = await Promise.all([
    db.industry.count(),
    db.client.count(),
    db.ad.count({ where: adWhere }),
    db.ad.findMany({
      where: adWhere,
      include: {
        competitor: true,
        industry: true,
        analysis: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    db.industry.findMany({
      orderBy: { name: 'asc' },
    }),
  ]);

  return (
    <section>
      <h1>Meta Competitor Ad Library</h1>

      <p>
        <Link href="/industries">View industries</Link>
      </p>

      <form method="GET" className="card">
        <div style={{ marginBottom: '12px' }}>
          <label htmlFor="competitor">
            <strong>Competitor name</strong>
          </label>
          <div style={{ marginTop: '8px' }}>
            <input
              id="competitor"
              name="competitor"
              type="text"
              defaultValue={rawCompetitor}
              placeholder="e.g. Seed Competitor"
              style={{ padding: '8px', marginRight: '8px', minWidth: '260px' }}
            />
          </div>
        </div>

        <div style={{ marginBottom: '12px' }}>
          <label htmlFor="industry">
            <strong>Industry</strong>
          </label>
          <div style={{ marginTop: '8px' }}>
            <select
              id="industry"
              name="industry"
              defaultValue={rawIndustry}
              style={{ padding: '8px', minWidth: '260px' }}
            >
              <option value="">All industries</option>
              {industries.map((industry) => (
                <option key={industry.id} value={industry.slug}>
                  {industry.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button type="submit" style={{ padding: '8px 12px', marginRight: '8px' }}>
          Apply
        </button>
        <Link href="/">Clear</Link>
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
              <strong>{ad.competitor.name}</strong> · {ad.industry.name}
            </p>
            <p>
              <strong>Score:</strong> {ad.score.toFixed(1)} / 10
            </p>
            <p>
              <strong>Product:</strong> {ad.productOrService ?? 'No product name available'}
            </p>
            <p>
              <strong>Headline:</strong> {ad.headline ?? 'No headline available'}
            </p>
            <p>
              <strong>Copy preview:</strong> {truncateText(ad.primaryCopy, 160)}
            </p>
            <p>
              <strong>Analysis summary:</strong>{' '}
              {truncateText(ad.analysis?.creativeAnalysis, 140)}
            </p>
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
    </section>
  );
}
