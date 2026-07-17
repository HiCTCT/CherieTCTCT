/**
 * Tracked tests for the Phase 1 part 2 bundle-backed ingestion path.
 *
 * Runner: Node's built-in `node:test` through tsx.
 *   npm run test:browser-ingestion-bundle
 *
 * These tests never call Anthropic, never open a browser and never touch a real
 * database. The database boundary is a fake that records every call, so "zero
 * database calls" is asserted rather than assumed. Fixtures are synthetic bytes in an
 * OS temp directory — no real project asset is read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  BUNDLE_SCHEMA_V2, BUNDLE_SCHEMA_V3, BUNDLE_PROMPT_VERSION, BUNDLE_PLANNER_VERSION,
  validateBundle, decidePersistence, sha256Buffer,
} from '../lib/analysis/browserAnalysisBundle';
import type {
  BrowserAnalysisBundle, BundleRow, BundleSuccessRow, BundleSuccessRowV3,
  BundleAnalysisResult, BundleBenchmarkResult, BundleSubScores,
} from '../lib/analysis/browserAnalysisBundle';
import {
  buildIngestPayload, subScoresToJson, deriveAdFormat, REQUIRED_AD_ANALYSIS_FIELDS,
} from '../lib/analysis/browserIngestBundleMapping';
import type {
  IngestPayloadContext, AdWritePayload, AdAnalysisWritePayload,
} from '../lib/analysis/browserIngestBundleMapping';
import {
  TIER_LABEL_BY_TOKEN, EVIDENCE_TOKEN_BY_SOURCE, EVIDENCE_LABEL_BY_SOURCE,
  BENCHMARK_CONFIDENCE_BY_SOURCE, BENCHMARK_FORMULA_BY_SOURCE,
  deriveTierToken, deriveRecommendedUse, deriveEvidenceForCreativeSource,
  deriveBenchmarkBreakdown, computeBenchmarkScoreFromBreakdown, roundBenchmarkScore,
} from '../lib/analysis/benchmarkContract';
// The PRODUCTION scorer — imported so parity is proven by execution, not by re-derivation.
import { scoreCompetitorBenchmarkAd } from '../lib/analysis/competitorScoring';
import type { CompetitorBenchmark } from '../lib/analysis/competitorScoring';
import type { AnalysisOutput } from '../lib/analysis/types';
import { planIngestion } from '../scripts/plan-browser-ingest-from-bundle';
import { runIngestion } from '../scripts/ingest-browser-collected-ads';
import type { IngestDb, DbFactory, CompetitorRecord } from '../scripts/ingest-browser-collected-ads';

// ─── Sandbox (outside the repo, synthetic bytes only) ─────────────────────────

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-test-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

const ASSET_REL = 'data/creative-assets/castlery/1111111111';
fs.mkdirSync(path.join(ROOT, ASSET_REL), { recursive: true });
const FRAME = Buffer.from('fake-frame-bytes');
fs.writeFileSync(path.join(ROOT, ASSET_REL, 'frame-01.png'), FRAME);

const CSV_REL = 'data/imports/synthetic.with-assets.csv';
fs.mkdirSync(path.join(ROOT, 'data/imports'), { recursive: true });

const IMAGE_ASSET_REL = 'data/creative-assets/castlery/6666666666';
fs.mkdirSync(path.join(ROOT, IMAGE_ASSET_REL), { recursive: true });
const IMAGE_BYTES = Buffer.from('fake-image-bytes');
fs.writeFileSync(path.join(ROOT, IMAGE_ASSET_REL, 'image-01.png'), IMAGE_BYTES);

const CSV_HEADER = 'ad_id,collection_status,media_type,creative_asset_path,ad_copy,competitor_name,meta_page_id,ad_library_url,ad_delivery_start_time,headline,description';
const CSV_ROWS = [
  `1111111111,READY,VIDEO,${ASSET_REL},Some advertiser ad copy.,Castlery,PAGE1,https://example.test/ad/1,2026-01-02,RAW HEADLINE MUST NEVER BE INGESTED,RAW DESCRIPTION MUST NEVER BE INGESTED`,
  `2222222222,READY,VIDEO,${ASSET_REL},Second ad copy.,Castlery,PAGE1,https://example.test/ad/2,2026-01-03,RAW H2,RAW D2`,
  '3333333333,NEEDS_REVIEW,IMAGE,,held copy,Castlery,PAGE1,https://example.test/ad/3,,,',
  '4444444444,UNAVAILABLE,IMAGE,,gone copy,Castlery,PAGE1,https://example.test/ad/4,,,',
  '5555555555,SKIP,IMAGE,,skip copy,Castlery,PAGE1,https://example.test/ad/5,,,',
  `6666666666,READY,IMAGE,${IMAGE_ASSET_REL},Image ad copy.,Castlery,PAGE1,https://example.test/ad/6,,,`,
  '7777777777,READY,IMAGE,,Fallback ad copy.,Castlery,PAGE1,https://example.test/ad/7,,,',
  // A READY row with NO ad_library_url — Ad.adLink is required and is never fabricated.
  '8888888888,READY,IMAGE,,No link copy.,Castlery,PAGE1,,,,',
];
const CSV_BODY = `${CSV_HEADER}\n${CSV_ROWS.join('\n')}\n`;
fs.writeFileSync(path.join(ROOT, CSV_REL), CSV_BODY, 'utf-8');
const CSV_SUM = sha256Buffer(Buffer.from(CSV_BODY, 'utf-8'));
const CSV_ABS = path.join(ROOT, CSV_REL);

const SIDECAR_REL = 'data/imports/synthetic.verified-meta.csv';
const SIDECAR_HEADER = 'ad_id,verified_headline,verified_description,cta,display_url,landing_url,capture_strategy,headline_status,headline_reason,description_status,description_reason,verification_status,verification_reason,captured_at';
fs.writeFileSync(
  path.join(ROOT, SIDECAR_REL),
  `${SIDECAR_HEADER}\n1111111111,Verified headline,Held description,Shop Now,,,structured-footer,ACCEPT,ok,REVIEW,uncertain,ACCEPT,ok,2026-07-16T00:00:00.000Z\n`,
  'utf-8',
);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const subScores = (over: Partial<BundleSubScores> = {}): BundleSubScores => ({
  hook_stop_scroll: 7, audience_relevance: 6, value_clarity: 6, trust_proof_strength: 5, cta_clarity: 6,
  visual_hierarchy: null, product_clarity: null, offer_clarity: null, headline_strength: null,
  description_usefulness: null, cta_visibility: null, trust_signals: null,
  // VIDEO ad → the video half is populated, the static half is genuinely null.
  first_three_seconds: 7, sound_off_design: 6, sound_on_enhancement: 5, on_screen_text: 6,
  story_flow: 6, authenticity: 7, platform_native_feel: 6,
  ...over,
});

const analysisResult = (over: Partial<BundleAnalysisResult> = {}): BundleAnalysisResult => ({
  overall_score: 6.2,
  qualified: false,
  sub_scores: subScores(),
  creative_analysis: 'The frames show a sofa in a styled living room.',
  copy_analysis: 'Copy leads with comfort and a seasonal offer.',
  headline_analysis: 'Headline scored 5.0/10. "Verified headline" — present but lacks sharpness.',
  description_analysis: 'Description not provided. No score assigned.',
  aida: { attention: 'Strong opening frame.', interest: 'Product benefit lands.', desire: 'Offer is clear.', action: 'CTA present.' },
  aida_explanations: { attention: 'Strong opening frame.', interest: 'Product benefit lands.', desire: 'Offer is clear.', action: 'CTA present.' },
  aida_scores: { attention: 7, interest: 6, desire: 6, action: 5 },
  funnel_stage: 'MOFU',
  race_stage: 'ACT',
  trust_funnel_stage: 'SOLUTION_AWARE',
  strengths: ['Clear product shot', 'Consistent branding'],
  weaknesses: ['Hook is slow', 'No urgency'],
  // The real scorer always emits exactly three: [recommendations.copy, .headline, .creative].
  improvements: ['Lead with the offer.', 'Name the outcome.', 'Cut to product sooner.'],
  copy_score: 6,
  headline_score: 5,
  description_score: null,
  creative_score: 7,
  clarity_score: 6,
  connection_score: 6,
  conviction_score: 5,
  behavioural_triggers: [{ name: 'Value', strength: 'MODERATE' }],
  recommendations: {
    copy: 'Lead with the offer.',
    headline_recommendation: 'Name the outcome.',
    description_recommendation: 'Add proof.',
    creative: 'Cut to product sooner.',
    conversion_strength: 'Moderate overall.',
  },
  rewrite_direction: { hook: 'Open on the sofa.', body: 'State the benefit.', cta: 'Shop the sale.', creative_direction: 'Tighter cuts.' },
  final_verdict: 'GOOD_NEEDS_SHARPENING',
  ...over,
});

/**
 * Benchmarks built the way the real scorer builds them — DERIVED from the same pure
 * contract rather than hand-typed. Hand-typing is exactly how the old fixture ended up
 * asserting score 6.4 with tier MODERATE, which the scorer can never emit (MODERATE
 * starts at 6.5, so 6.4 is WEAK). Deriving them means a fixture cannot drift from the
 * scorer, and the impossible combination now has its own negative test instead.
 */
const benchmarkFor = (source: 'ASSET' | 'MANUAL' | 'FALLBACK', a = analysisResult()): BundleBenchmarkResult => {
  const breakdown = deriveBenchmarkBreakdown(
    { aidaScores: a.aida_scores, creativeScore: a.creative_score, copyScore: a.copy_score },
    source,
  );
  const score = computeBenchmarkScoreFromBreakdown(breakdown);
  const token = deriveTierToken(score);
  const evidence = deriveEvidenceForCreativeSource(source);
  return {
    benchmark_score: score,
    tier: TIER_LABEL_BY_TOKEN[token],
    tier_token: token,
    confidence: evidence.confidence,
    evidence_source: evidence.label,
    evidence_token: evidence.token,
    recommended_use: deriveRecommendedUse(token, evidence.confidence),
    formula: BENCHMARK_FORMULA_BY_SOURCE[source],
    breakdown,
    warning: evidence.warning,
  };
};

/** A faithful ASSET benchmark: 6.0×0.70 + 7×0.20 + 5×0.10 = 6.1 → WEAK. */
const benchmarkResult = (over: Partial<BundleBenchmarkResult> = {}): BundleBenchmarkResult => ({
  ...benchmarkFor('ASSET'),
  ...over,
});

/** A faithful FALLBACK benchmark: 7×0.50 + 6×0.30 + 5×0.20 = 6.3 → WEAK. */
const fallbackBenchmark = (over: Partial<BundleBenchmarkResult> = {}): BundleBenchmarkResult => ({
  ...benchmarkFor('FALLBACK'),
  ...over,
});

/** A faithful MANUAL benchmark — the third evidence mode. */
const manualBenchmark = (over: Partial<BundleBenchmarkResult> = {}): BundleBenchmarkResult => ({
  ...benchmarkFor('MANUAL'),
  ...over,
});

/** A v2 SUCCESS row: the summary only. */
const successRowV2 = (over: Partial<BundleSuccessRow> = {}): BundleSuccessRow => ({
  ad_id: '1111111111',
  source_row_number: 2,
  source_status: 'READY',
  media_type: 'VIDEO',
  creative_asset_path: ASSET_REL,
  creative_source: 'ASSET',
  assets: [{ filename: 'frame-01.png', sha256: sha256Buffer(FRAME), bytes: FRAME.length }],
  copy_used_for_scoring: 'Some advertiser ad copy.',
  analysis_status: 'SUCCESS',
  error_reason: null,
  visual_description: 'A sofa across the frames.',
  visual_confidence: 'HIGH',
  creative_notes: 'Attention 7/10.',
  aida_scores: { attention: 7, interest: 6, desire: 6, action: 5 },
  component_scores: {
    copy_score: 6, headline_score: 5, description_score: null, creative_score: 7,
    clarity_score: 6, connection_score: 6, conviction_score: 5,
  },
  internal_qa_score: 6.2,
  internal_qa_verdict: 'GOOD_NEEDS_SHARPENING',
  qualified: false,
  // Mirrors the derived ASSET benchmark: 6.1 → WEAK. Never hand-picked.
  benchmark_score: benchmarkFor('ASSET').benchmark_score,
  benchmark_tier: benchmarkFor('ASSET').tier_token,
  benchmark_confidence: 'HIGH',
  funnel_stage: 'MOFU',
  race_stage: 'ACT',
  trust_funnel_stage: 'SOLUTION_AWARE',
  behavioural_triggers: [{ name: 'Value', strength: 'MODERATE' }],
  strengths: ['Clear product shot', 'Consistent branding'],
  ...over,
});

