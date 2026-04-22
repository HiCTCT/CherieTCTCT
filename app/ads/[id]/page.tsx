import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export default async function AdDetailPage({ params }: { params: { id: string } }) {
  const ad = await db.ad.findUnique({
    where: { id: params.id },
    include: { industry: true, client: true, competitor: true, analysis: true },
  });

  if (!ad || !ad.qualified || !ad.analysis) {
    notFound();
  }

  const strengths = parseJsonArray(ad.analysis.strengthsJson);
  const weaknesses = parseJsonArray(ad.analysis.weaknessesJson);
  const improvements = parseJsonArray(ad.analysis.improvementsJson);
  const rubric = parseJsonObject(ad.analysis.rubricScoresJson);

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
          <strong>Format:</strong> {ad.adFormat}
        </p>
        <p>
          <strong>Product:</strong> {ad.productOrService ?? 'No product name available'}
        </p>
        <p>
          <strong>Score:</strong> {ad.score.toFixed(2)} / 10
        </p>
        <p>
          <strong>Funnel stage:</strong> {ad.analysis.funnelStage ?? 'N/A'}
        </p>
        <p>
          <strong>RACE stage:</strong> {ad.analysis.raceStage ?? 'N/A'}
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
        <h2>Analysis</h2>
        <p>{ad.analysis.creativeAnalysis}</p>
        <p>{ad.analysis.copyAnalysis}</p>
        <p>{ad.analysis.headlineAnalysis}</p>
        <p>{ad.analysis.descriptionAnalysis}</p>
      </div>

      <div className="card">
        <h2>Sub-scores</h2>
        <ul>
          {Object.entries(rubric).map(([name, value]) => (
            <li key={name}>
              {name}: {Number(value).toFixed(2)}
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2>Strengths</h2>
        {strengths.length === 0 ? (
          <p>No strengths available.</p>
        ) : (
          <ul>
            {strengths.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>Weaknesses</h2>
        {weaknesses.length === 0 ? (
          <p>No weaknesses available.</p>
        ) : (
          <ul>
            {weaknesses.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h2>Improvements</h2>
        {improvements.length === 0 ? (
          <p>No improvements available.</p>
        ) : (
          <ul>
            {improvements.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
