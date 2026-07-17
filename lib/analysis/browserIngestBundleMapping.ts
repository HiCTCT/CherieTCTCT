/**
 * Bundle → database payload mapping (Phase 1 part 2) — PURE
 *
 * Turns ONE validated schema-v3 SUCCESS row into database-neutral Ad and AdAnalysis
 * payloads. This is the only place that decides what a browser-collected ad looks
 * like in the database, and it is deliberately dependency-free so the rules can be
 * proven with plain fixtures.
 *
 * STRUCTURAL GUARANTEES — enforced by the import list, not by comments:
 *   - No Prisma, no creativeAssetAnalyser, no staticAnalyser, no competitorScoring,
 *     no Anthropic, no Playwright, no capture code, no live ingestion script.
 *   - Nothing is scored, re-scored, derived from prose or reconstructed. Every value
 *     comes from the bundle's authoritative `analysis_result` / `benchmark_result`,
 *     which the preview computed once and validation has already proven complete.
 *
 * Honesty contract:
 *   - A required AdAnalysis field is NEVER filled with '', [] or {} to satisfy the
 *     schema. If the bundle cannot supply it, validation rejected the bundle long
 *     before this module runs.
 *   - A nullable field is null ONLY when the scorer genuinely produced nothing.
 *   - Raw browser-listing headline/description never appear here. Only per-field
 *     ACCEPT verified metadata may populate advertiser copy.
 */

import type { BundleSuccessRowV3, BundleSubScores } from './browserAnalysisBundle';

// ─── Database-neutral payloads ────────────────────────────────────────────────

export type AdWritePayload = {
  competitorId: string;
  clientId: string;
  industryId: string;
  productOrService: string | null;
  adFormat: 'STATIC' | 'VIDEO';
  adLink: string;
  activeSince: Date | null;
  primaryCopy: string | null;
  headline: string | null;
  description: string | null;
  metaAdId: string;
  adSource: string;
  reviewStatus: string;
  score: number;
  qualified: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSeenActiveAt: Date;
  adStatus: string;
  capturedAssetPath: string | null;
  capturedAssetType: string | null;
  competitorBenchmarkScore: number;
  benchmarkTier: string;
  benchmarkConfidence: string;
  evidenceSource: string;
  creativeSource: string;
  benchmarkScoredAt: Date;
};

export type AdAnalysisWritePayload = {
  // ── Required non-null in the AdAnalysis model ──
  creativeAnalysis: string;
  copyAnalysis: string;
  headlineAnalysis: string;
  descriptionAnalysis: string;
  strengthsJson: string;
  weaknessesJson: string;
  improvementsJson: string;
  rubricScoresJson: string;
  overallScore: number;

  // ── Nullable ──
  hookStopScrollScore: number | null;
  audienceRelevanceScore: number | null;
  valueClarityScore: number | null;
  trustProofStrengthScore: number | null;
  ctaClarityScore: number | null;
  visualHierarchyScore: number | null;
  productClarityScore: number | null;
  offerClarityScore: number | null;
  headlineStrengthScore: number | null;
  descriptionUsefulnessScore: number | null;
  ctaVisibilityScore: number | null;
  trustSignalsScore: number | null;
  firstThreeSecondsScore: number | null;
  soundOffDesignScore: number | null;
  soundOnEnhancementScore: number | null;
  onScreenTextScore: number | null;
  storyFlowScore: number | null;
  authenticityScore: number | null;
  platformNativeFeelScore: number | null;
  aidaJson: string;
  funnelStage: string;
  raceStage: string;
  copyScore: number;
  headlineScore: number | null;
  descriptionScore: number | null;
  creativeScore: number;
  aidaAttentionScore: number;
  aidaInterestScore: number;
  aidaDesireScore: number;
  aidaActionScore: number;
  clarityScore: number;
  connectionScore: number;
  convictionScore: number;
  trustFunnelStage: string;
  behaviouralTriggersJson: string;
  recommendationsJson: string;
  /** null ONLY when the scorer genuinely produced no rewrite direction. */
  rewriteDirectionJson: string | null;
  finalVerdict: string;
  recommendedUse: string;
  benchmarkBreakdownJson: string;
};

export type IngestPayload = { ad: AdWritePayload; analysis: AdAnalysisWritePayload };

/**
 * Every AdAnalysis column the Prisma model requires non-null. The tracked test walks
 * this list against a built payload, so a future column cannot be silently forgotten.
 */
export const REQUIRED_AD_ANALYSIS_FIELDS = [
  'creativeAnalysis', 'copyAnalysis', 'headlineAnalysis', 'descriptionAnalysis',
  'strengthsJson', 'weaknessesJson', 'improvementsJson', 'rubricScoresJson', 'overallScore',
] as const;

export type VerifiedMetaDecisionInput = {
  headline: string;
  headline_status: string;
  description: string;
  description_status: string;
};

