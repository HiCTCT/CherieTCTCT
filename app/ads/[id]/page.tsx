import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAdById } from '@/lib/queries/ads';
import {
  tierLabel,
  confidenceLabel,
  evidenceLabel,
  creativeSourceLabel,
} from '@/lib/analysis/competitorScoring';
import * as fs from 'fs';
import * as path from 'path';

const ASSET_ROOT = path.resolve('data', 'creative-assets');

/**
 * Pick a representative captured image from the stored evidence folder/path and
 * return a cwd-relative path for the /api/captured-asset route. Stays strictly
 * within data/creative-assets; returns null if nothing servable is found.
 */
function pickCapturedEvidence(assetPath: string | null | undefined): string | null {
  if (!assetPath) return null;
  try {
    const abs = path.resolve(assetPath);
    if (abs !== ASSET_ROOT && !abs.startsWith(ASSET_ROOT + path.sep)) return null;
    const stat = fs.statSync(abs);
    const dir = stat.isDirectory() ? abs : path.dirname(abs);
    const imgs = fs.readdirSync(dir).filter((f) => /\.(?:png|jpe?g|webp)$/i.test(f)).sort();
    if (imgs.length === 0) return null;
    let chosen = imgs[0]!;
    for (const pref of ['image-01', 'card-01', 'frame-01']) {
      const m = imgs.find((f) => f.toLowerCase().startsWith(pref));
      if (m) { chosen = m; break; }
    }
    return path.relative(process.cwd(), path.join(dir, chosen)).replace(/\\/g, '/');
  } catch {
    return null;
  }
}

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

// ------------------------------------------------------------------ rec helpers

/**
 * Parses a stored recommendation string into structured blocks.
 *
 * Each block may have:
 *   - an optional title  (short heading line, no trailing punctuation)
 *   - body paragraphs   (normal sentence text)
 *   - list items        (lines starting with quote/emoji/bullet/number)
 *   - script entries    (Hook: / Body: / Offer: / CTA: prefixed lines)
 *
 * No sentence-level splitting is performed — structure must exist in the
 * stored text (via newlines). Single paragraphs remain as paragraphs.
 */

