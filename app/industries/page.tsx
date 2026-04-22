import Link from 'next/link';
import { getIndustries } from '@/lib/queries/industries';

export default async function IndustriesPage() {
  const industries = await getIndustries();

  return (
    <section>
      <p>
        <Link href="/">Back to dashboard</Link>
      </p>

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
