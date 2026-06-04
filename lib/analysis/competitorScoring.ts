/**
 * Competitor Benchmark Scoring (separate from internal QA scoring)
 *
 * The internal QA scorer in scoring.ts / staticAnalyser.ts / videoAnalyser.ts
 * grades OOM's OWN ads, which have full copy/headline/description. It is
 * copy-centric and uses a 7.0 pass/fail qualification gate.
 *
 * Competitor ads collected from the Meta Ad Library have little or no copy text —
 * we mainly capture the creative. Running them through the copy-centric scorer
 * unfairly caps their score (copy/clarity/connection/conviction sit near their
 * 2.0 floor). This module provides a DIFFERENT lens for competitor benchmarking:
 * it leans on the evidence we actually have (Vision creative analysis + AIDA),
 * reports a confidence level, and ranks ads into tiers instead of pass/fail.
 *
 * IMPORTANT: this is a pure, read-only derivation from an existing AnalysisOutput.
 * It does NOT modify the QA scorer, ingestion, the DB, or Prisma. It is consumed
 * by browser:preview only for now.
 */

import { clampScore } from '@/lib/analysis/scoring';
import type { AnalysisOutput } from '@/lib/analysis/types';
import type { CreativeSource } from '@/lib/analysis/creativeAssetAnalyser';

export type BenchmarkConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type BenchmarkTier =
  | 'Strong competitor signal'
  | 'Moderate competitor signal'
  | 'Weak competitor signal'
  | 'Low competitor signal';

export type CompetitorBenchmark = {
  benchmarkScore: number;
  tier: BenchmarkTier;
  confidence: BenchmarkConfidence;
  evidenceSource: string;
  formula: string;
  breakdown: { label: string; value: number; weight: number }[];
  warning: string | null;
};

/** Maps a benchmark score to a competitor-signal tier. */
export function benchmarkTier(score: number): BenchmarkTier {
  if (score >= 8.0) return 'Strong competitor signal';
  if (score >= 6.5) return 'Moderate competitor signal';
  if (score >= 5.0) return 'Weak competitor signal';
  return 'Low competitor signal';
}

/**
 * Derives a competitor benchmark score from an already-computed AnalysisOutput
 * and the creative evidence source (ASSET / MANUAL / FALLBACK).
 *
 * ASSET   (HIGH):   AIDA avg ×0.70 + creativeScore ×0.20 + action/offer ×0.10
 *                   — the creative was actually seen by Claude Vision, so its
 *                     AIDA judgement is the primary signal.
 * MANUAL  (MEDIUM): manual creative ×0.50 + copy/message ×0.30 + CTA/offer ×0.20
 *                   — based on operator-entered text; creative not Vision-analysed.
 * FALLBACK (LOW):   same blend as MANUAL but flagged unreliable (no evidence at all).
 *
 * `action/offer` uses the Action AIDA score as the CTA/offer-strength proxy until
 * a dedicated offer-detection signal exists.
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

  if (source === 'ASSET') {
    const benchmarkScore = clampScore(aidaAvg * 0.70 + creativeScore * 0.20 + actionSignal * 0.10);
    return {
      benchmarkScore,
      tier: benchmarkTier(benchmarkScore),
      confidence: 'HIGH',
      evidenceSource: 'Vision creative analysis (creative seen by Claude Vision)',
      formula: 'AIDA avg ×0.70 + creative ×0.20 + action/offer ×0.10',
      breakdown: [
        { label: 'AIDA avg',  value: aidaAvg,       weight: 0.70 },
        { label: 'creative',  value: creativeScore, weight: 0.20 },
        { label: 'action',    value: actionSignal,  weight: 0.10 },
      ],
      warning: null,
    };
  }

  if (source === 'MANUAL') {
    const benchmarkScore = clampScore(creativeScore * 0.50 + copyScore * 0.30 + actionSignal * 0.20);
    return {
      benchmarkScore,
      tier: benchmarkTier(benchmarkScore),
      confidence: 'MEDIUM',
      evidenceSource: 'Manual CSV text (creative NOT analysed by Vision)',
      formula: 'manual creative ×0.50 + copy/message ×0.30 + CTA/offer ×0.20',
      breakdown: [
        { label: 'creative (manual)', value: creativeScore, weight: 0.50 },
        { label: 'copy/message',      value: copyScore,     weight: 0.30 },
        { label: 'CTA/offer',         value: actionSignal,  weight: 0.20 },
      ],
      warning: 'MEDIUM confidence — the creative was not analysed by Vision; score is based on operator-entered text.',
    };
  }

  // FALLBACK — no asset, no manual text. Same blend, but mark unreliable.
  const benchmarkScore = clampScore(creativeScore * 0.50 + copyScore * 0.30 + actionSignal * 0.20);
  return {
    benchmarkScore,
    tier: benchmarkTier(benchmarkScore),
    confidence: 'LOW',
    evidenceSource: 'No creative evidence (no asset, no manual text)',
    formula: 'machine baseline only (no asset / no manual text)',
    breakdown: [
      { label: 'creative (none)', value: creativeScore, weight: 0.50 },
      { label: 'copy/message',    value: copyScore,     weight: 0.30 },
      { label: 'CTA/offer',       value: actionSignal,  weight: 0.20 },
    ],
    warning: 'LOW confidence — no creative was captured or described. Treat this score as unreliable.',
  };
}