// Matches "Hook (0-3s):", "Body:", "CTA:", etc.
const SCRIPT_RE = /^(Hook|Body|Offer|CTA|Opening|Closing)\s*(?:\([^)]*\))?\s*:\s*/i;
// Matches lines that are real list items: quotes, emoji, bullets, numbers
const LIST_RE = /^["✅•\-\*]|^\d+[.)]\s/;

function looksLikeTitle(line: string): boolean {
  if (SCRIPT_RE.test(line)) return false;  // script labels are content, not titles
  if (line.length > 80) return false;       // too long to be a heading
  if (/[.!?,]$/.test(line)) return false;  // sentence endings are not headings
  return true;
}

type RecGroup =
  | { type: 'body'; texts: string[] }
  | { type: 'list'; items: string[] }
  | { type: 'script'; entries: { label: string; text: string }[] };

type RecBlock = { title: string | null; groups: RecGroup[] };

function parseRecBlocks(text: string): RecBlock[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // No newlines — check for inline numbered patterns like "(1) Do X. (2) Do Y."
  if (!trimmed.includes('\n')) {
    if (/\(\d+\)/.test(trimmed)) {
      const parts = trimmed
        .split(/\s*(?=\(\d+\)\s)/)
        .map((s) => s.replace(/^\(\d+\)\s*/, '').trim())
        .filter(Boolean);
      if (parts.length > 1) {
        return parts.map((p) => ({
          title: null,
          groups: [{ type: 'body' as const, texts: [p] }],
        }));
      }
    }
    return [{ title: null, groups: [{ type: 'body' as const, texts: [trimmed] }] }];
  }

  // Split on blank lines into raw blocks, then parse each
  const rawBlocks = trimmed.split(/\n[ \t]*\n/);
  const result: RecBlock[] = [];

  for (const raw of rawBlocks) {
    const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) continue;

    let title: string | null = null;
    let bodyLines = lines;

    if (lines.length > 1 && looksLikeTitle(lines[0])) {
      title = lines[0];
      bodyLines = lines.slice(1);
    }

    // Classify each line, then group consecutive same-type lines
    const groups: RecGroup[] = [];
    for (const line of bodyLines) {
      const scriptMatch = line.match(SCRIPT_RE);
      if (scriptMatch) {
        const entry = { label: scriptMatch[1], text: line.slice(scriptMatch[0].length).trim() };
        const last = groups[groups.length - 1];
        if (last?.type === 'script') { last.entries.push(entry); }
        else { groups.push({ type: 'script', entries: [entry] }); }
        continue;
      }
      if (LIST_RE.test(line)) {
        const item = line.replace(/^["✅•\-\*]\s*/, '').replace(/^\d+[.)]\s+/, '').trim();
        const last = groups[groups.length - 1];
        if (last?.type === 'list') { last.items.push(item); }
        else { groups.push({ type: 'list', items: [item] }); }
        continue;
      }
      // Normal body line
      const last = groups[groups.length - 1];
      if (last?.type === 'body') { last.texts.push(line); }
      else { groups.push({ type: 'body', texts: [line] }); }
    }

    result.push({ title, groups });
  }

  return result.length ? result : [{ title: null, groups: [{ type: 'body', texts: [trimmed] }] }];
}

// ------------------------------------------------------------------ rec component

function RecText({ text }: { text: string }) {
  const blocks = parseRecBlocks(text);

  // Single unstructured block with no title — render as a plain paragraph
  if (
    blocks.length === 1 &&
    blocks[0].title === null &&
    blocks[0].groups.length === 1 &&
    blocks[0].groups[0].type === 'body'
  ) {
    return <p>{(blocks[0].groups[0] as { type: 'body'; texts: string[] }).texts.join(' ')}</p>;
  }

  return (
    <div className="rec-blocks">
      {blocks.map((block, bi) => (
        <div key={bi} className="rec-block">
          {block.title && <p className="rec-block-title">{block.title}</p>}
          {block.groups.map((group, gi) => {
            if (group.type === 'body') {
              return (
                <p key={gi} className="rec-block-body">
                  {group.texts.join(' ')}
                </p>
              );
            }
            if (group.type === 'list') {
              return (
                <ul key={gi} className="rec-bullets">
                  {group.items.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              );
            }
            // script
            return (
              <div key={gi} className="rec-script">
                {group.entries.map((entry, i) => (
                  <p key={i} className="rec-script-line">
                    <strong>{entry.label}:</strong>{' '}{entry.text}
                  </p>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

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

  if (!ad) {
    notFound();
  }

  const a = ad.analysis;

  // Phase G: archived-capture state + captured creative evidence
  const archived = ad.adStatus !== 'ACTIVE' || ad.inactiveDetectedAt != null;
  const evidenceRel = pickCapturedEvidence(ad.capturedAssetPath);

  const recommendations = parseJson<Recommendations>(a?.recommendationsJson ?? null);
  const rewriteDirection = parseJson<RewriteDirection>(a?.rewriteDirectionJson ?? null);
  const triggers = (parseJson<Trigger[]>(a?.behaviouralTriggersJson ?? null) ?? [])
    .sort((x, y) => (TRIGGER_ORDER[x.strength] ?? 4) - (TRIGGER_ORDER[y.strength] ?? 4));

  const strengths = parseJson<string[]>(a?.strengthsJson ?? null) ?? [];
  const weaknesses = parseJson<string[]>(a?.weaknessesJson ?? null) ?? [];

  // Competitor benchmark breakdown (stored as { formula, breakdown[] })
  type BenchmarkBreakdown = {
    formula: string;
    breakdown: { label: string; value: number; weight: number }[];
  };
  const benchmarkBreakdown = parseJson<BenchmarkBreakdown>(a?.benchmarkBreakdownJson ?? null);
  const hasBenchmark = ad.competitorBenchmarkScore != null;

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

      {/* ── Ad status / archived-capture banner ── */}
      {archived ? (
        <div className="card archived-banner">
          <h2 style={{ marginTop: 0 }}>📁 Archived capture</h2>
          <p>
            This ad is no longer shown as active in the Meta Ad Library. The analysis below is based
            on a captured snapshot. <strong>Live Meta link may no longer be available.</strong>
          </p>
          <p className="muted">
            Status: {ad.adStatus}
            {ad.inactiveDetectedAt && ` · detected inactive ${new Date(ad.inactiveDetectedAt).toLocaleDateString('en-GB')}`}
            {ad.lastSeenActiveAt && ` · last seen active ${new Date(ad.lastSeenActiveAt).toLocaleDateString('en-GB')}`}
          </p>
        </div>
      ) : (
        <p className="muted">
          Status: {ad.adStatus}
          {ad.lastSeenActiveAt && ` · last seen active ${new Date(ad.lastSeenActiveAt).toLocaleDateString('en-GB')}`}
        </p>
      )}

      {/* ── Competitor Benchmark panel (primary) ── */}
      {hasBenchmark ? (
        <div className="card">
          <h2>Competitor Benchmark</h2>
          <div className="summary-header">
            <div className="summary-score-block">
              <div className="summary-score">{(ad.competitorBenchmarkScore as number).toFixed(1)}</div>
              <div className="summary-score-label">/ 10 benchmark</div>
              <span className="badge">{tierLabel(ad.benchmarkTier)}</span>
            </div>
            <div className="summary-verdict">
              <div className="summary-verdict-heading">Confidence</div>
              <div className="summary-verdict-value">{confidenceLabel(ad.benchmarkConfidence)}</div>
            </div>
          </div>
          <div className="tag-row">
            <span className="tag"><strong>Evidence:</strong> {evidenceLabel(ad.evidenceSource)}</span>
            <span className="tag"><strong>Creative source:</strong> {creativeSourceLabel(ad.creativeSource)}</span>
            <span className="tag"><strong>Format:</strong> {ad.adFormat}</span>
            {ad.benchmarkScoredAt && (
              <span className="tag">
                <strong>Scored:</strong>{' '}
                {new Date(ad.benchmarkScoredAt).toLocaleDateString('en-GB')}
              </span>
            )}
          </div>
          {a?.recommendedUse && (
            <p style={{ marginTop: '12px' }}>
              <strong>Recommended use:</strong> {a.recommendedUse}
            </p>
          )}
          {benchmarkBreakdown && (
            <div className="analysis-subsection">
              <p className="section-label">How this benchmark is computed</p>
              <p>{benchmarkBreakdown.formula}</p>
              <ul className="compact-list">
                {benchmarkBreakdown.breakdown.map((b, i) => (
                  <li key={i}>
                    {b.label}: {b.value.toFixed(1)} × {b.weight}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="card">
          <h2>Competitor Benchmark</h2>
          <p className="muted">Not scored yet — this ad has no competitor benchmark score.</p>
        </div>
      )}

      {/* ── 1. Internal Ad QA Score (for comparison only) ── */}
      <div className="card">
        <h2>
          Internal Ad QA Score{' '}
          <span className="muted" style={{ fontWeight: 'normal', fontSize: '13px' }}>
            — for comparison only
          </span>
        </h2>
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
          {archived && (
            <span className="muted"> — live Meta link may no longer be available</span>
          )}
        </p>
        {ad.activeSince && (
          <p>
            <strong>Active Since:</strong>{' '}
            {new Date(ad.activeSince).toLocaleDateString('en-GB')}
          </p>
        )}
      </div>

      {/* ── Captured creative evidence ── */}
      {ad.capturedAssetPath && (
        <div className="card">
          <h2>Captured creative evidence</h2>
          <p className="muted">
            {ad.capturedAssetType ?? 'UNKNOWN'} · captured snapshot{archived ? ' (ad now archived)' : ''}
          </p>
          {evidenceRel ? (
            <img
              src={`/api/captured-asset?path=${encodeURIComponent(evidenceRel)}`}
              alt="Captured ad creative"
              style={{ maxWidth: '100%', height: 'auto', borderRadius: '8px', border: '1px solid #e2e8f0' }}
            />
          ) : (
            <p className="muted">
              Evidence reference on file: {ad.capturedAssetPath} (image not currently available locally)
            </p>
          )}
          <p className="muted" style={{ fontSize: '12px', marginTop: '8px' }}>
            Stored locally: {ad.capturedAssetPath}
          </p>
        </div>
      )}

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
                <RecText text={recommendations.copy} />
              </div>
            )}
            {recommendations.headline && (
              <div className="rec-item">
                <span className="rec-label">Headline</span>
                <RecText text={recommendations.headline} />
              </div>
            )}
            {recommendations.description && (
              <div className="rec-item">
                <span className="rec-label">Description</span>
                <RecText text={recommendations.description} />
              </div>
            )}
            {recommendations.creative && (
              <div className="rec-item">
                <span className="rec-label">Creative</span>
                <RecText text={recommendations.creative} />
              </div>
            )}
            {recommendations.conversionStrength && (
              <div className="rec-item">
                <span className="rec-label">Conversion Strength</span>
                <RecText text={recommendations.conversionStrength} />
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
