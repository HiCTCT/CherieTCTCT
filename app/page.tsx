import Link from 'next/link';
import { Suspense } from 'react';
import { getDashboardCounts, getQualifiedAds } from '@/lib/queries/ads';
import { db } from '@/lib/db';
import DashboardFilter from '@/app/components/DashboardFilter';

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { industry?: string; q?: string };
}) {
  const industrySlug = searchParams.industry || '';
  const searchTerm = searchParams.q || '';

  const [industryCount, clientCount, qualifiedAdCount] = await getDashboardCounts();

  const industries = await db.industry.findMany({
    where: {
      ads: { some: { qualified: true } },
    },
    select: { slug: true, name: true },
    orderBy: { name: 'asc' },
  });

  const latestAds = await getQualifiedAds({
    limit: 12,
    industrySlug: industrySlug || undefined,
    search: searchTerm || undefined,
  });

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

      <Suspense fallback={<p>Loading filters…</p>}>
        <DashboardFilter
          industries={industries}
          currentIndustry={industrySlug}
          currentSearch={searchTerm}
        />
      </Suspense>

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
