import Link from 'next/link';
import { db } from '@/lib/db';

export default async function IndustriesPage() {
  const industries = await db.industry.findMany({
    orderBy: { name: 'asc' },
    include: {
      _count: {
        select: {
          clients: true,
          ads: true,
        },
      },
    },
  });

  return (
    <section>
      <h1>Industries</h1>
      <p>Browse industries in the Meta Competitor Ad Library.</p>

      {industries.length === 0 ? (
        <div className="card">
          <p>No industries found.</p>
        </div>
      ) : (
        industries.map((industry) => (
          <div className="card" key={industry.id}>
            <p>
              <strong>{industry.name}</strong>
            </p>
            <p>Clients: {industry._count.clients}</p>
            <p>Ads: {industry._count.ads}</p>
            <p>
              <Link href={`/industries/${industry.slug}`}>Open industry</Link>
            </p>
          </div>
        ))
      )}
    </section>
  );
}
