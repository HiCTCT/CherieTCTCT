import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAdById } from '@/lib/queries/ads';

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const SUB_SCORE_LABELS: Record<string, string> = {
  hookStopScroll: 'Hook / stop-scroll',
  audienceRelevance: 'Audience relevance',
  valueClarity: 'Value clarity',
  trustProofStrength: 'Trust / proof strength',
  ctaClarity: 'CTA clarity',
  visualHierarchy: 'Visual hierarchy',
  productClarity: 'Product clarity',
  offerClarity: 'Offer clarity',
  headlineStrength: 'Headline strength',
  descriptionUsefulness: 'Description usefulness',
  ctaVisibility: 'CTA visibility',
  trustSignals: 'Trust signals',
  firstThreeSeconds: 'First three seconds',
  soundOffDesign: 'Sound-off design',
  soundOnEnhancement: 'Sound-on enhancement',
  onScreenText: 'On-screen text',
  storyFlow: 'Story flow',
  authenticity: 'Authenticity',
  platformNativeFeel: 'Platform-native feel',
};

const AIDA_LABELS: Record<string, string> = {
  attention: 'Attention',
  interest: 'Interest',
  desire: 'Desire',
  action: 'Action',
};

export default async function AdDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const ad = await getAdById(params.id);

  if (!ad || !ad.qualified) {
    notFound();
  }

  const improvements = parseJsonArray(ad.analysis?.improvementsJson);
  const strengths = parseJsonArray(ad.analysis?.strengthsJson);
  const weaknesses = parseJsonArray(ad.analysis?.weaknessesJson);
  const rubricScores = parseJsonObject(ad.analysis?.rubricScoresJson);
  const aidaMapping = parseJsonObject(ad.analysis?.aidaJson);

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
          <strong>Format:</strong> {ad.adFormat}
        </p>
        <p>
          <strong>Score:</strong> {ad.score.toFixed(1)} / 10
        </p>
        {ad.analysis?.funnelStage && (
          <p>
            <strong>Funnel stage:</strong> {ad.analysis.funnelStage}
          </p>
        )}
        {ad.analysis?.raceStage && (
          <p>
            <strong>RACE stage:</strong> {ad.analysis.raceStage}
          </p>
        )}
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

      {aidaMapping && (
        <div className="card">
          <h2>AIDA Framework</h2>
          {Object.entries(AIDA_LABELS).map(([key, label]) => {
            const value = aidaMapping[key];
            if (!value || typeof value !== 'string') return null;
            return (
              <p key={key}>
                <strong>{label}:</strong> {value}
              </p>
            );
          })}
        </div>
      )}

      {rubricScores && Object.keys(rubricScores).length > 0 && (
        <div className="card">
          <h2>Sub-scores</h2>
          {Object.entries(rubricScores).map(([key, value]) => {
            if (value === null || value === undefined) return null;
            const label = SUB_SCORE_LABELS[key] ?? key;
            return (
              <p key={key}>
                <strong>{label}:</strong> {typeof value === 'number' ? value.toFixed(1) : String(value)} / 10
              </p>
            );
          })}
        </div>
      )}

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

      <div className="card">
        <h2>Strengths</h2>
        {strengths.length === 0 ? (
          <p>No strengths available.</p>
        ) : (
          <ul>
            {strengths.map((item, index) => (
              <li key={index}>{item}</li>
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
            {weaknesses.map((item, index) => (
              <li key={index}>{item}</li>
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
            {improvements.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
