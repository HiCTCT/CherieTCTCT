/**
 * Competitor Benchmark Scoring (separate from internal QA scoring)
 *
 * The internal QA scorer in scoring.ts / staticAnalyser.ts / videoAnalyser.ts
 * grades OOM's OWN ads, which have full copy/headline/description. It is
 * copy-centric and uses a 7.0 pass/fail qualification gate.
 *
 * Competitor ads collected from the Meta Ad Library have little or no copy text —
 * we mainly capture the creative. This module provides a DIFFERENT lens for
 * competitor benchmarking: it leans on the evidence we actually have (Vision
 * creative analysis + AIDA), reports a confidence level, and ranks ads into tiers
 * instead of pass/fail.
 *
 * It also exposes CANONICAL TOKENS (STRONG/MODERATE/WEAK/LOW, HIGH/MEDIUM/LOW,
 * VISION/MANUAL/NONE) for DB storage/filtering, plus the shared recommendedUse
 * derivation so the preview scripts and ingestion all use one source of truth.
 *
 * IMPORTANT: this is a pure, read-only derivation from an existing AnalysisOutput.
 * It does NOT modify the QA scorer, ingestion, the DB, or Prisma.
 */

import { clampScore } from '@/lib/analysis/scoring';
import type { AnalysisOutput } from '@/lib/analysis/types';
import type { CreativeSource } from '@/lib/analysis/creativeAssetAnalyser';

export type BenchmarkConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type BenchmarkTierToken = 'STRONG' | 'MODERATE' | 'WEAK' | 'LOW';
export type EvidenceToken = 'VISION' | 'MANUAL' | 'NONE';

export type BenchmarkTier =
  | 'Strong competitor signal'
  | 'Moderate competitor signal'
  | 'Weak competitor signal'
  | 'Low competitor signal';

export type CompetitorBenchmark = {
  benchmarkScore: number;
  tier: BenchmarkTier;            // human-readable display label
  tierToken: BenchmarkTierToken;  // canonical token for DB storage / filtering
  confidence: BenchmarkConfidence;
  evidenceSource: string;         // human-readable display sentence
  evidenceToken: EvidenceToken;   // canonical token for DB storage / filtering
  recommendedUse: string;         // shared analyst guidance
  formula: string;
  breakdown: { label: string; value: number; weight: number }[];
  warning: string | null;
};

const TIER_LABEL: Record<BenchmarkTierToken, BenchmarkTier> = {
  STRONG:   'Strong competitor signal',
  MODERATE: 'Moderate competitor signal',
  WEAK:     'Weak competitor signal',
  LOW:      'Low competitor signal',
};

const EVIDENCE_TOKEN: Record<CreativeSource, EvidenceToken> = {
  ASSET:    'VISION',
  MANUAL:   'MANUAL',
  FALLBACK: 'NONE',
};

const EVIDENCE_LABEL: Record<CreativeSource, string> = {
  ASSET:    'Vision creative analysis (creative seen by Claude Vision)',
  MANUAL:   'Manual CSV text (creative NOT analysed by Vision)',
  FALLBACK: 'No creative evidence (no asset, no manual text)',
};

/** Canonical tier token from a benchmark score. */
export function benchmarkTierToken(score: number): BenchmarkTierToken {
  if (score >= 8.0) return 'STRONG';
  if (score >= 6.5) return 'MODERATE';
  if (score >= 5.0) return 'WEAK';
  return 'LOW';
}

/** Display label from a benchmark score (back-compat for preview renderers). */
export function benchmarkTier(score: number): BenchmarkTier {
  return TIER_LABEL[benchmarkTierToken(score)];
}

// ─── UI label helpers (token → display label) ───────────────────────────────────
// Accept the canonical stored tokens (or null for not-yet-scored / legacy rows)
// and return short, dashboard-friendly labels. Shared by the dashboard pages and
// the preview scripts so labels never drift.

export function tierLabel(token: string | null | undefined): string {
  switch (token) {
    case 'STRONG':   return 'Strong';
    case 'MODERATE': return 'Moderate';
    case 'WEAK':     return 'Weak';
    case 'LOW':      return 'Low';
    default:         return 'Not scored';
  }
}

export function confidenceLabel(token: string | null | undefined): string {
  switch (token) {
    case 'HIGH':   return 'High confidence (Vision)';
    case 'MEDIUM': return 'Medium confidence (manual text)';
    case 'LOW':    return 'Low confidence (no creative)';
    default:       return 'Confidence unknown';
  }
}