/** A v3 SUCCESS row: the summary PLUS the authoritative computed result. */
const successRowV3 = (over: Partial<BundleSuccessRowV3> = {}): BundleSuccessRowV3 => ({
  ...successRowV2(),
  analysis_result: analysisResult(),
  benchmark_result: benchmarkResult(),
  ...over,
} as BundleSuccessRowV3);

/** The STATIC half populated, the video half genuinely null — what an IMAGE ad scores. */
const staticSubScores = (over: Partial<BundleSubScores> = {}): BundleSubScores => ({
  ...subScores(),
  visual_hierarchy: 6, product_clarity: 7, offer_clarity: 5, headline_strength: 5,
  description_usefulness: 4, cta_visibility: 6, trust_signals: 5,
  first_three_seconds: null, sound_off_design: null, sound_on_enhancement: null,
  on_screen_text: null, story_flow: null, authenticity: null, platform_native_feel: null,
  ...over,
});

/** An IMAGE (STATIC-scored) v3 row bound to CSV row 7. */
const imageRowV3 = (over: Partial<BundleSuccessRowV3> = {}): BundleSuccessRowV3 => ({
  ...successRowV2({
    ad_id: '6666666666',
    source_row_number: 7,
    media_type: 'IMAGE',
    creative_asset_path: IMAGE_ASSET_REL,
    assets: [{ filename: 'image-01.png', sha256: sha256Buffer(IMAGE_BYTES), bytes: IMAGE_BYTES.length }],
    copy_used_for_scoring: 'Image ad copy.',
    visual_confidence: null,   // visual confidence is VIDEO-only
  }),
  analysis_result: analysisResult({ sub_scores: staticSubScores() }),
  benchmark_result: benchmarkResult(),
  ...over,
} as BundleSuccessRowV3);

/** A FALLBACK-evidence v3 row (no asset consumed) bound to CSV row 8. */
const fallbackRowV3 = (over: Partial<BundleSuccessRowV3> = {}): BundleSuccessRowV3 => ({
  ...successRowV2({
    ad_id: '7777777777',
    source_row_number: 8,
    media_type: 'IMAGE',
    creative_asset_path: '',
    creative_source: 'FALLBACK',
    assets: [],
    copy_used_for_scoring: 'Fallback ad copy.',
    visual_confidence: null,
    benchmark_confidence: 'LOW',
    benchmark_score: fallbackBenchmark().benchmark_score,
    benchmark_tier: fallbackBenchmark().tier_token,
  }),
  analysis_result: analysisResult({ sub_scores: staticSubScores() }),
  benchmark_result: fallbackBenchmark(),
  ...over,
} as BundleSuccessRowV3);

const heldRow = (status: 'REVIEW' | 'SKIPPED' | 'ERROR', over: Partial<BundleRow> = {}): BundleRow => ({
  ad_id: '3333333333',
  source_row_number: 4,
  source_status: 'NEEDS_REVIEW',
  media_type: 'IMAGE',
  creative_asset_path: '',
  creative_source: 'FALLBACK',
  assets: [],
  copy_used_for_scoring: 'held copy',
  analysis_status: status,
  error_reason: 'a real reason',
  ...over,
} as BundleRow);

const bundleOf = (rows: BundleRow[], version: number, over: Partial<BrowserAnalysisBundle> = {}): BrowserAnalysisBundle => ({
  schema_version: version,
  created_at: BUNDLE_CREATED_AT,
  source_csv_path: CSV_REL,
  source_csv_sha256: CSV_SUM,
  verified_meta_path: null,
  verified_meta_sha256: null,
  analysis_model: 'claude-haiku-4-5',
  prompt_version: BUNDLE_PROMPT_VERSION,
  planner_version: BUNDLE_PLANNER_VERSION,
  ai_video_max_frames: 4,
  selected_ad_ids: rows.map((r) => r.ad_id),
  excluded_ad_ids: [],
  counts: {
    input_rows: CSV_ROWS.length,
    selected_rows: rows.length,
    success: rows.filter((r) => r.analysis_status === 'SUCCESS').length,
    review: rows.filter((r) => r.analysis_status === 'REVIEW').length,
    skipped: rows.filter((r) => r.analysis_status === 'SKIPPED').length,
    failed: rows.filter((r) => r.analysis_status === 'ERROR').length,
  },
  rows,
  ...over,
});

const V = (b: unknown) => validateBundle(b, { cwd: ROOT });
const errs = (b: unknown) => { const r = V(b); return r.ok ? [] : r.errors; };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

let bundleSeq = 0;
function writeBundleFile(b: BrowserAnalysisBundle): string {
  const p = path.join(ROOT, `b${bundleSeq++}.bundle.json`);
  fs.writeFileSync(p, JSON.stringify(b, null, 2), 'utf-8');
  return p;
}

// ─── Fake database boundary ───────────────────────────────────────────────────

type FakeDbCalls = {
  /** How many times the LAZY FACTORY ran — i.e. how many clients were constructed. */
  factory: number;
  resolveCompetitor: number;
  findExisting: number;
  insert: number;
  disconnect: number;
  inserted: Array<{ ad: AdWritePayload; analysis: AdAnalysisWritePayload }>;
};

function fakeDb(o: { existing?: string[]; failOn?: string } = {}): { db: IngestDb; getDb: DbFactory; calls: FakeDbCalls } {
  const calls: FakeDbCalls = { factory: 0, resolveCompetitor: 0, findExisting: 0, insert: 0, disconnect: 0, inserted: [] };
  const competitor: CompetitorRecord = {
    id: 'cmp1', name: 'Castlery', clientId: 'cli1', industryId: 'ind1', metaPageId: 'PAGE1', status: 'ACTIVE',
  };
  const db: IngestDb = {
    async resolveCompetitor() { calls.resolveCompetitor++; return competitor; },
    async findExistingMetaAdIds(_c, ids) { calls.findExisting++; return ids.filter((i) => (o.existing ?? []).includes(i)); },
    async insertAdWithAnalysis(ad, analysis) {
      calls.insert++;
      if (o.failOn && ad.metaAdId === o.failOn) throw new Error('simulated write failure');
      calls.inserted.push({ ad, analysis });
    },
    async disconnect() { calls.disconnect++; },
  };
  const getDb: DbFactory = async () => { calls.factory++; return db; };
  return { db, getDb, calls };
}

/** Any database contact at all, including constructing a client. */
const totalDbCalls = (c: FakeDbCalls) => c.factory + c.resolveCompetitor + c.findExisting + c.insert;

const LIVE = { dryRun: false, writeFlag: true, confirmFlag: 'I_UNDERSTAND' };
const DRY = { dryRun: true, writeFlag: false, confirmFlag: undefined };

/** Ingestion time, deliberately DIFFERENT from the bundle's created_at. */
const INGEST_NOW = new Date('2026-07-20T09:30:00.000Z');
const BUNDLE_CREATED_AT = '2026-07-17T00:00:00.000Z';

const run = (bundlePath: string | undefined, flags: typeof LIVE | typeof DRY, getDb: DbFactory | null, over: Record<string, unknown> = {}) =>
  runIngestion({ csvPath: CSV_ABS, bundlePath, cwd: ROOT, now: INGEST_NOW, ...flags, ...over }, getDb);

// ═══ Schema versions ══════════════════════════════════════════════════════════

test('an existing valid v2 bundle remains valid under its frozen contract', () => {
  assert.deepEqual(errs(bundleOf([successRowV2()], BUNDLE_SCHEMA_V2)), []);
});

test('a v2 SUCCESS row carrying v3 result blocks is rejected', () => {
  const b = bundleOf([successRowV3() as BundleRow], BUNDLE_SCHEMA_V2);
  assert.ok(errs(b).some((e) => e.includes('unrecognised field "analysis_result"')));
});

test('a complete v3 SUCCESS bundle is valid', () => {
  assert.deepEqual(errs(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), []);
});

test('a v3 SUCCESS row without the result blocks fails', () => {
  const b = bundleOf([successRowV2() as BundleRow], BUNDLE_SCHEMA_V3);
  const e = errs(b);
  assert.ok(e.some((x) => x.includes('missing required field "analysis_result"')));
  assert.ok(e.some((x) => x.includes('missing required field "benchmark_result"')));
});

test('an unsupported schema version still fails', () => {
  assert.ok(errs(bundleOf([successRowV2()], 99)).some((e) => e.includes('unsupported schema_version')));
});

// Every required persistence input must fail closed when missing.
for (const field of ['creative_analysis', 'copy_analysis', 'headline_analysis', 'description_analysis'] as const) {
  test(`v3 missing ${field} fails validation`, () => {
    const b = clone(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)) as unknown as { rows: Array<Record<string, Record<string, unknown>>> };
    delete b.rows[0]!.analysis_result![field];
    assert.ok(errs(b).some((e) => e.includes(`missing required field "${field}"`)));
  });
  test(`v3 empty ${field} fails validation — an empty analysis is never accepted`, () => {
    const row = successRowV3({ analysis_result: analysisResult({ [field]: '' } as Partial<BundleAnalysisResult>) });
    assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('must be a non-empty string')));
  });
}
for (const field of ['strengths', 'weaknesses', 'improvements', 'sub_scores', 'overall_score', 'recommendations', 'final_verdict'] as const) {
  test(`v3 missing ${field} fails validation`, () => {
    const b = clone(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)) as unknown as { rows: Array<Record<string, Record<string, unknown>>> };
    delete b.rows[0]!.analysis_result![field];
    assert.ok(errs(b).some((e) => e.includes(`missing required field "${field}"`)));
  });
}
test('v3 missing the whole benchmark result fails validation', () => {
  const b = clone(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)) as unknown as { rows: Array<Record<string, unknown>> };
  delete b.rows[0]!.benchmark_result;
  assert.ok(errs(b).some((e) => e.includes('missing required field "benchmark_result"')));
});
test('v3 missing a benchmark field fails validation', () => {
  const row = successRowV3({ benchmark_result: benchmarkResult() });
  const b = clone(bundleOf([row], BUNDLE_SCHEMA_V3)) as unknown as { rows: Array<Record<string, Record<string, unknown>>> };
  delete b.rows[0]!.benchmark_result!.recommended_use;
  assert.ok(errs(b).some((e) => e.includes('missing required field "recommended_use"')));
});

test('an incomplete rubric fails validation', () => {
  const b = clone(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)) as unknown as { rows: Array<{ analysis_result: { sub_scores: Record<string, unknown> } }> };
  delete b.rows[0]!.analysis_result.sub_scores.hook_stop_scroll;
  assert.ok(errs(b).some((e) => e.includes('missing required field "hook_stop_scroll"')));
});

// These two originally checked a weaker "some half must be populated" rule. The rule is
// now keyed off the ad's own media_type, which is strictly stronger: an all-null rubric
// and a both-halves rubric each fail on the specific half the media type demands.
test('a rubric with neither format half populated fails', () => {
  const bare = subScores({
    first_three_seconds: null, sound_off_design: null, sound_on_enhancement: null,
    on_screen_text: null, story_flow: null, authenticity: null, platform_native_feel: null,
  });
  const row = successRowV3({ analysis_result: analysisResult({ sub_scores: bare }) });
  const e = errs(bundleOf([row], BUNDLE_SCHEMA_V3));
  assert.ok(e.some((x) => x.includes('is required for a VIDEO ad')), 'a VIDEO ad must carry the video rubric');
});

test('a rubric claiming BOTH format halves fails', () => {
  const both = subScores({ visual_hierarchy: 6, product_clarity: 6 });
  const row = successRowV3({ analysis_result: analysisResult({ sub_scores: both }) });
  const e = errs(bundleOf([row], BUNDLE_SCHEMA_V3));
  assert.ok(e.some((x) => x.includes('must be null for a VIDEO ad')), 'a VIDEO ad must not carry a static rubric');
});

test('a v3 summary contradicting the authoritative result fails', () => {
  const row = successRowV3({ internal_qa_score: 9.9 });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('summary contradicts the authoritative result')));
});

