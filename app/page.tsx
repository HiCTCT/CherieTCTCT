import Link from 'next/link';
import { db } from '@/lib/db';

export default async function Page() {
  const [industryCount, clientCount, adCount, latestAds] = await Promise.all([
    db.industry.count(),
    db.client.count(),
    db.ad.count({ where: { qualified: true } }),
    db.ad.findMany({
      where: { qualified: true },
      include: { competitor: true, industry: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  return (
    <section>
      <h1>Meta Competitor Ad Library</h1>
      <div className="card">Industries: {industryCount}</div>
      <div className="card">Clients: {clientCount}</div>
      <div className="card">Qualified ads: {adCount}</div>

      <h2>Latest qualified ads</h2>
      {latestAds.map((ad) => (
        <div className="card" key={ad.id}>
          <p>
            <strong>{ad.competitor.name}</strong> · {ad.industry.name} · Score {ad.score.toFixed(1)}
          </p>
          <p>
            <Link href={`/ads/${ad.id}`}>Open ad detail</Link>
          </p>
        </div>
      ))}
    </section>
  );
}