export type IngestPayloadContext = {
  competitorId: string;
  clientId: string;
  industryId: string;
  /** From the source CSV row — advertiser display fields, never analysis. */
  productOrService: string;
  adLink: string;
  activeSince: Date | null;
  /** The exact copy the bundle recorded as scored. */
  primaryCopy: string;
  /** Derived from the captured files on disk by the caller; never from adFormat. */
  capturedAssetType: string | null;
  /** ACCEPT-gated sidecar values, or null when none is usable. */
  verifiedMeta: VerifiedMetaDecisionInput | null;
  adSource: string;
  /** Ingestion time — when this ad was first/last SEEN. */
  now: Date;
  /**
   * When the benchmark was actually COMPUTED: the validated bundle's `created_at`.
   * Never ingestion time — the score was produced during preview, possibly days earlier,
   * and claiming otherwise would misdate the evidence.
   */
  benchmarkScoredAt: Date;
};

// ─── Mechanical derivations (no scoring) ──────────────────────────────────────

/** IMAGE/CAROUSEL → STATIC, VIDEO → VIDEO. A shape mapping, not a judgement. */
export function deriveAdFormat(mediaType: string): 'STATIC' | 'VIDEO' | null {
  const mt = mediaType.trim().toUpperCase();
  if (mt === 'IMAGE' || mt === 'CAROUSEL') return 'STATIC';
  if (mt === 'VIDEO') return 'VIDEO';
  return null;
}

/**
 * Rebuilds the exact object the scorer produced, so rubricScoresJson round-trips
 * byte-for-byte: keys the scorer left undefined were dropped by JSON.stringify, and
 * v3 stored them as explicit null purely so validation could prove completeness.
 */
export function subScoresToJson(sub: BundleSubScores): string {
  const out: Record<string, number> = {};
  const put = (k: string, v: number | null) => { if (v !== null) out[k] = v; };
  out.hookStopScroll = sub.hook_stop_scroll;
  out.audienceRelevance = sub.audience_relevance;
  out.valueClarity = sub.value_clarity;
  out.trustProofStrength = sub.trust_proof_strength;
  out.ctaClarity = sub.cta_clarity;
  put('visualHierarchy', sub.visual_hierarchy);
  put('productClarity', sub.product_clarity);
  put('offerClarity', sub.offer_clarity);
  put('headlineStrength', sub.headline_strength);
  put('descriptionUsefulness', sub.description_usefulness);
  put('ctaVisibility', sub.cta_visibility);
  put('trustSignals', sub.trust_signals);
  put('firstThreeSeconds', sub.first_three_seconds);
  put('soundOffDesign', sub.sound_off_design);
  put('soundOnEnhancement', sub.sound_on_enhancement);
  put('onScreenText', sub.on_screen_text);
  put('storyFlow', sub.story_flow);
  put('authenticity', sub.authenticity);
  put('platformNativeFeel', sub.platform_native_feel);
  return JSON.stringify(out);
}

/** Only a per-field ACCEPT may reach an advertiser column. Anything else stays blank. */
function acceptedOnly(value: string, status: string): string | null {
  return status.trim().toUpperCase() === 'ACCEPT' && value.trim() !== '' ? value : null;
}

export type BuildResult =
  | { ok: true; payload: IngestPayload }
  | { ok: false; reason: string };

/**
 * Builds the write payload for one validated v3 SUCCESS row.
 *
 * Fails (never guesses) when a mechanical derivation cannot be made. It cannot fail on
 * a missing analysis value: validation already proved the result blocks complete.
 */