test('v3 result blocks are covered by the sensitive-content guards', () => {
  const row = successRowV3({ analysis_result: analysisResult({ creative_analysis: 'leak sk-ant-api03-abcdefgh12345678' }) });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('API key')));
});

test('the raw-listing key guard still applies to v3 result blocks', () => {
  // The bare keys stay globally forbidden: a v3 row cannot smuggle listing metadata in
  // under `recommendations`, which is why the scorer's advice keys carry a suffix.
  const bad = clone(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)) as unknown as { rows: Array<{ analysis_result: Record<string, unknown> }> };
  bad.rows[0]!.analysis_result.headline = 'RAW HEADLINE MUST NEVER BE INGESTED';
  assert.ok(errs(bad).some((e) => e.includes('forbidden key "headline"')));
});

test('v3 non-success rows need no persistence result', () => {
  assert.deepEqual(errs(bundleOf([heldRow('REVIEW')], BUNDLE_SCHEMA_V3)), []);
  assert.deepEqual(errs(bundleOf([heldRow('SKIPPED')], BUNDLE_SCHEMA_V3)), []);
  assert.deepEqual(errs(bundleOf([heldRow('ERROR')], BUNDLE_SCHEMA_V3)), []);
});

test('a v3 held row carrying result blocks is still rejected', () => {
  const bad = { ...heldRow('REVIEW'), analysis_result: analysisResult() } as unknown as BundleRow;
  assert.ok(errs(bundleOf([bad], BUNDLE_SCHEMA_V3)).some((e) => e.includes('unrecognised field "analysis_result"')));
});

// ═══ Real scorer invariants — empty/placeholder arrays are impossible ═════════

for (const field of ['strengths', 'weaknesses'] as const) {
  test(`v3 empty ${field} fails — the scorer never emits an empty list`, () => {
    const row = successRowV3({ analysis_result: analysisResult({ [field]: [] } as Partial<BundleAnalysisResult>) });
    assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('must not be empty')));
  });
  test(`v3 blank ${field} entry fails`, () => {
    const row = successRowV3({ analysis_result: analysisResult({ [field]: ['   '] } as Partial<BundleAnalysisResult>) });
    assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('is blank')));
  });
}

test('v3 improvements must contain exactly the three the scorer emits', () => {
  for (const bad of [[], ['one'], ['a', 'b'], ['a', 'b', 'c', 'd']]) {
    const row = successRowV3({ analysis_result: analysisResult({ improvements: bad }) });
    assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('exactly 3 entries')), `${bad.length} entries must fail`);
  }
});

test('v3 whitespace-only improvement fails', () => {
  const row = successRowV3({ analysis_result: analysisResult({ improvements: ['a', '  ', 'c'] }) });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('is blank')));
});

test('a faithful real VIDEO result passes', () => {
  assert.deepEqual(errs(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), []);
});

test('a faithful real STATIC (IMAGE) result passes', () => {
  assert.deepEqual(errs(bundleOf([imageRowV3()], BUNDLE_SCHEMA_V3)), []);
});

// ═══ Media-appropriate rubric ═════════════════════════════════════════════════

test('a VIDEO row missing a video rubric score fails', () => {
  const row = successRowV3({ analysis_result: analysisResult({ sub_scores: subScores({ story_flow: null }) }) });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('story_flow is required for a VIDEO ad')));
});

test('a VIDEO row carrying a static rubric score fails', () => {
  const row = successRowV3({ analysis_result: analysisResult({ sub_scores: subScores({ visual_hierarchy: 6 }) }) });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('visual_hierarchy must be null for a VIDEO ad')));
});

test('an IMAGE row missing a static rubric score fails', () => {
  const row = imageRowV3({ analysis_result: analysisResult({ sub_scores: staticSubScores({ trust_signals: null }) }) });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('trust_signals is required for a IMAGE ad')));
});

test('an IMAGE row carrying a video rubric score fails', () => {
  const row = imageRowV3({ analysis_result: analysisResult({ sub_scores: staticSubScores({ story_flow: 6 }) }) });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('story_flow must be null for a IMAGE ad')));
});

test('a missing shared rubric score fails', () => {
  const b = clone(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)) as unknown as { rows: Array<{ analysis_result: { sub_scores: Record<string, unknown> } }> };
  delete b.rows[0]!.analysis_result.sub_scores.cta_clarity;
  assert.ok(errs(b).some((e) => e.includes('missing required field "cta_clarity"')));
});

test('a null shared rubric score fails — shared scores are always produced', () => {
  const row = successRowV3({ analysis_result: analysisResult({ sub_scores: subScores({ cta_clarity: null as unknown as number }) }) });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('sub_scores.cta_clarity')));
});

test('an unknown extra rubric key fails', () => {
  const b = clone(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)) as unknown as { rows: Array<{ analysis_result: { sub_scores: Record<string, unknown> } }> };
  b.rows[0]!.analysis_result.sub_scores.vibes = 9;
  assert.ok(errs(b).some((e) => e.includes('unrecognised field "vibes"')));
});

test('a genuine zero rubric score is preserved, not treated as missing', () => {
  const row = successRowV3({ analysis_result: analysisResult({ sub_scores: subScores({ story_flow: 0, hook_stop_scroll: 0 }) }) });
  assert.deepEqual(errs(bundleOf([row], BUNDLE_SCHEMA_V3)), []);
  const built = buildIngestPayload(row, ctx());
  assert.ok(built.ok && built.payload.analysis.storyFlowScore === 0);
  assert.ok(built.ok && JSON.parse(built.payload.analysis.rubricScoresJson).storyFlow === 0);
});

// ═══ Exhaustive summary cross-check ═══════════════════════════════════════════

const mismatches: Array<[string, () => BundleSuccessRowV3]> = [
  ['internal_qa_score', () => successRowV3({ internal_qa_score: 9.9 })],
  ['internal_qa_verdict', () => successRowV3({ internal_qa_verdict: 'STRONG_READY_TO_TEST' })],
  ['qualified', () => successRowV3({ qualified: true })],
  ['funnel_stage', () => successRowV3({ funnel_stage: 'TOFU' })],
  ['race_stage', () => successRowV3({ race_stage: 'REACH' })],
  ['trust_funnel_stage', () => successRowV3({ trust_funnel_stage: 'UNAWARE' })],
  ['aida_scores', () => successRowV3({ aida_scores: { attention: 1, interest: 6, desire: 6, action: 5 } })],
  ['component_scores.copy_score', () => successRowV3({ component_scores: { copy_score: 1, headline_score: 5, description_score: null, creative_score: 7, clarity_score: 6, connection_score: 6, conviction_score: 5 } })],
  ['component_scores.description_score', () => successRowV3({ component_scores: { copy_score: 6, headline_score: 5, description_score: 4, creative_score: 7, clarity_score: 6, connection_score: 6, conviction_score: 5 } })],
  ['behavioural_triggers', () => successRowV3({ behavioural_triggers: [{ name: 'FOMO', strength: 'STRONG' }] })],
  ['strengths', () => successRowV3({ strengths: ['Something else entirely'] })],
  ['benchmark_score', () => successRowV3({ benchmark_score: 9.9 })],
  ['benchmark_tier', () => successRowV3({ benchmark_tier: 'STRONG' })],
  ['benchmark_confidence', () => successRowV3({ benchmark_confidence: 'LOW' })],
];
for (const [label, make] of mismatches) {
  test(`a summary/result mismatch on ${label} fails the bundle`, () => {
    assert.ok(errs(bundleOf([make()], BUNDLE_SCHEMA_V3)).some((e) => e.includes('summary contradicts the authoritative result')),
      `${label} must be cross-checked`);
  });
}

test('the cross-check uses structural equality, not key order', () => {
  const reordered = successRowV3({ aida_scores: { action: 5, desire: 6, interest: 6, attention: 7 } });
  assert.deepEqual(errs(bundleOf([reordered], BUNDLE_SCHEMA_V3)), [], 'key order must not create a false mismatch');
});

// ═══ Benchmark semantics ══════════════════════════════════════════════════════

test('a tier label that does not match its token fails', () => {
  const row = successRowV3({ benchmark_result: benchmarkResult({ tier: TIER_LABEL_BY_TOKEN.STRONG }) });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('does not match the WEAK label')));
});

test('an unknown tier label fails', () => {
  const row = successRowV3({ benchmark_result: benchmarkResult({ tier: 'Quite good really' as never }) });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('canonical tier label')));
});

test('an ASSET row must carry VISION evidence and HIGH confidence', () => {
  const wrongToken = successRowV3({ benchmark_result: benchmarkResult({ evidence_token: 'NONE' }) });
  assert.ok(errs(bundleOf([wrongToken], BUNDLE_SCHEMA_V3)).some((e) => e.includes('evidence_token must be VISION')));
  const wrongConf = successRowV3({ benchmark_confidence: 'LOW', benchmark_result: benchmarkResult({ confidence: 'LOW' }) });
  assert.ok(errs(bundleOf([wrongConf], BUNDLE_SCHEMA_V3)).some((e) => e.includes('confidence must be HIGH for a ASSET row')));
});

test('an evidence label that does not match the source fails', () => {
  const row = successRowV3({ benchmark_result: benchmarkResult({ evidence_source: EVIDENCE_LABEL_BY_SOURCE.FALLBACK }) });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('evidence_source does not match')));
});

test('an ASSET row carrying a warning fails; a FALLBACK row without one fails', () => {
  const warned = successRowV3({ benchmark_result: benchmarkResult({ warning: 'spurious' }) });
  assert.ok(errs(bundleOf([warned], BUNDLE_SCHEMA_V3)).some((e) => e.includes('warning must be null for a ASSET row')));
  const unwarned = fallbackRowV3({ benchmark_result: fallbackBenchmark({ warning: null }) });
  assert.ok(errs(bundleOf([unwarned], BUNDLE_SCHEMA_V3)).some((e) => e.includes('exact FALLBACK warning')));
});

test('a faithful FALLBACK evidence mode passes', () => {
  assert.deepEqual(errs(bundleOf([fallbackRowV3()], BUNDLE_SCHEMA_V3)), []);
});

test('the breakdown must contain exactly the three entries the scorer emits', () => {
  for (const bd of [[], [{ label: 'a', value: 5, weight: 0.7 }]]) {
    const row = successRowV3({ benchmark_result: benchmarkResult({ breakdown: bd }) });
    assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('exactly 3 entries')));
  }
});

test('breakdown weights must match the formula weights for the creative source', () => {
  const row = successRowV3({
    benchmark_result: benchmarkResult({
      breakdown: [
        { label: 'AIDA avg', value: 6, weight: 0.50 },   // ASSET formula says 0.70
        { label: 'creative', value: 7, weight: 0.30 },
        { label: 'action', value: 5, weight: 0.20 },
      ],
    }),
  });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('does not match the ASSET formula weight')));
});

test('a negative or out-of-range weight fails', () => {
  const row = successRowV3({
    benchmark_result: benchmarkResult({
      breakdown: [
        { label: 'AIDA avg', value: 6, weight: -0.70 },
        { label: 'creative', value: 7, weight: 0.20 },
        { label: 'action', value: 5, weight: 0.10 },
      ],
    }),
  });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('weight must be a number between 0 and 1')));
});

test('an out-of-range breakdown value fails', () => {
  const row = successRowV3({
    benchmark_result: benchmarkResult({
      breakdown: [
        { label: 'AIDA avg', value: 99, weight: 0.70 },
        { label: 'creative', value: 7, weight: 0.20 },
        { label: 'action', value: 5, weight: 0.10 },
      ],
    }),
  });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('between 0 and 10')));
});

test('a blank breakdown label fails', () => {
  const row = successRowV3({
    benchmark_result: benchmarkResult({
      breakdown: [
        { label: '   ', value: 6, weight: 0.70 },
        { label: 'creative', value: 7, weight: 0.20 },
        { label: 'action', value: 5, weight: 0.10 },
      ],
    }),
  });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((e) => e.includes('label must be a non-empty string')));
});

// ── The blocker: combinations the real scorer could never emit ──

test('REGRESSION: the scorer-correct tier for these inputs passes', () => {
  // The default analysis inputs really produce 6.1 → WEAK, and that must be accepted.
  const b = benchmarkResult();
  assert.equal(b.benchmark_score, 6.1);
  assert.equal(b.tier_token, 'WEAK');
  assert.deepEqual(errs(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), []);
});

