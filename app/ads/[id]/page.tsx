import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAdById } from '@/lib/queries/ads';

// ------------------------------------------------------------------ helpers

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function fmt(score: number | null | undefined): string {
  if (score === null || score === undefined) return 'N/A';
  return score.toFixed(1);
}

const TRIGGER_ORDER: Record<string, number> = {
  STRONG: 0,
  MODERATE: 1,
  WEAK: 2,
  MISSING: 3,
};

function triggerBadge(strength: string): string {
  if (strength === 'STRONG') return '● Strong';
  if (strength === 'MODERATE') return '◑ Moderate';
  if (strength === 'WEAK') return '○ Weak';
  return '— Missing';
}

const VERDICT_LABELS: Record<string, string> = {
  STRONG_READY_TO_TEST: '✅ Strong — ready to test',
  GOOD_NEEDS_SHARPENING: '🟡 Good concept — needs sharpening',
  CLEAR_IDEA_WEAK_SIGNALS: '🟠 Clear idea — weak conversion signals',
  TOO_VAGUE_MAJOR_REWORK: '🔴 Too vague — needs major rework',
  INSUFFICIENT_INFORMATION: '⚪ Insufficient information to judge fully',
};

const TRUST_FUNNEL_LABELS: Record<string, string> = {
  UNAWARE: 'Unaware — audience does not yet know they have a problem',
  PROBLEM_AWARE: 'Problem Aware — audience knows the problem, not the solution',
  SOLUTION_AWARE: 'Solution Aware — audience knows solutions exist, comparing options',
  PRODUCT_AWARE: 'Product Aware — audience knows this product, needs a reason to act',
  READY_TO_BUY: 'Ready to Buy — audience needs a nudge, not more information',
};

// ------------------------------------------------------------------ types
type Trigger = { name: string; strength: string };
type AidaExplanations = { attention: string; interest: string; desire: string; action: string };
type Recommendations = {
  copy: string;
  headline: string;
  description: string;
  creative: string;
  conversionStrength: string;
};
type RewriteDirection = { hook: string; body: string; cta: string; creativeDirection: string };

// ------------------------------------------------------------------ page