export function buildIngestPayload(row: BundleSuccessRowV3, ctx: IngestPayloadContext): BuildResult {
  const format = deriveAdFormat(row.media_type);
  if (!format) return { ok: false, reason: `media_type "${row.media_type}" is not IMAGE, CAROUSEL or VIDEO — cannot derive adFormat` };

  // Ad.adLink is required non-null by the model. A blank ad_library_url cannot be
  // filled in — fabricating a URL would invent provenance for the ad — so the row
  // becomes non-writable instead. The offending value is never echoed.
  const adLink = ctx.adLink.trim();
  if (adLink === '') {
    return { ok: false, reason: 'ad_library_url is blank — Ad.adLink is required and a URL is never fabricated' };
  }

  if (!Number.isFinite(ctx.benchmarkScoredAt.getTime())) {
    return { ok: false, reason: 'benchmarkScoredAt is not a valid instant — refusing to misdate the benchmark' };
  }

  const R = row.analysis_result;
  const B = row.benchmark_result;
  const S = R.sub_scores;

  const vm = ctx.verifiedMeta;
  const headline = vm ? acceptedOnly(vm.headline, vm.headline_status) : null;
  const description = vm ? acceptedOnly(vm.description, vm.description_status) : null;

  const ad: AdWritePayload = {
    competitorId: ctx.competitorId,
    clientId: ctx.clientId,
    industryId: ctx.industryId,
    productOrService: ctx.productOrService.trim() || null,
    adFormat: format,
    adLink,
    activeSince: ctx.activeSince,
    // The bundle recorded the copy that was actually scored. Blank means the scorer
    // saw no usable copy (e.g. contaminated) — null, never an empty string.
    primaryCopy: ctx.primaryCopy.trim() || null,
    headline,
    description,
    metaAdId: row.ad_id,
    adSource: ctx.adSource,
    reviewStatus: 'PENDING',
    score: R.overall_score,
    qualified: R.qualified,
    firstSeenAt: ctx.now,
    lastSeenAt: ctx.now,
    lastSeenActiveAt: ctx.now,
    adStatus: 'ACTIVE',
    capturedAssetPath: row.creative_asset_path || null,
    capturedAssetType: row.creative_asset_path ? ctx.capturedAssetType : null,
    competitorBenchmarkScore: B.benchmark_score,
    benchmarkTier: B.tier_token,
    benchmarkConfidence: B.confidence,
    evidenceSource: B.evidence_token,
    creativeSource: row.creative_source,
    // When the benchmark was COMPUTED (bundle time), not when it was ingested.
    benchmarkScoredAt: ctx.benchmarkScoredAt,
  };

  const analysis: AdAnalysisWritePayload = {
    // Required — verbatim from the computed result. Never composed here.
    creativeAnalysis: R.creative_analysis,
    copyAnalysis: R.copy_analysis,
    headlineAnalysis: R.headline_analysis,
    descriptionAnalysis: R.description_analysis,
    strengthsJson: JSON.stringify(R.strengths),
    weaknessesJson: JSON.stringify(R.weaknesses),
    improvementsJson: JSON.stringify(R.improvements),
    rubricScoresJson: subScoresToJson(S),
    overallScore: R.overall_score,

    // Rubric columns — null where the scorer genuinely produced nothing for this format.
    hookStopScrollScore: S.hook_stop_scroll,
    audienceRelevanceScore: S.audience_relevance,
    valueClarityScore: S.value_clarity,
    trustProofStrengthScore: S.trust_proof_strength,
    ctaClarityScore: S.cta_clarity,
    visualHierarchyScore: S.visual_hierarchy,
    productClarityScore: S.product_clarity,
    offerClarityScore: S.offer_clarity,
    headlineStrengthScore: S.headline_strength,
    descriptionUsefulnessScore: S.description_usefulness,
    ctaVisibilityScore: S.cta_visibility,
    trustSignalsScore: S.trust_signals,
    firstThreeSecondsScore: S.first_three_seconds,
    soundOffDesignScore: S.sound_off_design,
    soundOnEnhancementScore: S.sound_on_enhancement,
    onScreenTextScore: S.on_screen_text,
    storyFlowScore: S.story_flow,
    authenticityScore: S.authenticity,
    platformNativeFeelScore: S.platform_native_feel,

    aidaJson: JSON.stringify(R.aida),
    funnelStage: R.funnel_stage,
    raceStage: R.race_stage,
    copyScore: R.copy_score,
    headlineScore: R.headline_score,
    descriptionScore: R.description_score,
    creativeScore: R.creative_score,
    aidaAttentionScore: R.aida_scores.attention,
    aidaInterestScore: R.aida_scores.interest,
    aidaDesireScore: R.aida_scores.desire,
    aidaActionScore: R.aida_scores.action,
    clarityScore: R.clarity_score,
    connectionScore: R.connection_score,
    convictionScore: R.conviction_score,
    trustFunnelStage: R.trust_funnel_stage,
    behaviouralTriggersJson: JSON.stringify(R.behavioural_triggers),
    // Restores the scorer's original Recommendations shape. The bundle suffixes the
    // headline/description keys because a bare one is forbidden there; the database
    // column has always held the scorer's own shape, so it is restored here.
    recommendationsJson: JSON.stringify({
      copy: R.recommendations.copy,
      headline: R.recommendations.headline_recommendation,
      description: R.recommendations.description_recommendation,
      creative: R.recommendations.creative,
      conversionStrength: R.recommendations.conversion_strength,
    }),
    rewriteDirectionJson: R.rewrite_direction
      ? JSON.stringify({
          hook: R.rewrite_direction.hook,
          body: R.rewrite_direction.body,
          cta: R.rewrite_direction.cta,
          creativeDirection: R.rewrite_direction.creative_direction,
        })
      : null,
    finalVerdict: R.final_verdict,
    recommendedUse: B.recommended_use,
    benchmarkBreakdownJson: JSON.stringify({ formula: B.formula, breakdown: B.breakdown }),
  };

  return { ok: true, payload: { ad, analysis } };
}