test('REGRESSION: the exact MODERATE threshold passes as MODERATE', () => {
  // Inputs chosen so the weighted score lands exactly on 6.5.
  const a = analysisResult({ aida_scores: { attention: 6.5, interest: 6.5, desire: 6.5, action: 6.5 }, creative_score: 6.5 });
  const row = successRowV3({
    aida_scores: a.aida_scores,
    component_scores: { copy_score: a.copy_score, headline_score: a.headline_score, description_score: a.description_score, creative_score: a.creative_score, clarity_score: a.clarity_score, connection_score: a.connection_score, conviction_score: a.conviction_score },
    analysis_result: a,
    benchmark_result: benchmarkFor('ASSET', a),
    benchmark_score: benchmarkFor('ASSET', a).benchmark_score,
    benchmark_tier: benchmarkFor('ASSET', a).tier_token,
  });
  assert.equal(benchmarkFor('ASSET', a).benchmark_score, 6.5);
  assert.equal(benchmarkFor('ASSET', a).tier_token, 'MODERATE');
  assert.deepEqual(errs(bundleOf([row], BUNDLE_SCHEMA_V3)), []);
});

// Boundary sweep: just below, exactly at, and just above every real threshold.
for (const { at, below, aboveToken, belowToken } of [
  { at: 8.0, below: 7.99, aboveToken: 'STRONG', belowToken: 'MODERATE' },
  { at: 6.5, below: 6.49, aboveToken: 'MODERATE', belowToken: 'WEAK' },
  { at: 5.0, below: 4.99, aboveToken: 'WEAK', belowToken: 'LOW' },
] as const) {
  test(`tier boundary ${at}: ${below}→${belowToken}, ${at}→${aboveToken}`, () => {
    assert.equal(deriveTierToken(below), belowToken);
    assert.equal(deriveTierToken(at), aboveToken);
    assert.equal(deriveTierToken(at + 0.01), aboveToken);
  });
}

// ── Weighted score and breakdown are verified, not merely range-checked ──

test('a changed breakdown value with an unchanged score fails', () => {
  const b = benchmarkResult();
  const tampered = benchmarkResult({ breakdown: [{ ...b.breakdown[0]!, value: 9 }, b.breakdown[1]!, b.breakdown[2]!] });
  const e = errs(bundleOf([successRowV3({ benchmark_result: tampered })], BUNDLE_SCHEMA_V3));
  assert.ok(e.some((x) => x.includes('does not match the authoritative analysis value')));
});

test('a changed score with an unchanged breakdown fails', () => {
  const row = successRowV3({ benchmark_score: 9.9, benchmark_result: benchmarkResult({ benchmark_score: 9.9 }) });
  const e = errs(bundleOf([row], BUNDLE_SCHEMA_V3));
  assert.ok(e.some((x) => x.includes('does not equal the 6.1 its own breakdown computes')));
});

test('a wrong or swapped breakdown label fails', () => {
  const b = benchmarkResult();
  const wrong = benchmarkResult({ breakdown: [{ ...b.breakdown[0]!, label: 'vibes' }, b.breakdown[1]!, b.breakdown[2]!] });
  assert.ok(errs(bundleOf([successRowV3({ benchmark_result: wrong })], BUNDLE_SCHEMA_V3)).some((x) => x.includes('label must be "AIDA avg"')));
  const swapped = benchmarkResult({ breakdown: [b.breakdown[1]!, b.breakdown[0]!, b.breakdown[2]!] });
  assert.ok(errs(bundleOf([successRowV3({ benchmark_result: swapped })], BUNDLE_SCHEMA_V3)).some((x) => x.includes('order and naming are fixed')));
});

test('the wrong creative-source weight set fails', () => {
  // FALLBACK weights on an ASSET row.
  const wrong = benchmarkResult({ breakdown: fallbackBenchmark().breakdown });
  assert.ok(errs(bundleOf([successRowV3({ benchmark_result: wrong })], BUNDLE_SCHEMA_V3)).some((x) => x.includes('formula weight')));
});

test('weights that do not sum to the formula total fail', () => {
  const b = benchmarkResult();
  const bad = benchmarkResult({ breakdown: [{ ...b.breakdown[0]!, weight: 0.1 }, b.breakdown[1]!, b.breakdown[2]!] });
  const e = errs(bundleOf([successRowV3({ benchmark_result: bad })], BUNDLE_SCHEMA_V3));
  assert.ok(e.some((x) => x.includes('weights sum to')));
});

test('a benchmark contradicting analysis_result fails even when internally consistent', () => {
  // Self-consistent: score really is the weighted sum of ITS breakdown, and the tier
  // matches that score — but the values do not come from this row's analysis.
  const fake = [
    { label: 'AIDA avg', value: 9, weight: 0.70 },
    { label: 'creative', value: 9, weight: 0.20 },
    { label: 'action', value: 9, weight: 0.10 },
  ];
  const row = successRowV3({
    benchmark_score: 9,
    benchmark_tier: 'STRONG',
    benchmark_result: benchmarkResult({
      benchmark_score: 9, tier_token: 'STRONG', tier: TIER_LABEL_BY_TOKEN.STRONG,
      breakdown: fake, recommended_use: deriveRecommendedUse('STRONG', 'HIGH'),
    }),
  });
  const e = errs(bundleOf([row], BUNDLE_SCHEMA_V3));
  assert.ok(e.some((x) => x.includes('does not match the authoritative analysis value')),
    'the breakdown must trace to analysis_result, not merely to itself');
});

// ── Formula, recommended_use and warning text ──

test('the wrong formula text fails', () => {
  for (const f of ['', 'made up formula', BENCHMARK_FORMULA_BY_SOURCE.FALLBACK]) {
    const row = successRowV3({ benchmark_result: benchmarkResult({ formula: f }) });
    assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).length > 0, `formula "${f}" must be rejected`);
  }
});

test('recommended_use must match the tier + confidence rule', () => {
  const wrong = benchmarkResult({ recommended_use: deriveRecommendedUse('STRONG', 'HIGH') });
  assert.ok(errs(bundleOf([successRowV3({ benchmark_result: wrong })], BUNDLE_SCHEMA_V3))
    .some((x) => x.includes('not the guidance the scorer emits')));
  const blank = benchmarkResult({ recommended_use: '   ' });
  assert.ok(errs(bundleOf([successRowV3({ benchmark_result: blank })], BUNDLE_SCHEMA_V3)).length > 0);
});

test('the wrong warning text fails', () => {
  const row = fallbackRowV3({ benchmark_result: fallbackBenchmark({ warning: 'something else' }) });
  assert.ok(errs(bundleOf([row], BUNDLE_SCHEMA_V3)).some((x) => x.includes('exact FALLBACK warning')));
});

// ── Every valid evidence mode ──

test('a valid ASSET benchmark passes', () => {
  assert.deepEqual(errs(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), []);
});

test('a valid MANUAL benchmark passes', () => {
  const row = successRowV3({
    ad_id: '7777777777', source_row_number: 8, media_type: 'IMAGE',
    creative_asset_path: '', creative_source: 'MANUAL', assets: [],
    copy_used_for_scoring: 'Fallback ad copy.', visual_confidence: null,
    benchmark_confidence: 'MEDIUM',
    analysis_result: analysisResult({ sub_scores: staticSubScores() }),
    benchmark_result: manualBenchmark(),
    benchmark_score: manualBenchmark().benchmark_score,
    benchmark_tier: manualBenchmark().tier_token,
  });
  assert.deepEqual(errs(bundleOf([row], BUNDLE_SCHEMA_V3)), []);
});

test('a valid FALLBACK benchmark passes', () => {
  assert.deepEqual(errs(bundleOf([fallbackRowV3()], BUNDLE_SCHEMA_V3)), []);
});

test('an all-zero analysis produces a valid LOW-tier benchmark', () => {
  const zero = analysisResult({
    aida_scores: { attention: 0, interest: 0, desire: 0, action: 0 },
    creative_score: 0, copy_score: 0,
  });
  const bm = benchmarkFor('ASSET', zero);
  assert.equal(bm.benchmark_score, 0);
  assert.equal(bm.tier_token, 'LOW');
  const row = successRowV3({
    aida_scores: zero.aida_scores,
    component_scores: { copy_score: 0, headline_score: zero.headline_score, description_score: zero.description_score, creative_score: 0, clarity_score: zero.clarity_score, connection_score: zero.connection_score, conviction_score: zero.conviction_score },
    analysis_result: zero, benchmark_result: bm,
    benchmark_score: bm.benchmark_score, benchmark_tier: bm.tier_token,
  });
  assert.deepEqual(errs(bundleOf([row], BUNDLE_SCHEMA_V3)), []);
});

// ── Scorer and validator share one contract ──

// ── Executable parity: the REAL scorer's output must satisfy the REAL validator ──
//
// This calls the production scoreCompetitorBenchmarkAd() and feeds its actual return
// value through the schema-v3 validator. Nothing here recomputes or predicts the
// benchmark: the scorer decides, and the validator judges. An earlier version of this
// test only exercised the contract helpers, which proved the contract agrees with
// itself — not that the shipping scorer does.

/** A complete, valid AnalysisOutput. Only aidaScores/creativeScore/copyScore reach the scorer. */
function analysisOutputFixture(over: Partial<AnalysisOutput> = {}): AnalysisOutput {
  return {
    overallScore: 6.2,
    qualified: false,
    subScores: {
      hookStopScroll: 7, audienceRelevance: 6, valueClarity: 6, trustProofStrength: 5, ctaClarity: 6,
      firstThreeSeconds: 7, soundOffDesign: 6, soundOnEnhancement: 5, onScreenText: 6,
      storyFlow: 6, authenticity: 7, platformNativeFeel: 6,
    },
    creativeAnalysis: 'The frames show a sofa in a styled living room.',
    copyAnalysis: 'Copy leads with comfort and a seasonal offer.',
    headlineAnalysis: 'Headline scored 5.0/10.',
    descriptionAnalysis: 'Description not provided. No score assigned.',
    aida: { attention: 'Strong opening frame.', interest: 'Benefit lands.', desire: 'Offer is clear.', action: 'CTA present.' },
    funnelStage: 'MOFU',
    raceStage: 'ACT',
    strengths: ['Clear product shot'],
    weaknesses: ['Hook is slow'],
    improvements: ['Lead with the offer.', 'Name the outcome.', 'Cut to product sooner.'],
    copyScore: 6,
    headlineScore: 5,
    descriptionScore: null,
    creativeScore: 7,
    aidaScores: { attention: 7, interest: 6, desire: 6, action: 5 },
    aidaExplanations: { attention: 'Strong opening frame.', interest: 'Benefit lands.', desire: 'Offer is clear.', action: 'CTA present.' },
    clarityScore: 6,
    connectionScore: 6,
    convictionScore: 5,
    trustFunnelStage: 'SOLUTION_AWARE',
    behaviouralTriggers: [{ name: 'Value', strength: 'MODERATE' }],
    recommendations: {
      copy: 'Lead with the offer.', headline: 'Name the outcome.', description: 'Add proof.',
      creative: 'Cut to product sooner.', conversionStrength: 'Moderate overall.',
    },
    rewriteDirection: { hook: 'Open on the sofa.', body: 'State the benefit.', cta: 'Shop the sale.', creativeDirection: 'Tighter cuts.' },
    finalVerdict: 'GOOD_NEEDS_SHARPENING',
    ...over,
  };
}

