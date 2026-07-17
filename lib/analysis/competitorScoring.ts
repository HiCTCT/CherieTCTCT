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
import {
  TIER_LABEL_BY_TOKEN, EVIDENCE_TOKEN_BY_SOURCE, EVIDENCE_LABEL_BY_SOURCE,
  BENCHMARK_FORMULA_BY_SOURCE, deriveTierToken, deriveRecommendedUse,
  deriveBenchmarkBreakdown, computeBenchmarkScoreFromBreakdown, deriveEvidenceForCreativeSource,
} from '@/lib/analysis/benchmarkContract';

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

// These tables now live in the pure benchmark contract, so the bundle validator can
// check the scorer's guarantees without importing (or executing) any scoring code.
// Same values, same behaviour — single source of truth, so the two cannot drift.
const TIER_LABEL: Record<BenchmarkTierToken, BenchmarkTier> = TIER_LABEL_BY_TOKEN;
const EVIDENCE_TOKEN: Record<CreativeSource, EvidenceToken> = EVIDENCE_TOKEN_BY_SOURCE;

const EVIDENCE_LABEL: Record<CreativeSource, string> = EVIDENCE_LABEL_BY_SOURCE;

/** Canonical tier token from a benchmark score. */
export function benchmarkTierToken(score: number): BenchmarkTierToken {
  // Thresholds live in the pure contract so the bundle validator can check a produced
  // benchmark against the SAME rule. Same boundaries (>=8.0 / >=6.5 / >=5.0), unchanged.
  return deriveTierToken(score);
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
    case 'MANUAL': return 'Stored manual analysis';
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
  // Exact same strings and rule — now owned by the pure contract, so the validator can
  // reject a recommended_use the scorer would never have written.
  return deriveRecommendedUse(tierToken, confidence);
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
  // Every rule below — inputs, weights, labels, formula, confidence, warning, rounding —
  // now comes from the pure benchmark contract, which the bundle validator consumes too.
  // Identical arithmetic and identical strings to before: this is a single-source-of-truth
  // extraction, not a scoring change.
  const breakdown = deriveBenchmarkBreakdown(
    { aidaScores: analysis.aidaScores, creativeScore: analysis.creativeScore, copyScore: analysis.copyScore },
    source,
  );
  const benchmarkScore = computeBenchmarkScoreFromBreakdown(breakdown);
  const evidence = deriveEvidenceForCreativeSource(source);
  const confidence: BenchmarkConfidence = evidence.confidence;
  const formula = BENCHMARK_FORMULA_BY_SOURCE[source];
  const warning = evidence.warning;

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