export function evidenceLabel(token: string | null | undefined): string {
  switch (token) {
    case 'VISION': return 'Vision creative analysis';
    case 'MANUAL': return 'Manual CSV text';
    case 'NONE':   return 'No creative evidence';
    default:       return '—';
  }
}

export function creativeSourceLabel(token: string | null | undefined): string {
  switch (token) {
    case 'ASSET':    return 'Vision-analysed asset';
    case 'MANUAL':   return 'Manual text';
    case 'FALLBACK': return 'No creative captured';
    default:         return '—';
  }
}

/**
 * Shared analyst guidance — the SINGLE source of truth used by both the preview
 * scripts and ingestion (so they never drift). Derived from tier + confidence.
 */
export function recommendedUseFor(tierToken: BenchmarkTierToken, confidence: BenchmarkConfidence): string {
  if (confidence === 'LOW') return 'Reference only — low confidence (no creative seen)';
  const base =
    tierToken === 'STRONG'   ? 'Model / reverse-engineer — strong signal' :
    tierToken === 'MODERATE' ? 'Study — worth analysing' :
    tierToken === 'WEAK'     ? 'Reference only — weak signal' :
                               'Archive — low signal';
  return confidence === 'MEDIUM' ? `${base} (verify — manual text only)` : base;
}

/**
 * Derives a competitor benchmark from an already-computed AnalysisOutput and the
 * creative evidence source.
 *
 * ASSET   (HIGH):   AIDA avg ×0.70 + creativeScore ×0.20 + action/offer ×0.10
 * MANUAL  (MEDIUM): manual creative ×0.50 + copy/message ×0.30 + CTA/offer ×0.20
 * FALLBACK (LOW):   same blend as MANUAL but flagged unreliable.
 *
 * `action/offer` uses the Action AIDA score as the CTA/offer-strength proxy.
 */
export function scoreCompetitorBenchmarkAd(
  analysis: AnalysisOutput,
  source: CreativeSource,
): CompetitorBenchmark {
  const a = analysis.aidaScores;
  const aidaAvg = clampScore((a.attention + a.interest + a.desire + a.action) / 4);
  const creativeScore = analysis.creativeScore;
  const copyScore = analysis.copyScore;
  const actionSignal = a.action; // CTA/offer/action proxy from AIDA

  let benchmarkScore: number;
  let confidence: BenchmarkConfidence;
  let formula: string;
  let breakdown: { label: string; value: number; weight: number }[];
  let warning: string | null;

  if (source === 'ASSET') {
    benchmarkScore = clampScore(aidaAvg * 0.70 + creativeScore * 0.20 + actionSignal * 0.10);
    confidence = 'HIGH';
    formula = 'AIDA avg ×0.70 + creative ×0.20 + action/offer ×0.10';
    breakdown = [
      { label: 'AIDA avg',  value: aidaAvg,       weight: 0.70 },
      { label: 'creative',  value: creativeScore, weight: 0.20 },
      { label: 'action',    value: actionSignal,  weight: 0.10 },
    ];
    warning = null;
  } else if (source === 'MANUAL') {
    benchmarkScore = clampScore(creativeScore * 0.50 + copyScore * 0.30 + actionSignal * 0.20);
    confidence = 'MEDIUM';
    formula = 'manual creative ×0.50 + copy/message ×0.30 + CTA/offer ×0.20';
    breakdown = [
      { label: 'creative (manual)', value: creativeScore, weight: 0.50 },
      { label: 'copy/message',      value: copyScore,     weight: 0.30 },
      { label: 'CTA/offer',         value: actionSignal,  weight: 0.20 },
    ];
    warning = 'MEDIUM confidence — the creative was not analysed by Vision; score is based on operator-entered text.';
  } else {
    benchmarkScore = clampScore(creativeScore * 0.50 + copyScore * 0.30 + actionSignal * 0.20);
    confidence = 'LOW';
    formula = 'machine baseline only (no asset / no manual text)';
    breakdown = [
      { label: 'creative (none)', value: creativeScore, weight: 0.50 },
      { label: 'copy/message',    value: copyScore,     weight: 0.30 },
      { label: 'CTA/offer',       value: actionSignal,  weight: 0.20 },
    ];
    warning = 'LOW confidence — no creative was captured or described. Treat this score as unreliable.';
  }

  const tierToken = benchmarkTierToken(benchmarkScore);
  return {
    benchmarkScore,
    tier: TIER_LABEL[tierToken],
    tierToken,
    confidence,
    evidenceSource: EVIDENCE_LABEL[source],
    evidenceToken: EVIDENCE_TOKEN[source],
    recommendedUse: recommendedUseFor(tierToken, confidence),
    formula,
    breakdown,
    warning,
  };
}