/** Shape conversion only (camelCase → snake_case), exactly as the preview writer does. */
function toResultBlock(a: AnalysisOutput, subs: BundleSubScores): BundleAnalysisResult {
  return {
    overall_score: a.overallScore,
    qualified: a.qualified,
    sub_scores: subs,
    creative_analysis: a.creativeAnalysis,
    copy_analysis: a.copyAnalysis,
    headline_analysis: a.headlineAnalysis,
    description_analysis: a.descriptionAnalysis,
    aida: { ...a.aida },
    aida_explanations: { ...a.aidaExplanations },
    aida_scores: { ...a.aidaScores },
    funnel_stage: a.funnelStage,
    race_stage: a.raceStage,
    trust_funnel_stage: a.trustFunnelStage,
    strengths: [...a.strengths],
    weaknesses: [...a.weaknesses],
    improvements: [...a.improvements],
    copy_score: a.copyScore,
    headline_score: a.headlineScore,
    description_score: a.descriptionScore,
    creative_score: a.creativeScore,
    clarity_score: a.clarityScore,
    connection_score: a.connectionScore,
    conviction_score: a.convictionScore,
    behavioural_triggers: a.behaviouralTriggers.map((t) => ({ name: t.name, strength: t.strength })),
    recommendations: {
      copy: a.recommendations.copy,
      headline_recommendation: a.recommendations.headline,
      description_recommendation: a.recommendations.description,
      creative: a.recommendations.creative,
      conversion_strength: a.recommendations.conversionStrength,
    },
    rewrite_direction: a.rewriteDirection
      ? { hook: a.rewriteDirection.hook, body: a.rewriteDirection.body, cta: a.rewriteDirection.cta, creative_direction: a.rewriteDirection.creativeDirection }
      : null,
    final_verdict: a.finalVerdict,
  };
}

/** Shape conversion only — the scorer's own numbers and strings, verbatim. */
function toBenchmarkBlock(b: CompetitorBenchmark): BundleBenchmarkResult {
  return {
    benchmark_score: b.benchmarkScore,
    tier: b.tier,
    tier_token: b.tierToken,
    confidence: b.confidence,
    evidence_source: b.evidenceSource,
    evidence_token: b.evidenceToken,
    recommended_use: b.recommendedUse,
    formula: b.formula,
    breakdown: b.breakdown.map((x) => ({ label: x.label, value: x.value, weight: x.weight })),
    warning: b.warning,
  };
}

/** Where each creative source binds in the synthetic CSV, and how it is scored. */
const PARITY_ROWS = {
  ASSET: { ad_id: '1111111111', source_row_number: 2, media_type: 'VIDEO', creative_asset_path: ASSET_REL, copy_used_for_scoring: 'Some advertiser ad copy.', visual_confidence: 'HIGH' as const, assets: [{ filename: 'frame-01.png', sha256: sha256Buffer(FRAME), bytes: FRAME.length }], subs: () => subScores() },
  MANUAL: { ad_id: '7777777777', source_row_number: 8, media_type: 'IMAGE', creative_asset_path: '', copy_used_for_scoring: 'Fallback ad copy.', visual_confidence: null, assets: [], subs: () => staticSubScores() },
  FALLBACK: { ad_id: '8888888888', source_row_number: 9, media_type: 'IMAGE', creative_asset_path: '', copy_used_for_scoring: 'No link copy.', visual_confidence: null, assets: [], subs: () => staticSubScores() },
} as const;

/** Builds a v3 row from the PRODUCTION scorer's actual output for `source`. */
function rowFromRealScorer(source: 'ASSET' | 'MANUAL' | 'FALLBACK', a: AnalysisOutput): BundleSuccessRowV3 {
  const scored = scoreCompetitorBenchmarkAd(a, source);   // ← the production scorer
  const spec = PARITY_ROWS[source];
  const R = toResultBlock(a, spec.subs());
  return {
    ad_id: spec.ad_id,
    source_row_number: spec.source_row_number,
    source_status: 'READY',
    media_type: spec.media_type,
    creative_asset_path: spec.creative_asset_path,
    creative_source: source,
    assets: [...spec.assets],
    copy_used_for_scoring: spec.copy_used_for_scoring,
    analysis_status: 'SUCCESS',
    error_reason: null,
    visual_description: 'A sofa across the frames.',
    visual_confidence: spec.visual_confidence,
    creative_notes: 'Attention 7/10.',
    aida_scores: { ...a.aidaScores },
    component_scores: {
      copy_score: a.copyScore, headline_score: a.headlineScore, description_score: a.descriptionScore,
      creative_score: a.creativeScore, clarity_score: a.clarityScore,
      connection_score: a.connectionScore, conviction_score: a.convictionScore,
    },
    internal_qa_score: a.overallScore,
    internal_qa_verdict: a.finalVerdict,
    qualified: a.qualified,
    // Summary mirrors the SCORER's values — not a prediction of them.
    benchmark_score: scored.benchmarkScore,
    benchmark_tier: scored.tierToken,
    benchmark_confidence: scored.confidence,
    funnel_stage: a.funnelStage,
    race_stage: a.raceStage,
    trust_funnel_stage: a.trustFunnelStage,
    behavioural_triggers: a.behaviouralTriggers.map((t) => ({ name: t.name, strength: t.strength })),
    strengths: [...a.strengths],
    analysis_result: R,
    benchmark_result: toBenchmarkBlock(scored),
  } as BundleSuccessRowV3;
}

for (const source of ['ASSET', 'MANUAL', 'FALLBACK'] as const) {
  test(`PARITY: real scoreCompetitorBenchmarkAd() output for ${source} passes the schema-v3 validator`, () => {
    const a = analysisOutputFixture();
    const row = rowFromRealScorer(source, a);
    // Sanity: the scorer really did produce this, and the validator really is judging it.
    assert.equal(row.benchmark_result.evidence_token, EVIDENCE_TOKEN_BY_SOURCE[source]);
    assert.deepEqual(errs(bundleOf([row], BUNDLE_SCHEMA_V3)), [],
      `the shipping scorer's ${source} output must be accepted verbatim`);
  });

  test(`PARITY: a mutated ${source} scorer value is rejected by the validator`, () => {
    const a = analysisOutputFixture();
    const good = rowFromRealScorer(source, a);
    // Bump the tier one band up while leaving the scorer's score untouched.
    const mutated = {
      ...good,
      benchmark_tier: 'STRONG',
      benchmark_result: { ...good.benchmark_result, tier_token: 'STRONG' as const, tier: TIER_LABEL_BY_TOKEN.STRONG },
    } as BundleSuccessRowV3;
    assert.ok(errs(bundleOf([mutated], BUNDLE_SCHEMA_V3)).some((e) => e.includes('does not match the tier a score of')),
      'a semantic value the scorer did not produce must be rejected');
  });
}

/**
 * Inputs the PRODUCTION scorer turns into exactly 6.4: every ASSET term is 6.4, so
 * 6.4×0.70 + 6.4×0.20 + 6.4×0.10 = 6.4. The score is the scorer's, never ours.
 */
const scored64Analysis = () => analysisOutputFixture({
  aidaScores: { attention: 6.4, interest: 6.4, desire: 6.4, action: 6.4 },
  creativeScore: 6.4,
  copyScore: 6.4,
});

test('PARITY: a genuinely scored 6.4 is WEAK, and the validator accepts it', () => {
  const a = scored64Analysis();
  const scored = scoreCompetitorBenchmarkAd(a, 'ASSET');
  assert.equal(scored.benchmarkScore, 6.4, 'the production scorer must genuinely produce 6.4');
  assert.equal(scored.tierToken, 'WEAK', '6.4 is below the 6.5 MODERATE threshold');
  assert.deepEqual(errs(bundleOf([rowFromRealScorer('ASSET', a)], BUNDLE_SCHEMA_V3)), [],
    'a real 6.4/WEAK benchmark is valid — only 6.4-labelled-MODERATE is impossible');
});

test('REGRESSION: a genuinely scored 6.4 labelled MODERATE fails on the threshold alone', () => {
  // Start from a row the validator ACCEPTS, so the only defect we then introduce is the
  // tier label. The earlier version of this test overrode the score to 6.4 on a row whose
  // breakdown computed 6.1, so it could have failed for the score/breakdown mismatch
  // instead of the threshold — it never isolated the rule it claimed to test.
  const a = scored64Analysis();
  const valid = rowFromRealScorer('ASSET', a);
  assert.equal(valid.benchmark_result.benchmark_score, 6.4);
  assert.equal(valid.benchmark_result.tier_token, 'WEAK');
  assert.deepEqual(errs(bundleOf([valid], BUNDLE_SCHEMA_V3)), [], 'the starting row must be valid');

  // Mutate ONLY the tier: the summary token, the authoritative token, and its label —
  // consistently, so the summary cross-check cannot fire first. Everything else (score,
  // breakdown values/labels/weights, formula, evidence, confidence, warning,
  // recommended_use and the whole analysis_result) is the scorer's, untouched.
  const mislabelled = clone(valid);
  mislabelled.benchmark_tier = 'MODERATE';
  mislabelled.benchmark_result.tier_token = 'MODERATE';
  mislabelled.benchmark_result.tier = TIER_LABEL_BY_TOKEN.MODERATE;

  const e = errs(bundleOf([mislabelled], BUNDLE_SCHEMA_V3));
  assert.ok(e.some((x) => x.includes('does not match the tier a score of 6.4 earns (WEAK)')),
    'the validator must reject the tier because a score of 6.4 earns WEAK');

  // Isolation: it must NOT be rejected for anything else.
  assert.equal(mislabelled.benchmark_result.benchmark_score, 6.4, 'the score was never touched');
  assert.ok(!e.some((x) => x.includes('its own breakdown computes')), 'the score must still agree with its breakdown');
  assert.ok(!e.some((x) => x.includes('summary contradicts')), 'the summary must stay consistent with the result');
  assert.ok(!e.some((x) => x.includes('recommended_use')), 'the guidance must not be a second defect');
  assert.ok(!e.some((x) => x.includes('breakdown[')), 'the breakdown must be untouched');
  assert.ok(e.every((x) => x.includes('tier')), `the ONLY defect must be the tier: ${e.join(' | ')}`);
});

test('no scoring behaviour regression: the contract reproduces the documented arithmetic', () => {
  const a = analysisResult();   // AIDA 7/6/6/5 → avg 6.0; creative 7; copy 6; action 5
  const asset = benchmarkFor('ASSET', a);
  assert.equal(asset.benchmark_score, 6.1, '6.0×0.70 + 7×0.20 + 5×0.10');
  const manual = benchmarkFor('MANUAL', a);
  assert.equal(manual.benchmark_score, 6.3, '7×0.50 + 6×0.30 + 5×0.20');
  assert.equal(fallbackBenchmark().benchmark_score, 6.3, 'FALLBACK uses the same arithmetic as MANUAL');
  // Rounding is clamp + 2dp.
  assert.equal(roundBenchmarkScore(11), 10);
  assert.equal(roundBenchmarkScore(-1), 0);
  assert.equal(roundBenchmarkScore(6.126), 6.13);
});

test('the bundle validator has no runtime import of the scorer', () => {
  const imports = importsOf('lib/analysis/browserAnalysisBundle.ts');
  assert.ok(!imports.some((i) => i.includes('competitorScoring')), 'benchmark rules come from the pure contract, not the scorer');
  assert.ok(imports.some((i) => i.includes('benchmarkContract')));
  // And the contract itself imports nothing at all.
  assert.deepEqual(importsOf('lib/analysis/benchmarkContract.ts'), []);
});

// ═══ Persistence gate ═════════════════════════════════════════════════════════

test('v2 is never persistable, with a precise reason', () => {
  const b = bundleOf([successRowV2()], BUNDLE_SCHEMA_V2);
  const d = decidePersistence(b, b.rows[0]!);
  assert.equal(d.persistable, false);
  if (!d.persistable) {
    assert.match(d.reason, /schema v2/);
    assert.match(d.reason, /SUMMARY only/);
    assert.match(d.reason, /never recomputed/);
  }
});

test('v3 SUCCESS is persistable', () => {
  const b = bundleOf([successRowV3()], BUNDLE_SCHEMA_V3);
  assert.equal(decidePersistence(b, b.rows[0]!).persistable, true);
});

test('LOW visual confidence is never persistable', () => {
  const b = bundleOf([successRowV3({ visual_confidence: 'LOW' })], BUNDLE_SCHEMA_V3);
  const d = decidePersistence(b, b.rows[0]!);
  assert.equal(d.persistable, false);
  if (!d.persistable) assert.match(d.reason, /LOW visual confidence/);
});

for (const s of ['REVIEW', 'SKIPPED', 'ERROR'] as const) {
  test(`a ${s} row is never persistable`, () => {
    const b = bundleOf([heldRow(s)], BUNDLE_SCHEMA_V3);
    assert.equal(decidePersistence(b, b.rows[0]!).persistable, false);
  });
}

// ═══ Mapping ══════════════════════════════════════════════════════════════════

