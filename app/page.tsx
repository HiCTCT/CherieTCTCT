import Link from 'next/link';
import { db } from '@/lib/db';

export default async function Page() {
  const [industryCount, clientCount, adCount, latestAds] = await Promise.all([
    db.industry.count(),
    db.client.count(),
    db.ad.count({ where: { qualified: true } }),
    db.ad.findMany({
      where: { qualified: true },
      include: { competitor: true, industry: true, analysis: true },
      orderBy: { score: 'desc' },
      take: 12,
    }),
  ]);

  return (
    <section>
      <h1>Meta Competitor Ad Library</h1>
      <div className="card">Industries: {industryCount}</div>
      <div className="card">Clients: {clientCount}</div>
      <div className="card">Qualified ads: {adCount}</div>

      <p>
        <Link href="/industries">Browse industries</Link>
      </p>

      <h2>Latest qualified ads</h2>
      {latestAds.map((ad) => (
        <div className="card" key={ad.id}>
          <p>
            <strong>{ad.competitor.name}</strong> · {ad.industry.name}
          </p>
          <p>
            Format: <strong>{ad.adFormat}</strong> · Score <strong>{ad.score.toFixed(2)}</strong>
          </p>
          <p>
            Funnel: {ad.analysis?.funnelStage ?? 'N/A'} · RACE: {ad.analysis?.raceStage ?? 'N/A'}
          </p>
          <p>
            <Link href={`/ads/${ad.id}`}>Open ad detail</Link>
          </p>
        </div>
      ))}
    </section>
  );
}