export default async function AdDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const ad = await getAdById(params.id);

  if (!ad || !ad.qualified) {
    notFound();
  }

  const a = ad.analysis;

  const recommendations = parseJson<Recommendations>(a?.recommendationsJson ?? null);
  const rewriteDirection = parseJson<RewriteDirection>(a?.rewriteDirectionJson ?? null);
  const triggers = (parseJson<Trigger[]>(a?.behaviouralTriggersJson ?? null) ?? [])
    .sort((x, y) => (TRIGGER_ORDER[x.strength] ?? 4) - (TRIGGER_ORDER[y.strength] ?? 4));

  const strengths = parseJson<string[]>(a?.strengthsJson ?? null) ?? [];
  const weaknesses = parseJson<string[]>(a?.weaknessesJson ?? null) ?? [];

  const copyScore = a?.copyScore ?? null;
  const headlineScore = a?.headlineScore ?? null;
  const descriptionScore = a?.descriptionScore ?? null;
  const creativeScore = a?.creativeScore ?? null;
  const clarityScore = a?.clarityScore ?? null;
  const connectionScore = a?.connectionScore ?? null;
  const convictionScore = a?.convictionScore ?? null;
  const combined =
    clarityScore !== null && connectionScore !== null && convictionScore !== null
      ? clarityScore + connectionScore + convictionScore
      : null;

  const aidaAvg =
    a?.aidaAttentionScore != null &&
    a?.aidaInterestScore != null &&
    a?.aidaDesireScore != null &&
    a?.aidaActionScore != null
      ? (a.aidaAttentionScore + a.aidaInterestScore + a.aidaDesireScore + a.aidaActionScore) / 4
      : null;

  // AIDA explanations stored in aidaJson (backwards compatible)
  const aidaText = parseJson<AidaExplanations>(a?.aidaJson ?? null);

  return (
    <section>
      <p>
        <Link href="/">← Back to dashboard</Link>
        {' | '}
        <Link href="/industries">Industries</Link>
        {' | '}
        <Link href="/competitors">Competitors</Link>
      </p>

      {/* ── Overview ── */}
      <div className="card">
        <h1>Ad detail</h1>
        <p><strong>Industry:</strong> {ad.industry.name}</p>
        <p><strong>Client:</strong> {ad.client.name}</p>
        <p><strong>Competitor:</strong> {ad.competitor.name}</p>
        <p><strong>Product / service:</strong> {ad.productOrService ?? 'Not specified'}</p>
        <p><strong>Format:</strong> {ad.adFormat}</p>
        <p><strong>Overall conversion score:</strong> {ad.score.toFixed(1)} / 10</p>
        <p>
          <strong>Facebook ad link:</strong>{' '}
          <a href={ad.adLink} target="_blank" rel="noreferrer">Open ad</a>
        </p>
      </div>

      {/* ── 1. Copy ── */}
      <div className="card">
        <h2>1. Copy</h2>
        <p>
          <strong>
            {copyScore !== null
              ? `Copy Score: ${copyScore.toFixed(1)} / 10`
              : 'Copy Score: not yet scored'}
          </strong>
        </p>
        {ad.primaryCopy && <p><em>&ldquo;{ad.primaryCopy}&rdquo;</em></p>}
        <p>{a?.copyAnalysis ?? 'No copy analysis available.'}</p>
        {strengths.length > 0 && (
          <>
            <p><strong>What is working:</strong></p>
            <ul>{strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
          </>
        )}
        {weaknesses.length > 0 && (
          <>
            <p><strong>What is missing:</strong></p>
            <ul>{weaknesses.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </>
        )}
      </div>

      {/* ── 2. Headline ── */}
      <div className="card">
        <h2>2. Headline</h2>
        {ad.headline ? (
          <>
            <p>
              <strong>
                {headlineScore !== null
                  ? `Headline Score: ${headlineScore.toFixed(1)} / 10`
                  : 'Headline Score: not yet scored'}
              </strong>
            </p>
            <p><em>&ldquo;{ad.headline}&rdquo;</em></p>
            <p>{a?.headlineAnalysis ?? 'No headline analysis available.'}</p>
          </>
        ) : (
          <p>Headline not provided. No score assigned.</p>
        )}
      </div>

      {/* ── 3. Description ── */}
      <div className="card">
        <h2>3. Description</h2>
        {ad.description ? (
          <>
            <p>
              <strong>
                {descriptionScore !== null
                  ? `Description Score: ${descriptionScore.toFixed(1)} / 10`
                  : 'Description Score: not yet scored'}
              </strong>
            </p>
            <p><em>&ldquo;{ad.description}&rdquo;</em></p>
            <p>{a?.descriptionAnalysis ?? 'No description analysis available.'}</p>
          </>
        ) : (
          <p>Description not provided. No score assigned.</p>
        )}
      </div>

      {/* ── 4. Creative ── */}
      <div className="card">
        <h2>4. Creative</h2>
        <p>
          <strong>
            {creativeScore !== null
              ? `Creative Score: ${creativeScore.toFixed(1)} / 10`
              : 'Creative Score: not yet scored'}
          </strong>
        </p>
        <p>{a?.creativeAnalysis ?? 'No creative analysis available.'}</p>
      </div>

      {/* ── 5. AIDA Breakdown ── */}
      <div className="card">
        <h2>5. AIDA Breakdown</h2>
        <p>
          <strong>Attention:</strong> {fmt(a?.aidaAttentionScore)} / 10
          {aidaText?.attention ? ` — ${aidaText.attention}` : ''}
        </p>
        <p>
          <strong>Interest:</strong> {fmt(a?.aidaInterestScore)} / 10
          {aidaText?.interest ? ` — ${aidaText.interest}` : ''}
        </p>
        <p>
          <strong>Desire:</strong> {fmt(a?.aidaDesireScore)} / 10
          {aidaText?.desire ? ` — ${aidaText.desire}` : ''}
        </p>
        <p>
          <strong>Action:</strong> {fmt(a?.aidaActionScore)} / 10
          {aidaText?.action ? ` — ${aidaText.action}` : ''}
        </p>
      </div>

      {/* ── 6. Clarity, Connection, Conviction ── */}
      <div className="card">
        <h2>6. Clarity, Connection, Conviction</h2>
        <p><strong>Clarity Score:</strong> {fmt(clarityScore)} / 10</p>
        <p><strong>Connection Score:</strong> {fmt(connectionScore)} / 10</p>
        <p><strong>Conviction Score:</strong> {fmt(convictionScore)} / 10</p>
        <p>
          <strong>Combined Score:</strong>{' '}
          {combined !== null ? `${combined.toFixed(1)} / 30` : 'Not scored'}
        </p>
        <p>
          {combined !== null
            ? combined >= 21
              ? 'Strong across all three dimensions. Ad shows clear conversion readiness.'
              : combined >= 15
                ? 'Moderate overall. At least one dimension is limiting conversion effectiveness.'
                : 'Weak across one or more dimensions. Significant room to improve before testing.'
            : 'Scores not yet available.'}
        </p>
      </div>

      {/* ── 7. Funnel and Framework Mapping ── */}
      <div className="card">
        <h2>7. Funnel and Framework Mapping</h2>
        {a?.funnelStage && (
          <p>
            <strong>Funnel stage:</strong> {a.funnelStage}
            {a.funnelStage === 'TOFU' && ' — Awareness stage. Reaching cold audiences who may not yet know the brand.'}
            {a.funnelStage === 'MOFU' && ' — Consideration stage. Targeting audiences comparing options or exploring solutions.'}
            {a.funnelStage === 'BOFU' && ' — Conversion stage. Pushing warm audiences toward a direct action.'}
          </p>
        )}
        {a?.raceStage && (
          <p>
            <strong>RACE stage:</strong> {a.raceStage}
            {a.raceStage === 'REACH' && ' — Building awareness with new audiences.'}
            {a.raceStage === 'ACT' && ' — Encouraging interaction and consideration.'}
            {a.raceStage === 'CONVERT' && ' — Driving direct conversion actions.'}
            {a.raceStage === 'ENGAGE' && ' — Retaining and re-engaging existing audiences.'}
          </p>
        )}
        {a?.trustFunnelStage && (
          <p>
            <strong>Trust Funnel stage:</strong>{' '}
            {TRUST_FUNNEL_LABELS[a.trustFunnelStage] ?? a.trustFunnelStage}
          </p>
        )}
      </div>

      {/* ── 8. Behavioural Trigger Analysis ── */}
      <div className="card">
        <h2>8. Behavioural Trigger Analysis</h2>
        {triggers.filter((t) => t.strength !== 'MISSING').length > 0 ? (
          <>
            <p><strong>Triggers detected:</strong></p>
            <ul>
              {triggers
                .filter((t) => t.strength !== 'MISSING')
                .map((t, i) => (
                  <li key={i}>
                    <strong>{t.name}:</strong> {triggerBadge(t.strength)}
                  </li>
                ))}
            </ul>
          </>
        ) : (
          <p>No behavioural triggers detected from available signals.</p>
        )}
        {triggers.filter((t) => t.strength === 'MISSING').length > 0 && (
          <>
            <p><strong>Triggers not present:</strong></p>
            <ul>
              {triggers
                .filter((t) => t.strength === 'MISSING')
                .map((t, i) => <li key={i}>{t.name}</li>)}
            </ul>
          </>
        )}
      </div>

      {/* ── 9. Recommendations for Improvement ── */}
      <div className="card">
        <h2>9. Recommendations for Improvement</h2>
        {recommendations ? (
          <>
            <p><strong>To improve copy to 10/10:</strong></p>
            <p>{recommendations.copy}</p>
            <p><strong>To improve headline to 10/10:</strong></p>
            <p>{recommendations.headline}</p>
            <p><strong>To improve description to 10/10:</strong></p>
            <p>{recommendations.description}</p>
            <p><strong>To improve creative to 10/10:</strong></p>
            <p>{recommendations.creative}</p>
            <p><strong>To improve conversion strength to 10/10:</strong></p>
            <p>{recommendations.conversionStrength}</p>
          </>
        ) : (
          <p>Recommendations not yet available. Re-run seed to populate.</p>
        )}
      </div>

      {/* ── 10. Rewrite Direction (only shown if any score < 7) ── */}
      {rewriteDirection && (
        <div className="card">
          <h2>10. Rewrite Direction</h2>
          <p><strong>Hook:</strong> {rewriteDirection.hook}</p>
          <p><strong>Body copy direction:</strong> {rewriteDirection.body}</p>
          <p><strong>CTA:</strong> {rewriteDirection.cta}</p>
          <p><strong>Creative direction:</strong> {rewriteDirection.creativeDirection}</p>
        </div>
      )}

      {/* ── 11. Final Scoring Summary ── */}
      <div className="card">
        <h2>11. Final Scoring Summary</h2>
        <p>
          <strong>Copy Score:</strong>{' '}
          {copyScore !== null ? `${copyScore.toFixed(1)} / 10` : 'Not scored'}
        </p>
        <p>
          <strong>Headline Score:</strong>{' '}
          {ad.headline
            ? headlineScore !== null
              ? `${headlineScore.toFixed(1)} / 10`
              : 'Not scored'
            : 'Not provided'}
        </p>
        <p>
          <strong>Description Score:</strong>{' '}
          {ad.description
            ? descriptionScore !== null
              ? `${descriptionScore.toFixed(1)} / 10`
              : 'Not scored'
            : 'Not provided'}
        </p>
        <p>
          <strong>Creative Score:</strong>{' '}
          {creativeScore !== null ? `${creativeScore.toFixed(1)} / 10` : 'Not scored'}
        </p>
        <p>
          <strong>AIDA Average:</strong>{' '}
          {aidaAvg !== null ? `${aidaAvg.toFixed(1)} / 10` : 'Not scored'}
        </p>
        <p>
          <strong>Clarity + Connection + Conviction:</strong>{' '}
          {combined !== null ? `${combined.toFixed(1)} / 30` : 'Not scored'}
        </p>
        <p>
          <strong>Overall Conversion Potential:</strong> {ad.score.toFixed(1)} / 10
        </p>
        <p>
          <strong>Final verdict:</strong>{' '}
          {a?.finalVerdict
            ? VERDICT_LABELS[a.finalVerdict] ?? a.finalVerdict
            : 'Not yet assessed'}
        </p>
      </div>
    </section>
  );
}
