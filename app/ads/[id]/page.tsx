import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';

export default async function AdDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const ad = await db.ad.findUnique({
    where: { id: params.id },
    include: {
      industry: true,
      client: true,
      competitor: true,
      analysis: true,
    },
  });

  if (!ad || !ad.qualified) {
    notFound();
  }

  return (
    <section>
      <p>
        <Link href="/">Back to homepage</Link>
        {' | '}
        <Link href="/industries">View industries</Link>
      </p>

      <h1>Ad detail</h1>

      <div className="card">
        <h2>Overview</h2>
        <p>
          <strong>Industry:</strong> {ad.industry.name}
        </p>
        <p>
          <strong>Client:</strong> {ad.client.name}
        </p>
        <p>
          <strong>Competitor:</strong> {ad.competitor.name}
        </p>
        <p>
          <strong>Product:</strong> {ad.productOrService ?? 'No product name available'}
        </p>
        <p>
          <strong>Score:</strong> {ad.score.toFixed(1)} / 10
        </p>
        <p>
          <strong>Headline:</strong> {ad.headline ?? 'No headline available'}
        </p>
        <p>
          <strong>Description:</strong> {ad.description ?? 'No description available'}
        </p>
        <p>
          <strong>Primary copy:</strong> {ad.primaryCopy ?? 'No primary copy available'}
        </p>
        <p>
          <strong>Facebook ad link:</strong>{' '}
          <a href={ad.adLink} target="_blank" rel="noreferrer">
            Open Facebook ad
          </a>
        </p>
      </div>

      <div className="card">
        <h2>Creative Analysis</h2>
        <p>{ad.analysis?.creativeAnalysis ?? 'No creative analysis available.'}</p>
      </div>

      <div className="card">
        <h2>Copy Analysis</h2>
        <p>{ad.analysis?.copyAnalysis ?? 'No copy analysis available.'}</p>
      </div>

      <div className="card">
        <h2>Headline Analysis</h2>
        <p>{ad.analysis?.headlineAnalysis ?? 'No headline analysis available.'}</p>
      </div>

      <div className="card">
        <h2>Description Analysis</h2>
        <p>{ad.analysis?.descriptionAnalysis ?? 'No description analysis available.'}</p>
      </div>
    </section>
  );
}
