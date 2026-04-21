import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';

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
          industry.clients.map((client) => (
            <p key={client.id}>{client.name}</p>
          ))
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
                <strong>{ad.competitor.name}</strong> · Score {ad.score.toFixed(1)}
              </p>
              <p>{ad.productOrService ?? 'No product name available'}</p>
              <p>
                <Link href={`/ads/${ad.id}`}>Open ad detail</Link>
              </p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
