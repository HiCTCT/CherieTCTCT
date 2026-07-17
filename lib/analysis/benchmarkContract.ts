/**
 * Competitor-benchmark CONTRACT — PURE, immutable tables only.
 *
 * The enums and relationships the benchmark scorer guarantees, extracted so that a
 * validator can check them WITHOUT importing or executing scoring code. There is no
 * logic here: `competitorScoring.ts` consumes these exact tables (so the scorer and the
 * validator can never drift), and the bundle validator consumes them too — which is why
 * bundle-backed ingestion still has no runtime route to the scorer.
 *
 * Imports nothing. Changing a value here changes the scorer's output, so treat it as
 * part of the scoring contract, not as validator configuration.
 */

export type BenchmarkTierTokenValue = 'STRONG' | 'MODERATE' | 'WEAK' | 'LOW';
export type BenchmarkTierLabel =
  | 'Strong competitor signal'
  | 'Moderate competitor signal'
  | 'Weak competitor signal'
  | 'Low competitor signal';
export type BenchmarkConfidenceValue = 'HIGH' | 'MEDIUM' | 'LOW';
export type EvidenceTokenValue = 'VISION' | 'MANUAL' | 'NONE';
export type CreativeSourceValue = 'ASSET' | 'MANUAL' | 'FALLBACK';

export const BENCHMARK_TIER_TOKENS: readonly BenchmarkTierTokenValue[] = ['STRONG', 'MODERATE', 'WEAK', 'LOW'];
export const BENCHMARK_CONFIDENCE_VALUES: readonly BenchmarkConfidenceValue[] = ['HIGH', 'MEDIUM', 'LOW'];
export const EVIDENCE_TOKEN_VALUES: readonly EvidenceTokenValue[] = ['VISION', 'MANUAL', 'NONE'];
export const CREATIVE_SOURCE_VALUES: readonly CreativeSourceValue[] = ['ASSET', 'MANUAL', 'FALLBACK'];

/** Canonical display label for a tier token. */
export const TIER_LABEL_BY_TOKEN: Record<BenchmarkTierTokenValue, BenchmarkTierLabel> = {
  STRONG: 'Strong competitor signal',
  MODERATE: 'Moderate competitor signal',
  WEAK: 'Weak competitor signal',
  LOW: 'Low competitor signal',
};

/** Evidence token is a pure function of the creative source. */
export const EVIDENCE_TOKEN_BY_SOURCE: Record<CreativeSourceValue, EvidenceTokenValue> = {
  ASSET: 'VISION',
  MANUAL: 'MANUAL',
  FALLBACK: 'NONE',
};

/** Evidence display sentence is a pure function of the creative source. */
export const EVIDENCE_LABEL_BY_SOURCE: Record<CreativeSourceValue, string> = {
  ASSET: 'Vision creative analysis (creative seen by Claude Vision)',
  MANUAL: 'Stored manual analysis (creative NOT analysed by Vision)',
  FALLBACK: 'No creative evidence (no asset, no manual text)',
};

/**
 * Benchmark confidence is a pure function of the creative source — it describes the
 * EVIDENCE, not visual certainty. (Visual confidence is a separate, VIDEO-only concept.)
 */
export const BENCHMARK_CONFIDENCE_BY_SOURCE: Record<CreativeSourceValue, BenchmarkConfidenceValue> = {
  ASSET: 'HIGH',
  MANUAL: 'MEDIUM',
  FALLBACK: 'LOW',
};

/** ASSET carries no warning; the other two always do. */
export const BENCHMARK_WARNS_BY_SOURCE: Record<CreativeSourceValue, boolean> = {
  ASSET: false,
  MANUAL: true,
  FALLBACK: true,
};

/** The scorer emits exactly this many breakdown entries, in every branch. */
export const BENCHMARK_BREAKDOWN_ENTRIES = 3;

/** Weights per creative source, in the exact order the scorer emits them. */
export const BENCHMARK_WEIGHTS_BY_SOURCE: Record<CreativeSourceValue, readonly number[]> = {
  ASSET: [0.70, 0.20, 0.10],
  MANUAL: [0.50, 0.30, 0.20],
  FALLBACK: [0.50, 0.30, 0.20],
};

/** `improvements` is always [recommendations.copy, .headline, .creative]. */
export const ANALYSIS_IMPROVEMENT_ENTRIES = 3;

/** Breakdown labels per creative source, in the exact order the scorer emits them. */
export const BENCHMARK_BREAKDOWN_LABELS_BY_SOURCE: Record<CreativeSourceValue, readonly string[]> = {
  ASSET: ['AIDA avg', 'creative', 'action'],
  MANUAL: ['creative (manual)', 'copy/message', 'CTA/offer'],
  FALLBACK: ['creative (none)', 'copy/message', 'CTA/offer'],
};

