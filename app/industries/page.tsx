import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';

function truncateText(value: string | null | undefined, maxLength = 140): string {
  if (!value) return 'No analysis available.';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trim()}...`;
}

export default async function IndustryDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  const industry = await db.industry.findUnique({
    where: { slug: params.slug },
    include: {
      clients: {
        orderBy: { name: 'asc' },
      },
      ads: {
        where: { qualified: true },
        include: {
          competitor: true,
          analysis: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      },
    },
  });

  if (!industry) {
    notFound();
  }

  return (
    <section>
      <p>
        <Link href="/industries">Back to industries</Link>
      </p>

      <h1>{industry.name}</h1>
      <p>Clients in this industry: {industry.clients.length}</p>
      <p>Qualified ads in this industry: {industry.ads.length}</p>

      <div className="card">
        <h2>Clients</h2>
        {industry.clients.length === 0 ? (
          <p>No clients found for this industry.</p>
        ) : (
          industry.clients.map((client) => <p key={client.id}>{client.name}</p>)
        )}
      </div>

      <div className="card">
        <h2>Latest qualified ads</h2>
        {industry.ads.length === 0 ? (
          <p>No qualified ads found.</p>
        ) : (
          industry.ads.map((ad) => (
            <div className="card" key={ad.id}>
              <p>
                <strong>{ad.competitor.name}</strong> · Score {ad.score.toFixed(1)} / 10
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
      </div>
    </section>
  );
}
