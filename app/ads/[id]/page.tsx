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

      {/* ── 1. Top Summary Card ── */}
      <div className="card">
        <div className="summary-header">
          <div className="summary-score-block">
            <div className="summary-score">{ad.score.toFixed(1)}</div>
            <div className="summary-score-label">/ 10 overall</div>
            <span className={`badge ${ad.qualified ? 'badge-qualified' : 'badge-unqualified'}`}>
              {ad.qualified ? 'Qualified' : 'Not qualified'}
            </span>
          </div>
          <div className="summary-verdict">
            <div className="summary-verdict-heading">Final Verdict</div>
            <div className="summary-verdict-value">
              {a?.finalVerdict
                ? VERDICT_LABELS[a.finalVerdict] ?? a.finalVerdict
                : 'Not yet assessed'}
            </div>
          </div>
        </div>
        <div className="tag-row">
          <span className="tag"><strong>Format:</strong> {ad.adFormat}</span>
          {a?.funnelStage && (
            <span className="tag"><strong>Funnel:</strong> {a.funnelStage}</span>
          )}
          {a?.raceStage && (
            <span className="tag"><strong>RACE:</strong> {a.raceStage}</span>
          )}
          {a?.trustFunnelStage && (
            <span className="tag">
              <strong>Trust Funnel:</strong> {a.trustFunnelStage.replace(/_/g, ' ')}
            </span>
          )}
        </div>
      </div>

      {/* ── 2. Ad Details ── */}
      <div className="card">
        <h2>Ad Details</h2>
        <p><strong>Industry:</strong> {ad.industry.name}</p>
        <p><strong>Client:</strong> {ad.client.name}</p>
        <p><strong>Competitor:</strong> {ad.competitor.name}</p>
        {ad.productOrService && (
          <p><strong>Product / Service:</strong> {ad.productOrService}</p>
        )}
        <p>
          <strong>Ad Link:</strong>{' '}
          <a href={ad.adLink} target="_blank" rel="noreferrer">Open in Meta Ad Library ↗</a>
        </p>
        {ad.activeSince && (
          <p>
            <strong>Active Since:</strong>{' '}
            {new Date(ad.activeSince).toLocaleDateString('en-GB')}
          </p>
        )}
      </div>

      {/* ── 3. Original Ad Content ── */}
      {(ad.primaryCopy || ad.headline || ad.description) && (
        <div className="card">
          <h2>Original Ad Content</h2>
          {ad.primaryCopy && (
            <>
              <p className="section-label">Copy</p>
              <div className="copy-block">{ad.primaryCopy}</div>
            </>
          )}
          {ad.headline && (
            <>
              <p className="section-label">Headline</p>
              <div className="copy-block">{ad.headline}</div>
            </>
          )}
          {ad.description && (
            <>
              <p className="section-label">Description</p>
              <div className="copy-block">{ad.description}</div>
            </>
          )}
        </div>
      )}

      {/* ── 4. Score Grid ── */}
      <div className="card">
        <h2>Score Breakdown</h2>
        <div className="score-grid">
          <div className="score-cell">
            <div className="score-label">Copy</div>
            <div className="score-value">
              {fmt(copyScore)}<span className="score-denom"> /10</span>
            </div>
          </div>
          <div className="score-cell">
            <div className="score-label">Headline</div>
            <div className="score-value">
              {ad.headline ? fmt(headlineScore) : '—'}<span className="score-denom">{ad.headline ? ' /10' : ''}</span>
            </div>
          </div>
          <div className="score-cell">
            <div className="score-label">Description</div>
            <div className="score-value">
              {ad.description ? fmt(descriptionScore) : '—'}<span className="score-denom">{ad.description ? ' /10' : ''}</span>
            </div>
          </div>
          <div className="score-cell">
            <div className="score-label">Creative</div>
            <div className="score-value">
              {fmt(creativeScore)}<span className="score-denom"> /10</span>
            </div>
          </div>
          <div className="score-cell">
            <div className="score-label">Clarity</div>
            <div className="score-value">
              {fmt(clarityScore)}<span className="score-denom"> /10</span>
            </div>
          </div>
          <div className="score-cell">
            <div className="score-label">Connection</div>
            <div className="score-value">
              {fmt(connectionScore)}<span className="score-denom"> /10</span>
            </div>
          </div>
          <div className="score-cell">
            <div className="score-label">Conviction</div>
            <div className="score-value">
              {fmt(convictionScore)}<span className="score-denom"> /10</span>
            </div>
          </div>
          <div className="score-cell">
            <div className="score-label">AIDA Avg</div>
            <div className="score-value">
              {aidaAvg !== null ? aidaAvg.toFixed(1) : 'N/A'}<span className="score-denom">{aidaAvg !== null ? ' /10' : ''}</span>
            </div>
          </div>
        </div>
        {combined !== null && (
          <p style={{ marginTop: '12px', fontSize: '13px', color: '#64748b' }}>
            <strong>Clarity + Connection + Conviction:</strong> {combined.toFixed(1)} / 30
            {' — '}
            {combined >= 21
              ? 'Strong across all three dimensions.'
              : combined >= 15
                ? 'Moderate — at least one dimension is limiting conversion.'
                : 'Weak across one or more dimensions. Significant room to improve.'}
          </p>
        )}
      </div>

      {/* ── 5. AIDA Breakdown ── */}
      <div className="card">
        <h2>AIDA Breakdown</h2>
        <div className="score-grid">
          <div className="score-cell">
            <div className="score-label">Attention</div>
            <div className="score-value">
              {fmt(a?.aidaAttentionScore)}<span className="score-denom"> /10</span>
            </div>
            {aidaText?.attention && (
              <div className="score-note">{aidaText.attention}</div>
            )}
          </div>
          <div className="score-cell">
            <div className="score-label">Interest</div>
            <div className="score-value">
              {fmt(a?.aidaInterestScore)}<span className="score-denom"> /10</span>
            </div>
            {aidaText?.interest && (
              <div className="score-note">{aidaText.interest}</div>
            )}
          </div>
          <div className="score-cell">
            <div className="score-label">Desire</div>
            <div className="score-value">
              {fmt(a?.aidaDesireScore)}<span className="score-denom"> /10</span>
            </div>
            {aidaText?.desire && (
              <div className="score-note">{aidaText.desire}</div>
            )}
          </div>
          <div className="score-cell">
            <div className="score-label">Action</div>
            <div className="score-value">
              {fmt(a?.aidaActionScore)}<span className="score-denom"> /10</span>
            </div>
            {aidaText?.action && (
              <div className="score-note">{aidaText.action}</div>
            )}
          </div>
        </div>
      </div>

      {/* ── 6. Behavioural Triggers ── */}
      <div className="card">
        <h2>Behavioural Triggers</h2>
        {triggers.filter((t) => t.strength !== 'MISSING').length > 0 ? (
          <div className="trigger-list">
            {triggers
              .filter((t) => t.strength !== 'MISSING')
              .map((t, i) => (
                <span
                  key={i}
                  className={`trigger-badge trigger-${t.strength.toLowerCase()}`}
                >
                  {t.name} — {t.strength.charAt(0) + t.strength.slice(1).toLowerCase()}
                </span>
              ))}
          </div>
        ) : (
          <p className="muted">None detected</p>
        )}
        {triggers.filter((t) => t.strength === 'MISSING').length > 0 && (
          <div className="analysis-subsection">
            <p className="section-label">Not present</p>
            <ul className="compact-list">
              {triggers
                .filter((t) => t.strength === 'MISSING')
                .map((t, i) => <li key={i}>{t.name}</li>)}
            </ul>
          </div>
        )}
      </div>

      {/* ── 7. Copy Analysis ── */}
      <div className="card">
        <h2>Copy Analysis</h2>
        <div className="analysis-text">{a?.copyAnalysis ?? 'No copy analysis available.'}</div>
        {strengths.length > 0 && (
          <div className="analysis-subsection">
            <p className="section-label">What is working</p>
            <ul className="compact-list">
              {strengths.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </div>
        )}
        {weaknesses.length > 0 && (
          <div className="analysis-subsection">
            <p className="section-label">What is missing</p>
            <ul className="compact-list">
              {weaknesses.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}
      </div>

      {/* ── 8. Headline Analysis ── */}
      {ad.headline && (
        <div className="card">
          <h2>Headline Analysis</h2>
          <div className="analysis-text">
            {a?.headlineAnalysis ?? 'No headline analysis available.'}
          </div>
        </div>
      )}

      {/* ── 9. Description Analysis ── */}
      {ad.description && (
        <div className="card">
          <h2>Description Analysis</h2>
          <div className="analysis-text">
            {a?.descriptionAnalysis ?? 'No description analysis available.'}
          </div>
        </div>
      )}

      {/* ── 10. Creative Analysis ── */}
      <div className="card">
        <h2>Creative Analysis</h2>
        <div className="analysis-text">
          {a?.creativeAnalysis ?? 'No creative analysis available.'}
        </div>
      </div>

      {/* ── 11. Funnel and Framework Mapping ── */}
      <div className="card">
        <h2>Funnel &amp; Framework Mapping</h2>
        {a?.funnelStage && (
          <p>
            <strong>Funnel Stage:</strong> {a.funnelStage}
            {a.funnelStage === 'TOFU' && ' — Awareness stage. Reaching cold audiences who may not yet know the brand.'}
            {a.funnelStage === 'MOFU' && ' — Consideration stage. Targeting audiences comparing options or exploring solutions.'}
            {a.funnelStage === 'BOFU' && ' — Conversion stage. Pushing warm audiences toward a direct action.'}
          </p>
        )}
        {a?.raceStage && (
          <p>
            <strong>RACE Stage:</strong> {a.raceStage}
            {a.raceStage === 'REACH' && ' — Building awareness with new audiences.'}
            {a.raceStage === 'ACT' && ' — Encouraging interaction and consideration.'}
            {a.raceStage === 'CONVERT' && ' — Driving direct conversion actions.'}
            {a.raceStage === 'ENGAGE' && ' — Retaining and re-engaging existing audiences.'}
          </p>
        )}
        {a?.trustFunnelStage && (
          <p>
            <strong>Trust Funnel Stage:</strong>{' '}
            {TRUST_FUNNEL_LABELS[a.trustFunnelStage] ?? a.trustFunnelStage}
          </p>
        )}
      </div>

      {/* ── 12. Recommendations ── */}
      <div className="card">
        <h2>Recommendations for Improvement</h2>
        {recommendations ? (
          <div className="rec-list">
            {recommendations.copy && (
              <div className="rec-item">
                <span className="rec-label">Copy</span>
                <p>{recommendations.copy}</p>
              </div>
            )}
            {recommendations.headline && (
              <div className="rec-item">
                <span className="rec-label">Headline</span>
                <p>{recommendations.headline}</p>
              </div>
            )}
            {recommendations.description && (
              <div className="rec-item">
                <span className="rec-label">Description</span>
                <p>{recommendations.description}</p>
              </div>
            )}
            {recommendations.creative && (
              <div className="rec-item">
                <span className="rec-label">Creative</span>
                <p>{recommendations.creative}</p>
              </div>
            )}
            {recommendations.conversionStrength && (
              <div className="rec-item">
                <span className="rec-label">Conversion Strength</span>
                <p>{recommendations.conversionStrength}</p>
              </div>
            )}
          </div>
        ) : (
          <p className="muted">Recommendations not yet available.</p>
        )}
      </div>

      {/* ── 13. Rewrite Direction (only shown if any score below 7) ── */}
      {rewriteDirection && (
        <div className="card">
          <h2>Rewrite Direction</h2>
          <div className="rec-list">
            <div className="rec-item">
              <span className="rec-label">Hook</span>
              <p>{rewriteDirection.hook}</p>
            </div>
            <div className="rec-item">
              <span className="rec-label">Body Copy</span>
              <p>{rewriteDirection.body}</p>
            </div>
            <div className="rec-item">
              <span className="rec-label">CTA</span>
              <p>{rewriteDirection.cta}</p>
            </div>
            <div className="rec-item">
              <span className="rec-label">Creative Direction</span>
              <p>{rewriteDirection.creativeDirection}</p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
