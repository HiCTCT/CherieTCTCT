import { notFound } from 'next/navigation';
import { db } from '@/lib/db';

export default async function AdDetailPage({ params }: { params: { id: string } }) {
  const ad = await db.ad.findUnique({
    where: { id: params.id },
    include: { industry: true, client: true, competitor: true, analysis: true },
  });

  if (!ad || !ad.qualified) {
    notFound();
  }

  return (
    <section>
      <h1>Ad detail</h1>
      <div className="card">
        <p><strong>Industry:</strong> {ad.industry.name}</p>
        <p><strong>Client:</strong> {ad.client.name}</p>
        <p><strong>Competitor:</strong> {ad.competitor.name}</p>
        <p><strong>Link:</strong> <a href={ad.adLink} target="_blank">{ad.adLink}</a></p>
        <p><strong>Score:</strong> {ad.score.toFixed(1)}</p>
      </div>

      <div className="card">
        <h2>Analysis</h2>
        <p>{ad.analysis?.creativeAnalysis}</p>
        <p>{ad.analysis?.copyAnalysis}</p>
        <p>{ad.analysis?.headlineAnalysis}</p>
        <p>{ad.analysis?.descriptionAnalysis}</p>
      </div>
    </section>
  );
}