/** The exact formula sentence the scorer emits per creative source. */
export const BENCHMARK_FORMULA_BY_SOURCE: Record<CreativeSourceValue, string> = {
  ASSET: 'AIDA avg ×0.70 + creative ×0.20 + action/offer ×0.10',
  MANUAL: 'manual creative ×0.50 + copy/message ×0.30 + CTA/offer ×0.20',
  FALLBACK: 'machine baseline only (no asset / no manual text)',
};

/** The exact warning the scorer emits per creative source. null = no warning. */
export const BENCHMARK_WARNING_BY_SOURCE: Record<CreativeSourceValue, string | null> = {
  ASSET: null,
  MANUAL: 'MEDIUM confidence — the creative was not analysed by Vision; score is based on operator-entered text.',
  FALLBACK: 'LOW confidence — no creative was captured or described. Treat this score as unreliable.',
};

/** Tier thresholds, highest first. A score >= `min` earns `token`. */
export const BENCHMARK_TIER_THRESHOLDS: ReadonlyArray<{ min: number; token: BenchmarkTierTokenValue }> = [
  { min: 8.0, token: 'STRONG' },
  { min: 6.5, token: 'MODERATE' },
  { min: 5.0, token: 'WEAK' },
  { min: -Infinity, token: 'LOW' },
];

// ─── Pure derivations ─────────────────────────────────────────────────────────
//
// The scorer produces with these; the bundle validator verifies with these. One
// implementation, so a produced benchmark and a validated benchmark cannot disagree.

/** The scorer's exact clamp + 2dp rounding rule. */
export function roundBenchmarkScore(value: number): number {
  return Number(Math.max(0, Math.min(10, value)).toFixed(2));
}

/** Canonical tier token for a score. */
export function deriveTierToken(score: number): BenchmarkTierTokenValue {
  for (const { min, token } of BENCHMARK_TIER_THRESHOLDS) if (score >= min) return token;
  return 'LOW';
}

export function deriveTierLabel(token: BenchmarkTierTokenValue): BenchmarkTierLabel {
  return TIER_LABEL_BY_TOKEN[token];
}

export function deriveEvidenceForCreativeSource(source: CreativeSourceValue): {
  token: EvidenceTokenValue; label: string; confidence: BenchmarkConfidenceValue; warning: string | null;
} {
  return {
    token: EVIDENCE_TOKEN_BY_SOURCE[source],
    label: EVIDENCE_LABEL_BY_SOURCE[source],
    confidence: BENCHMARK_CONFIDENCE_BY_SOURCE[source],
    warning: BENCHMARK_WARNING_BY_SOURCE[source],
  };
}

/** The analysis values the benchmark is computed from. */
export type BenchmarkInputs = {
  aidaScores: { attention: number; interest: number; desire: number; action: number };
  creativeScore: number;
  copyScore: number;
};

export type BenchmarkBreakdownEntry = { label: string; value: number; weight: number };

/**
 * The exact breakdown the scorer builds for these inputs — label, authoritative value
 * and weight, in order. Every value traces to an analysis field:
 *   AIDA avg  → rounded mean of the four AIDA scores
 *   creative  → creativeScore
 *   copy      → copyScore
 *   action    → aidaScores.action (the CTA/offer proxy)
 */
export function deriveBenchmarkBreakdown(inputs: BenchmarkInputs, source: CreativeSourceValue): BenchmarkBreakdownEntry[] {
  const a = inputs.aidaScores;
  const aidaAvg = roundBenchmarkScore((a.attention + a.interest + a.desire + a.action) / 4);
  const labels = BENCHMARK_BREAKDOWN_LABELS_BY_SOURCE[source];
  const weights = BENCHMARK_WEIGHTS_BY_SOURCE[source];
  const values = source === 'ASSET'
    ? [aidaAvg, inputs.creativeScore, a.action]
    : [inputs.creativeScore, inputs.copyScore, a.action];
  return labels.map((label, i) => ({ label, value: values[i]!, weight: weights[i]! }));
}

/** Weighted sum of the breakdown, under the scorer's rounding rule. */
export function computeBenchmarkScoreFromBreakdown(breakdown: readonly BenchmarkBreakdownEntry[]): number {
  return roundBenchmarkScore(breakdown.reduce((sum, b) => sum + b.value * b.weight, 0));
}

/** Analyst guidance for a tier + confidence pair. Exact scorer strings. */
export function deriveRecommendedUse(tierToken: BenchmarkTierTokenValue, confidence: BenchmarkConfidenceValue): string {
  if (confidence === 'LOW') return 'Reference only — low confidence (no creative seen)';
  const base =
    tierToken === 'STRONG' ? 'Model / reverse-engineer — strong signal' :
    tierToken === 'MODERATE' ? 'Study — worth analysing' :
    tierToken === 'WEAK' ? 'Reference only — weak signal' :
    'Archive — low signal';
  return confidence === 'MEDIUM' ? `${base} (verify — manual text only)` : base;
}