const ctx = (over: Partial<IngestPayloadContext> = {}): IngestPayloadContext => ({
  competitorId: 'cmp1', clientId: 'cli1', industryId: 'ind1',
  productOrService: 'Castlery',
  adLink: 'https://example.test/ad/1',
  activeSince: new Date('2026-01-02T00:00:00.000Z'),
  primaryCopy: 'Some advertiser ad copy.',
  capturedAssetType: 'VIDEO_FRAME',
  verifiedMeta: { headline: 'Verified headline', headline_status: 'ACCEPT', description: 'Held description', description_status: 'REVIEW' },
  adSource: 'browser_collected',
  now: INGEST_NOW,
  benchmarkScoredAt: new Date(BUNDLE_CREATED_AT),
  ...over,
});

const built = () => {
  const r = buildIngestPayload(successRowV3(), ctx());
  assert.ok(r.ok, r.ok ? '' : r.reason);
  return r.ok ? r.payload : (undefined as never);
};

test('every required non-null AdAnalysis field is mapped from the bundle', () => {
  const { analysis } = built();
  for (const f of REQUIRED_AD_ANALYSIS_FIELDS) {
    const v = (analysis as unknown as Record<string, unknown>)[f];
    assert.ok(v !== undefined && v !== null, `${f} must be present`);
    if (typeof v === 'string') assert.notEqual(v.trim(), '', `${f} must never be an empty string`);
  }
});

test('the four analysis texts are preserved exactly', () => {
  const { analysis } = built();
  const R = analysisResult();
  assert.equal(analysis.creativeAnalysis, R.creative_analysis);
  assert.equal(analysis.copyAnalysis, R.copy_analysis);
  assert.equal(analysis.headlineAnalysis, R.headline_analysis);
  assert.equal(analysis.descriptionAnalysis, R.description_analysis);
});

test('strengths, weaknesses and improvements are preserved exactly', () => {
  const { analysis } = built();
  assert.deepEqual(JSON.parse(analysis.strengthsJson), ['Clear product shot', 'Consistent branding']);
  assert.deepEqual(JSON.parse(analysis.weaknessesJson), ['Hook is slow', 'No urgency']);
  assert.deepEqual(JSON.parse(analysis.improvementsJson), ['Lead with the offer.', 'Name the outcome.', 'Cut to product sooner.']);
});

test('the full rubric is preserved and round-trips the scorer object exactly', () => {
  const { analysis } = built();
  const rubric = JSON.parse(analysis.rubricScoresJson) as Record<string, number>;
  // Shared + video keys present; static keys absent exactly as the scorer produced.
  assert.equal(rubric.hookStopScroll, 7);
  assert.equal(rubric.firstThreeSeconds, 7);
  assert.equal(rubric.platformNativeFeel, 6);
  assert.ok(!('visualHierarchy' in rubric), 'a key the scorer never produced must not appear');
  assert.ok(!Object.values(rubric).some((v) => v === null), 'the rubric must not carry nulls');
  // And the individual columns carry the same values, null where genuinely absent.
  assert.equal(analysis.firstThreeSecondsScore, 7);
  assert.equal(analysis.visualHierarchyScore, null);
});

test('JSON fields contain computed values, never placeholders', () => {
  const { analysis } = built();
  assert.deepEqual(JSON.parse(analysis.aidaJson), analysisResult().aida);
  assert.deepEqual(JSON.parse(analysis.behaviouralTriggersJson), [{ name: 'Value', strength: 'MODERATE' }]);
  assert.equal(JSON.parse(analysis.recommendationsJson).conversionStrength, 'Moderate overall.');
  const bb = JSON.parse(analysis.benchmarkBreakdownJson) as { formula: string; breakdown: unknown[] };
  assert.equal(bb.formula, benchmarkResult().formula);
  assert.deepEqual(bb.breakdown, benchmarkResult().breakdown, 'the real computed breakdown is persisted verbatim');
  for (const j of [analysis.strengthsJson, analysis.weaknessesJson, analysis.improvementsJson, analysis.rubricScoresJson]) {
    assert.notEqual(j, '[]');
    assert.notEqual(j, '{}');
    assert.notEqual(j, '""');
  }
});

test('rewriteDirectionJson is null ONLY when the scorer produced none', () => {
  assert.ok(built().analysis.rewriteDirectionJson !== null);
  const r = buildIngestPayload(successRowV3({ analysis_result: analysisResult({ rewrite_direction: null }) }), ctx());
  assert.ok(r.ok && r.payload.analysis.rewriteDirectionJson === null);
});

test('nullable score columns are null only when genuinely absent', () => {
  const { analysis } = built();
  assert.equal(analysis.descriptionScore, null, 'the scorer produced no description score');
  assert.equal(analysis.headlineScore, 5);
  assert.equal(analysis.copyScore, 6);
});

test('only ACCEPT verified metadata reaches the write payload', () => {
  const { ad } = built();
  assert.equal(ad.headline, 'Verified headline');
  assert.equal(ad.description, null, 'a REVIEW sidecar value must never be promoted');
});

test('no verified metadata at all leaves both advertiser fields blank', () => {
  const r = buildIngestPayload(successRowV3(), ctx({ verifiedMeta: null }));
  assert.ok(r.ok && r.payload.ad.headline === null && r.payload.ad.description === null);
});

test('raw CSV headline and description can never reach the payload', () => {
  const r = buildIngestPayload(successRowV3(), ctx({ verifiedMeta: null }));
  assert.ok(r.ok);
  const json = JSON.stringify(r.ok ? r.payload : {});
  assert.ok(!json.includes('RAW HEADLINE'), 'raw listing headline must never be ingested');
  assert.ok(!json.includes('RAW DESCRIPTION'), 'raw listing description must never be ingested');
});

test('Ad benchmark and evidence fields map mechanically from the bundle', () => {
  const { ad } = built();
  assert.equal(ad.score, 6.2);
  assert.equal(ad.qualified, false);
  assert.equal(ad.competitorBenchmarkScore, 6.1, 'the real scorer computes 6.1 from these inputs');
  assert.equal(ad.benchmarkTier, 'WEAK', '6.1 is below the 6.5 MODERATE threshold');
  assert.equal(ad.benchmarkConfidence, 'HIGH');
  assert.equal(ad.evidenceSource, 'VISION');
  assert.equal(ad.creativeSource, 'ASSET');
  assert.equal(ad.adFormat, 'VIDEO');
  assert.equal(ad.reviewStatus, 'PENDING');
  assert.equal(ad.adStatus, 'ACTIVE');
});

test('adFormat derivation is mechanical', () => {
  assert.equal(deriveAdFormat('IMAGE'), 'STATIC');
  assert.equal(deriveAdFormat('CAROUSEL'), 'STATIC');
  assert.equal(deriveAdFormat('VIDEO'), 'VIDEO');
  assert.equal(deriveAdFormat('GIF'), null);
});

test('an underivable media type fails rather than guessing', () => {
  const r = buildIngestPayload(successRowV3({ media_type: 'GIF' } as Partial<BundleSuccessRowV3>), ctx());
  assert.ok(!r.ok && r.reason.includes('cannot derive adFormat'));
});

test('blank scored copy becomes null, never an empty string', () => {
  const r = buildIngestPayload(successRowV3(), ctx({ primaryCopy: '' }));
  assert.ok(r.ok && r.payload.ad.primaryCopy === null);
});

test('subScoresToJson drops nulls and keeps real zeros', () => {
  const json = JSON.parse(subScoresToJson(subScores({ hook_stop_scroll: 0 }))) as Record<string, number>;
  assert.equal(json.hookStopScroll, 0, 'a genuine 0 must survive');
  assert.ok(!('visualHierarchy' in json));
});

// ═══ Orchestration — the database is a fake that counts every call ════════════

test('a missing bundle path fails closed with zero database calls', async () => {
  const { getDb, calls } = fakeDb();
  const r = await run(undefined, LIVE, getDb);
  assert.ok(!r.ok && r.errors.some((e) => e.includes('BROWSER_ANALYSIS_BUNDLE is required')));
  assert.equal(totalDbCalls(calls), 0);
});

test('an unreadable bundle fails closed with zero database calls', async () => {
  const { getDb, calls } = fakeDb();
  const r = await run(path.join(ROOT, 'no-such.bundle.json'), LIVE, getDb);
  assert.ok(!r.ok && r.errors.some((e) => e.includes('Bundle rejected')));
  assert.equal(totalDbCalls(calls), 0);
});

test('an invalid bundle fails closed with zero database calls', async () => {
  const bad = clone(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3));
  bad.counts.success = 99;
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bad), LIVE, getDb);
  assert.ok(!r.ok && r.errors.some((e) => e.includes('Bundle rejected')));
  assert.equal(totalDbCalls(calls), 0);
});

test('a stale source checksum fails closed with zero database calls', async () => {
  const stale = bundleOf([successRowV3()], BUNDLE_SCHEMA_V3, { source_csv_sha256: 'a'.repeat(64) });
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(stale), LIVE, getDb);
  assert.ok(!r.ok && r.errors.some((e) => e.includes('checksum mismatch')));
  assert.equal(totalDbCalls(calls), 0);
});

test('a source-path mismatch fails closed with zero database calls', async () => {
  const other = `${CSV_REL.replace('.csv', '')}-other.csv`;
  fs.writeFileSync(path.join(ROOT, other), CSV_BODY, 'utf-8');
  const b = bundleOf([successRowV3()], BUNDLE_SCHEMA_V3, { source_csv_path: other });
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(b), LIVE, getDb);
  assert.ok(!r.ok && r.errors.some((e) => e.includes('Source identity mismatch')));
  assert.equal(totalDbCalls(calls), 0);
});

test('an asset-integrity failure fails closed with zero database calls', async () => {
  const tampered = successRowV3({ assets: [{ filename: 'frame-01.png', sha256: 'd'.repeat(64), bytes: FRAME.length }] });
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf([tampered], BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(!r.ok && r.errors.some((e) => e.includes('asset checksum mismatch')));
  assert.equal(totalDbCalls(calls), 0);
});

test('a declared sidecar that drifted fails closed with zero database calls', async () => {
  const b = bundleOf([successRowV3()], BUNDLE_SCHEMA_V3, {
    verified_meta_path: SIDECAR_REL, verified_meta_sha256: 'c'.repeat(64),
  });
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(b), LIVE, getDb);
  assert.ok(!r.ok && r.errors.some((e) => e.includes('verified-metadata checksum mismatch')));
  assert.equal(totalDbCalls(calls), 0);
});

test('a v2 bundle reaches zero database calls and never writes', async () => {
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf([successRowV2()], BUNDLE_SCHEMA_V2)), LIVE, getDb);
  assert.ok(!r.ok, 'a v2 bundle must not authorise a live write');
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('cannot authorise any INSERT')));
  assert.equal(totalDbCalls(calls), 0);
});

test('a v2 bundle plans in dry-run and blocks the would-be writable row', async () => {
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf([successRowV2()], BUNDLE_SCHEMA_V2)), DRY, getDb);
  assert.ok(r.ok);
  if (!r.ok) return;
  const row = r.rows.find((x) => x.adId === '1111111111')!;
  assert.equal(row.outcome, 'BLOCKED_SCHEMA');
  assert.match(row.reason, /schema v2/);
  assert.equal(row.payload, undefined, 'a blocked row must carry no write payload');
  assert.equal(totalDbCalls(calls), 0);
});

test('missing live-write flags produce zero database calls', async () => {
  const p = writeBundleFile(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3));
  for (const flags of [
    { dryRun: false, writeFlag: false, confirmFlag: 'I_UNDERSTAND' },
    { dryRun: false, writeFlag: true, confirmFlag: undefined },
    { dryRun: false, writeFlag: true, confirmFlag: 'yes' },
  ]) {
    const { getDb, calls } = fakeDb();
    const r = await run(p, flags as typeof LIVE, getDb);
    assert.ok(!r.ok, `flags ${JSON.stringify(flags)} must not authorise a write`);
    assert.equal(totalDbCalls(calls), 0);
  }
});

test('all three live-write flags are necessary and sufficient', async () => {
  const p = writeBundleFile(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3));
  const { getDb, calls } = fakeDb();
  const r = await run(p, LIVE, getDb);
  assert.ok(r.ok);
  assert.equal(calls.insert, 1);
});

test('a dry run produces zero database calls and zero writes', async () => {
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), DRY, getDb);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.inserted, 0);
  assert.equal(totalDbCalls(calls), 0, 'dry run must never contact the database');
  assert.equal(r.rows.find((x) => x.adId === '1111111111')!.outcome, 'WOULD_INSERT');
});

test('a new v3 SUCCESS row inserts exactly one Ad + AdAnalysis', async () => {
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.inserted, 1);
  assert.equal(calls.insert, 1);
  assert.equal(calls.inserted.length, 1);
  assert.equal(calls.inserted[0]!.ad.metaAdId, '1111111111');
  assert.equal(calls.inserted[0]!.ad.competitorId, 'cmp1', 'the resolved competitor must be applied');
  assert.equal(calls.inserted[0]!.analysis.creativeAnalysis, analysisResult().creative_analysis);
  assert.equal(r.rows.find((x) => x.adId === '1111111111')!.outcome, 'INSERTED');
});

test('duplicate detection runs BEFORE any insert, and a duplicate never updates', async () => {
  const { getDb, calls } = fakeDb({ existing: ['1111111111'] });
  const r = await run(writeBundleFile(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(calls.findExisting, 1);
  assert.equal(calls.insert, 0, 'a duplicate must never be inserted');
  assert.equal(r.inserted, 0);
  const row = r.rows.find((x) => x.adId === '1111111111')!;
  assert.equal(row.outcome, 'SKIPPED_EXISTING');
  assert.equal(row.payload, undefined);
});

test('there is no UPDATE path at all', async () => {
  const { db: dbShape, getDb, calls } = fakeDb({ existing: ['1111111111'] });
  const r = await run(writeBundleFile(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(!r.rows.some((x) => (x.outcome as string) === 'UPDATE' || (x.outcome as string) === 'UPDATED'));
  assert.equal(Object.keys(dbShape).includes('updateAd'), false, 'the database boundary exposes no update operation');
  assert.equal(calls.insert, 0);
});

test('only an exact ad id deduplicates', async () => {
  const { getDb, calls } = fakeDb({ existing: ['111'] });   // substring of the real id
  const r = await run(writeBundleFile(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(r.ok);
  assert.equal(calls.insert, 1, 'a substring must not count as a duplicate');
});

test('held rows never write, and never block a valid row', async () => {
  // Each held row must bind to its real CSV row: whole-bundle validation checks that.
  const rows: BundleRow[] = [
    successRowV3(),
    heldRow('REVIEW'),
    heldRow('SKIPPED', { ad_id: '4444444444', source_row_number: 5, source_status: 'UNAVAILABLE', copy_used_for_scoring: 'gone copy' }),
    heldRow('SKIPPED', { ad_id: '5555555555', source_row_number: 6, source_status: 'SKIP', copy_used_for_scoring: 'skip copy' }),
    heldRow('ERROR', {
      ad_id: '2222222222', source_row_number: 3, source_status: 'READY', media_type: 'VIDEO',
      creative_asset_path: ASSET_REL, copy_used_for_scoring: 'Second ad copy.',
    }),
  ];
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf(rows, BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(r.ok);
  if (!r.ok) return;
  const by = (id: string) => r.rows.find((x) => x.adId === id)!;
  assert.equal(by('1111111111').outcome, 'INSERTED');
  assert.equal(by('3333333333').outcome, 'REVIEW');
  assert.equal(by('4444444444').outcome, 'UNAVAILABLE');
  assert.equal(by('5555555555').outcome, 'SKIPPED');
  assert.equal(by('2222222222').outcome, 'ERROR');
  assert.equal(calls.insert, 1, 'only the one valid row may be written');
  assert.equal(r.inserted, 1);
});

test('a LOW visual confidence row is REVIEW and never written', async () => {
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf([successRowV3({ visual_confidence: 'LOW' })], BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.rows[0]!.outcome, 'REVIEW');
  assert.equal(calls.insert, 0);
  assert.equal(r.inserted, 0);
});

test('a source row with no bundle entry becomes REVIEW and is never analysed', async () => {
  // Bundle covers only ad 2222222222; ad 1111111111 is READY in the CSV but absent.
  const only2 = successRowV3({
    ad_id: '2222222222', source_row_number: 3, copy_used_for_scoring: 'Second ad copy.',
  });
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf([only2], BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(r.ok);
  if (!r.ok) return;
  const missing = r.rows.find((x) => x.adId === '1111111111')!;
  assert.equal(missing.outcome, 'REVIEW');
  assert.match(missing.reason, /no analysis found in bundle/);
  assert.equal(calls.insert, 1, 'only the ad the bundle covers is written');
});

test('per-row source-identity drift fails the whole run before any database call', async () => {
  // Part 1's whole-bundle source binding catches drift at load, which is stricter than
  // routing the row to ERROR: nothing is planned and the database is never contacted.
  const drifted = successRowV3({ copy_used_for_scoring: 'copy that does not match the CSV row' });
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf([drifted], BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(!r.ok, 'a drifted bundle must never reach write planning');
  if (r.ok) return;
  assert.ok(r.errors.some((e) => /does not match|mismatch/i.test(e)));
  assert.equal(totalDbCalls(calls), 0);
});

test('the planner still routes an individual drifted row to ERROR (defence in depth)', () => {
  // The bundle-level check above normally fires first; this proves the per-row rule
  // underneath it is intact and can never turn drift into a write.
  const b = bundleOf([successRowV3({ copy_used_for_scoring: 'drifted' })], BUNDLE_SCHEMA_V3);
  const identity = {
    ad_id: '1111111111', source_row_number: 2, source_status: 'READY', media_type: 'VIDEO',
    creative_asset_path: ASSET_REL, copy_used_for_scoring: 'Some advertiser ad copy.',
  };
  const p = planIngestion([identity], b);
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(p.plan[0]!.action, 'ERROR');
  assert.match(p.plan[0]!.reason, /does not match the source CSV row/);
});

test('one failed insert does not falsify another row', async () => {
  const two: BundleRow[] = [
    successRowV3(),
    successRowV3({ ad_id: '2222222222', source_row_number: 3, copy_used_for_scoring: 'Second ad copy.' }),
  ];
  const { getDb, calls } = fakeDb({ failOn: '1111111111' });
  const r = await run(writeBundleFile(bundleOf(two, BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.rows.find((x) => x.adId === '1111111111')!.outcome, 'WRITE_ERROR');
  assert.equal(r.rows.find((x) => x.adId === '2222222222')!.outcome, 'INSERTED');
  assert.equal(r.inserted, 1);
  assert.equal(r.writeErrors, 1);
  assert.equal(calls.inserted.length, 1);
});

test('a write-time unique-constraint collision becomes SKIPPED_EXISTING, not an error', async () => {
  const { db, calls } = fakeDb();
  const boom: IngestDb = { ...db, async insertAdWithAnalysis() { calls.insert++; throw new Error('Unique constraint failed on the fields: (`metaAdId`)'); } };
  const r = await run(writeBundleFile(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), LIVE, async () => boom);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.rows[0]!.outcome, 'SKIPPED_EXISTING');
  assert.equal(r.writeErrors, 0);
});

test('a mixed-competitor CSV is refused before any database call', async () => {
  const mixedRel = 'data/imports/mixed.with-assets.csv';
  const mixedBody = `${CSV_HEADER}\n${CSV_ROWS[0]}\n6666666666,READY,IMAGE,,copy,Other,PAGE2,https://example.test/ad/6,,,\n`;
  fs.writeFileSync(path.join(ROOT, mixedRel), mixedBody, 'utf-8');
  const b = bundleOf([successRowV3()], BUNDLE_SCHEMA_V3, {
    source_csv_path: mixedRel,
    source_csv_sha256: sha256Buffer(Buffer.from(mixedBody, 'utf-8')),
    counts: { input_rows: 2, selected_rows: 1, success: 1, review: 0, skipped: 0, failed: 0 },
  });
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(b), LIVE, getDb, { csvPath: path.join(ROOT, mixedRel) });
  assert.ok(!r.ok && r.errors.some((e) => e.includes('different competitors')));
  assert.equal(totalDbCalls(calls), 0);
});

// ═══ Sidecar is bound to the bundle's declaration ═════════════════════════════
//
// The canonical sidecar (SIDECAR_REL) EXISTS beside the CSV throughout these tests, so
// "undeclared ⇒ unused" is a real assertion, not a vacuous one.

const declaredSidecarBundle = (over: Partial<BrowserAnalysisBundle> = {}) =>
  bundleOf([successRowV3()], BUNDLE_SCHEMA_V3, {
    verified_meta_path: SIDECAR_REL,
    verified_meta_sha256: sha256Buffer(fs.readFileSync(path.join(ROOT, SIDECAR_REL))),
    ...over,
  });

test('a bundle declaring NO sidecar promotes no metadata, even though one exists on disk', async () => {
  assert.ok(fs.existsSync(path.join(ROOT, SIDECAR_REL)), 'the canonical sidecar must exist for this test to mean anything');
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(calls.inserted[0]!.ad.headline, null, 'an undeclared sidecar must never reach the database');
  assert.equal(calls.inserted[0]!.ad.description, null);
});

test('a sidecar created AFTER the bundle is ignored when undeclared', async () => {
  const lateRel = 'data/imports/late.verified-meta.csv';
  fs.writeFileSync(path.join(ROOT, lateRel), `${SIDECAR_HEADER}\n1111111111,Late headline,Late desc,,,,,ACCEPT,,ACCEPT,,ACCEPT,,\n`, 'utf-8');
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(calls.inserted[0]!.ad.headline, null, 'a sidecar the bundle never vouched for must not influence the write');
});

test('a declared, unchanged sidecar promotes only its ACCEPT field', async () => {
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(declaredSidecarBundle()), LIVE, getDb);
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' | '));
  if (!r.ok) return;
  assert.equal(calls.inserted[0]!.ad.headline, 'Verified headline');
  assert.equal(calls.inserted[0]!.ad.description, null, 'a REVIEW value stays unwritable');
});

test('a declared sidecar changed after the bundle fails before any database call', async () => {
  const rel = 'data/imports/drift.verified-meta.csv';
  const abs = path.join(ROOT, rel);
  fs.writeFileSync(abs, `${SIDECAR_HEADER}\n1111111111,Original,Original,,,,,ACCEPT,,ACCEPT,,ACCEPT,,\n`, 'utf-8');
  const b = bundleOf([successRowV3()], BUNDLE_SCHEMA_V3, {
    verified_meta_path: rel,
    verified_meta_sha256: sha256Buffer(fs.readFileSync(abs)),
  });
  const p = writeBundleFile(b);
  // Someone edits the sidecar after the bundle was written.
  fs.writeFileSync(abs, `${SIDECAR_HEADER}\n1111111111,TAMPERED,TAMPERED,,,,,ACCEPT,,ACCEPT,,ACCEPT,,\n`, 'utf-8');
  const { getDb, calls } = fakeDb();
  const r = await run(p, LIVE, getDb);
  assert.ok(!r.ok && r.errors.some((e) => e.includes('checksum mismatch')));
  assert.equal(totalDbCalls(calls), 0);
});

test('a declared but missing sidecar fails before any database call', async () => {
  const b = bundleOf([successRowV3()], BUNDLE_SCHEMA_V3, {
    verified_meta_path: 'data/imports/gone.verified-meta.csv',
    verified_meta_sha256: 'e'.repeat(64),
  });
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(b), LIVE, getDb);
  assert.ok(!r.ok && r.errors.some((e) => e.includes('missing or unreadable')));
  assert.equal(totalDbCalls(calls), 0);
});

test('a declared sidecar outside the import root fails', async () => {
  const outside = path.join(ROOT, 'outside.verified-meta.csv');
  fs.writeFileSync(outside, `${SIDECAR_HEADER}\n1111111111,X,Y,,,,,ACCEPT,,ACCEPT,,ACCEPT,,\n`, 'utf-8');
  const b = bundleOf([successRowV3()], BUNDLE_SCHEMA_V3, {
    verified_meta_path: '../outside.verified-meta.csv',
    verified_meta_sha256: sha256Buffer(fs.readFileSync(outside)),
  });
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(b), LIVE, getDb);
  assert.ok(!r.ok);
  assert.equal(totalDbCalls(calls), 0);
});

test('a declared sidecar with duplicate ad ids fails the whole run', async () => {
  const rel = 'data/imports/dupes.verified-meta.csv';
  const body = `${SIDECAR_HEADER}\n1111111111,A,B,,,,,ACCEPT,,ACCEPT,,ACCEPT,,\n1111111111,C,D,,,,,ACCEPT,,ACCEPT,,ACCEPT,,\n`;
  fs.writeFileSync(path.join(ROOT, rel), body, 'utf-8');
  const b = bundleOf([successRowV3()], BUNDLE_SCHEMA_V3, {
    verified_meta_path: rel, verified_meta_sha256: sha256Buffer(Buffer.from(body, 'utf-8')),
  });
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(b), LIVE, getDb);
  assert.ok(!r.ok && r.errors.some((e) => e.includes('duplicate ad_id')));
  assert.equal(totalDbCalls(calls), 0);
});

test('ingestion has no sidecar discovery path at all', () => {
  const code = codeOf('scripts/ingest-browser-collected-ads.ts');
  assert.ok(!code.includes('verifiedMetaPathFor'), 'no canonical-path derivation may exist');
  assert.ok(!/verified-meta\.csv/.test(code), 'no sidecar filename may be constructed');
  assert.ok(code.includes('verified_meta_path'), 'the declared path is the only source');
  // The strict shared parser is reused rather than a weaker ingestion-only copy.
  assert.ok(code.includes('loadVerifiedMetaSidecar'));
});

// ═══ benchmarkScoredAt provenance ═════════════════════════════════════════════

test('benchmarkScoredAt is the bundle timestamp, not ingestion time', async () => {
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(r.ok);
  if (!r.ok) return;
  const ad = calls.inserted[0]!.ad;
  assert.notEqual(BUNDLE_CREATED_AT, INGEST_NOW.toISOString(), 'the two must differ for this test to mean anything');
  assert.equal(ad.benchmarkScoredAt.toISOString(), BUNDLE_CREATED_AT, 'the benchmark was computed at bundle time');
  // Seen-times are ingestion time — those genuinely are "now".
  assert.equal(ad.firstSeenAt.toISOString(), INGEST_NOW.toISOString());
  assert.equal(ad.lastSeenAt.toISOString(), INGEST_NOW.toISOString());
  assert.equal(ad.lastSeenActiveAt.toISOString(), INGEST_NOW.toISOString());
});

test('an unparseable benchmark timestamp fails rather than misdating the benchmark', () => {
  const r = buildIngestPayload(successRowV3(), ctx({ benchmarkScoredAt: new Date('nonsense') }));
  assert.ok(!r.ok && r.reason.includes('not a valid instant'));
});

// ═══ Lazy Prisma boundary ═════════════════════════════════════════════════════

test('a dry run never constructs a database client', async () => {
  const { getDb, calls } = fakeDb();
  await run(writeBundleFile(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), DRY, getDb);
  assert.equal(calls.factory, 0, 'the factory must not run in dry-run');
});

test('an invalid bundle never constructs a database client', async () => {
  const bad = clone(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3));
  bad.counts.success = 99;
  const { getDb, calls } = fakeDb();
  await run(writeBundleFile(bad), LIVE, getDb);
  assert.equal(calls.factory, 0);
});

test('a v2 bundle never constructs a database client', async () => {
  const { getDb, calls } = fakeDb();
  await run(writeBundleFile(bundleOf([successRowV2()], BUNDLE_SCHEMA_V2)), LIVE, getDb);
  assert.equal(calls.factory, 0);
});

test('a held-only workload never constructs a database client', async () => {
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf([successRowV3({ visual_confidence: 'LOW' })], BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(r.ok);
  assert.equal(calls.factory, 0, 'nothing writable ⇒ no client');
  assert.equal(totalDbCalls(calls), 0);
});

test('the factory runs exactly once, only when a row is genuinely writable', async () => {
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf([successRowV3()], BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(r.ok);
  assert.equal(calls.factory, 1);
  assert.equal(calls.insert, 1);
});

test('the CLI creates the Prisma boundary lazily, after validation', () => {
  const code = codeOf('scripts/ingest-browser-collected-ads.ts');
  // The factory is passed in; it is not invoked while wiring the CLI.
  assert.ok(!/const db = await createPrismaDb\(\)/.test(code), 'no eager construction');
  assert.ok(code.includes('getDb'), 'a lazy factory is used');
});

// ═══ Ad.adLink guard ══════════════════════════════════════════════════════════

for (const link of ['', '   ']) {
  test(`a ${link === '' ? 'blank' : 'whitespace-only'} ad_library_url makes only that row non-writable`, () => {
    const r = buildIngestPayload(successRowV3(), ctx({ adLink: link }));
    assert.ok(!r.ok, 'Ad.adLink is required and must never be fabricated');
    if (r.ok) return;
    assert.match(r.reason, /ad_library_url is blank/);
    assert.ok(!r.reason.includes('Some advertiser ad copy'), 'the row contents must not be echoed');
  });
}

test('a row with no ad_library_url becomes ERROR beside a valid row that still inserts', async () => {
  const rows: BundleRow[] = [
    successRowV3(),
    successRowV3({
      ad_id: '8888888888', source_row_number: 9, media_type: 'IMAGE',
      creative_asset_path: '', creative_source: 'FALLBACK', assets: [],
      copy_used_for_scoring: 'No link copy.', visual_confidence: null, benchmark_confidence: 'LOW',
      benchmark_score: fallbackBenchmark().benchmark_score,
      benchmark_tier: fallbackBenchmark().tier_token,
      analysis_result: analysisResult({ sub_scores: staticSubScores() }),
      benchmark_result: fallbackBenchmark(),
    }),
  ];
  const { getDb, calls } = fakeDb();
  const r = await run(writeBundleFile(bundleOf(rows, BUNDLE_SCHEMA_V3)), LIVE, getDb);
  assert.ok(r.ok);
  if (!r.ok) return;
  const noLink = r.rows.find((x) => x.adId === '8888888888')!;
  assert.equal(noLink.outcome, 'ERROR');
  assert.match(noLink.reason, /ad_library_url is blank/);
  assert.equal(noLink.payload, undefined);
  assert.equal(r.rows.find((x) => x.adId === '1111111111')!.outcome, 'INSERTED');
  assert.equal(calls.insert, 1, 'the linkless row must never reach insertion');
});

// ═══ Schema-aware AdAnalysis drift detection ══════════════════════════════════

/**
 * Test-only Prisma schema reader. Extracts the required non-null scalar fields of a
 * model, so a new required column cannot be added without a mapper source. Deliberately
 * narrow — it never runs Prisma and never opens a database.
 */
export function requiredScalarFields(schema: string, model: string): string[] {
  const body = new RegExp(`model\\s+${model}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1];
  if (!body) throw new Error(`model ${model} not found`);
  const out: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();          // strip comments
    if (!line || line.startsWith('@@')) continue;
    const m = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, name, type, list, optional, attrs = ''] = m;
    if (optional || list) continue;                           // nullable / list
    if (attrs.includes('@relation')) continue;                // relation field
    if (!/^(String|Int|Float|Boolean|DateTime|Decimal|BigInt|Json|Bytes)$/.test(type!)) continue;  // model type
    if (/@id\b/.test(attrs) || /@default\(/.test(attrs) || /@updatedAt\b/.test(attrs)) continue;   // db-generated
    out.push(name!);
  }
  return out;
}

test('the schema reader ignores comments, attributes, relations, nullables and defaults', () => {
  const fixture = `
model Demo {
  id        String   @id @default(cuid())
  adId      String   @unique
  ad        Ad       @relation(fields: [adId], references: [id])
  required  String
  optional  String?  // nullable
  defaulted String   @default("x")
  stamped   DateTime @updatedAt
  madeAt    DateTime @default(now())
  tags      String[]
  // required  String  — commented out, must not count
}
`;
  assert.deepEqual(requiredScalarFields(fixture, 'Demo').sort(), ['adId', 'required']);
});

test('an added required AdAnalysis field would be detected', () => {
  const fixture = `
model AdAnalysis {
  id               String @id @default(cuid())
  adId             String @unique
  creativeAnalysis String
  brandNewColumn   String
}
`;
  const required = requiredScalarFields(fixture, 'AdAnalysis').filter((f) => f !== 'adId');
  const mapped = new Set<string>(REQUIRED_AD_ANALYSIS_FIELDS);
  const unmapped = required.filter((f) => !mapped.has(f));
  assert.deepEqual(unmapped, ['brandNewColumn'], 'a new required column must surface as unmapped');
});

test('every required non-null AdAnalysis field in the real schema has a mapper source', () => {
  const schema = fs.readFileSync(path.resolve(__dirname, '../prisma/schema.prisma'), 'utf-8');
  // adId is attached during the transactional insert, not by the mapper.
  const required = requiredScalarFields(schema, 'AdAnalysis').filter((f) => f !== 'adId').sort();
  const mapped = [...REQUIRED_AD_ANALYSIS_FIELDS].sort();
  assert.deepEqual(required, mapped,
    'the mapper contract must match the schema exactly — a new required column needs a truthful source, and a removed one must not linger');

  // And the contract must be real: every name exists on a built payload with a value.
  const { analysis } = built();
  for (const f of required) {
    const v = (analysis as unknown as Record<string, unknown>)[f];
    assert.ok(v !== undefined && v !== null, `${f} must be produced by the mapper`);
  }
});

// ═══ Structural boundary ══════════════════════════════════════════════════════

/** Source with comments and string literals removed — what actually executes. */
function codeOf(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments
    .replace(/^[ \t]*\/\/.*$/gm, '')        // line comments
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")    // string literals — prose is not a route
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** Import specifiers, before literals are blanked. */
function importsOf(rel: string): string[] {
  const src = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  return [...src.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

test('the ingestion path has no AI, scorer, browser or recompute route', () => {
  const files = ['scripts/ingest-browser-collected-ads.ts', 'lib/analysis/browserIngestBundleMapping.ts'];
  // Module specifiers that would give ingestion a route back to analysis.
  const bannedModules = [
    'creativeAssetAnalyser', 'staticAnalyser', 'videoAnalyser', 'competitorScoring',
    'anthropic', '@anthropic-ai', 'playwright', 'capture-browser-ad-assets',
    'lib/analysis/index', 'preview-browser-collected-ads',
  ];
  // Functions that would recompute an analysis.
  const bannedCalls = [
    'resolveCreativeContext', 'analyseCreativeAsset', 'analyseAdRow',
    'scoreCompetitorBenchmarkAd', 'planVisionInputs', 'fetch',
  ];
  for (const rel of files) {
    const imports = importsOf(rel);
    for (const m of bannedModules) {
      assert.ok(!imports.some((i) => i.toLowerCase().includes(m.toLowerCase())), `${rel} must not import ${m}`);
    }
    // A bare `import '@/lib/analysis'` would pull the whole scorer barrel.
    assert.ok(!imports.includes('@/lib/analysis'), `${rel} must not import the analysis barrel`);
    const code = codeOf(rel);
    for (const fn of bannedCalls) {
      assert.ok(!new RegExp(`[^.\\w]${fn}\\s*\\(`).test(code), `${rel} must not call ${fn}(`);
    }
  }
});

test('the pure mapping module has no database or ingestion import path', () => {
  const rel = 'lib/analysis/browserIngestBundleMapping.ts';
  for (const m of ['@prisma/client', 'ingest-browser-collected-ads']) {
    assert.ok(!importsOf(rel).some((i) => i.includes(m)), `the mapping module must not import ${m}`);
  }
  assert.ok(!/[^.\w]PrismaClient/.test(codeOf(rel)), 'the mapping module must not use PrismaClient');
});

test('ingestion never reads an Anthropic key', () => {
  // Prose may mention the key; executing code must never read it.
  assert.ok(!codeOf('scripts/ingest-browser-collected-ads.ts').includes('ANTHROPIC_API_KEY'),
    'a bundle-backed run needs no key');
  assert.ok(!codeOf('scripts/ingest-browser-collected-ads.ts').includes('assertApiKeyIfAssets'),
    'the key guard belonged to the removed analysis path');
});

test('ingestion loads Prisma lazily, so importing it opens no database handle', () => {
  const raw = fs.readFileSync(path.resolve(__dirname, '../scripts/ingest-browser-collected-ads.ts'), 'utf-8');
  assert.ok(!/^import[^;]*@prisma\/client/m.test(raw), 'Prisma must not be a top-level import');
  assert.ok(/await import\(\s*['"]@prisma\/client['"]\s*\)/.test(raw), 'Prisma is loaded only for an authorised live write');
});
