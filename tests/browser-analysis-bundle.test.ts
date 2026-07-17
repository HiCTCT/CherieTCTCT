/**
 * Tracked tests for the Phase 1 reusable analysis handoff.
 *
 * Runner: Node's built-in `node:test` executed through tsx (no new framework).
 *   npm run test:browser-bundle
 *
 * These tests never call Anthropic, never open a browser and never touch the
 * database. Temporary trees are created outside the repository data folders and
 * removed afterwards.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  BUNDLE_SCHEMA_V2, BUNDLE_PROMPT_VERSION, BUNDLE_PLANNER_VERSION,
  validateBundle, validateBundleSourceBinding, writeBundleAtomic, sha256Buffer, loadVerifiedMetaSidecar,
} from '../lib/analysis/browserAnalysisBundle';
import type { BrowserAnalysisBundle, BundleAsset, BundleRow, BundleSuccessRow } from '../lib/analysis/browserAnalysisBundle';
import { planIngestion, parseIdList, parseSourceIdentities } from '../scripts/plan-browser-ingest-from-bundle';
import { parseArgs } from '../scripts/validate-browser-analysis-bundle';
import { assembleBundleRows, decideHeldOnlyBundleOutput } from '../lib/analysis/bundleAssembly';
import { deriveSourceRowIdentity } from '../lib/analysis/sourceRowIdentity';
import type { SourceRowIdentity } from '../lib/analysis/sourceRowIdentity';

// ─── Sandbox (outside the repo) ───────────────────────────────────────────────

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

const ASSET_REL = 'data/creative-assets/castlery/1111111111';
const ASSET_DIR = path.join(ROOT, ASSET_REL);
fs.mkdirSync(ASSET_DIR, { recursive: true });
const FRAME = Buffer.from('fake-frame-bytes');
for (const prefix of ['frame', 'image', 'card']) {
  for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(ASSET_DIR, `${prefix}-0${i}.png`), FRAME);
}
fs.writeFileSync(path.join(ASSET_DIR, 'debug-full-page-1111111111.png'), Buffer.from('debug'));

/** Manifest entries for N real files on disk, e.g. manifest('frame', 4). */
const manifest = (prefix: string, n: number): BundleAsset[] =>
  Array.from({ length: n }, (_, i) => ({ filename: `${prefix}-0${i + 1}.png`, sha256: sha256Buffer(FRAME), bytes: FRAME.length }));

// A real multi-row source CSV. Full disk validation now binds every bundle row to
// its own source row, so each fixture row below must name a row that truly exists.
const COPY_A = 'Some advertiser ad copy.';
const CSV_REL = 'data/imports/synthetic.with-assets.csv';
fs.mkdirSync(path.join(ROOT, 'data/imports'), { recursive: true });
const CSV_BODY = [
  'ad_id,collection_status,media_type,creative_asset_path,ad_copy',
  `1111111111,READY,VIDEO,${ASSET_REL},${COPY_A}`,                                   // row 2
  `2222222222,READY,VIDEO,${ASSET_REL},${COPY_A}`,                                   // row 3
  '3333333333,NEEDS_REVIEW,VIDEO,,copy',                                             // row 4
  '4444444444,READY,VIDEO,,copy',                                                    // row 5
  '5555555555,SKIP,IMAGE,,copy',                                                     // row 6
  `6666666666,READY,VIDEO,${ASSET_REL}/frame-01.png,${COPY_A}`,                      // row 7
  `7777777777,READY,VIDEO,${ASSET_REL},Read the description under each headline for details.`, // row 8
  `8888888888,READY,IMAGE,${ASSET_REL},${COPY_A}`,                                   // row 9
  `1212121212,READY,CAROUSEL,${ASSET_REL},${COPY_A}`,                                // row 10
  `1313131313,NEEDS_REVIEW,VIDEO,${ASSET_REL},copy`,                                 // row 11
  '1414141414,NEEDS_REVIEW,VIDEO,data/creative-assets/castlery/missing-ad,copy',     // row 12
  '',
].join('\n');
fs.writeFileSync(path.join(ROOT, CSV_REL), CSV_BODY, 'utf-8');
const CSV_SUM = sha256Buffer(Buffer.from(CSV_BODY, 'utf-8'));
const SOURCE_ROWS = 11;

/** Writes an extra source CSV inside the sandbox import root. */
const writeCsv = (name: string, body: string): { rel: string; sum: string } => {
  const rel = `data/imports/${name}`;
  fs.writeFileSync(path.join(ROOT, rel), body, 'utf-8');
  return { rel, sum: sha256Buffer(Buffer.from(body, 'utf-8')) };
};

const V = (b: unknown) => validateBundle(b, { cwd: ROOT });
const errs = (b: unknown) => { const r = V(b); return r.ok ? [] : r.errors; };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const successRow = (over: Partial<BundleSuccessRow> = {}): BundleSuccessRow => ({
  ad_id: '1111111111',
  source_row_number: 2,
  source_status: 'READY',
  media_type: 'VIDEO',
  creative_asset_path: ASSET_REL,
  creative_source: 'ASSET',
  assets: manifest('frame', 1),
  copy_used_for_scoring: COPY_A,
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
  benchmark_score: 6.4,
  benchmark_tier: 'MODERATE',
  benchmark_confidence: 'HIGH',
  funnel_stage: 'MOFU',
  race_stage: 'ACT',
  trust_funnel_stage: 'SOLUTION_AWARE',
  behavioural_triggers: [{ name: 'Value', strength: 'MODERATE' }],
  strengths: ['Clear product shot'],
  ...over,
});

/** Each held variant binds to a real source row of the matching status. */
const HELD_SOURCE = {
  REVIEW:  { ad_id: '3333333333', source_row_number: 4, source_status: 'NEEDS_REVIEW', media_type: 'VIDEO' },
  ERROR:   { ad_id: '4444444444', source_row_number: 5, source_status: 'READY',        media_type: 'VIDEO' },
  SKIPPED: { ad_id: '5555555555', source_row_number: 6, source_status: 'SKIP',         media_type: 'IMAGE' },
} as const;

const heldRow = (status: 'REVIEW' | 'SKIPPED' | 'ERROR', over: Partial<BundleRow> = {}): BundleRow => ({
  ...HELD_SOURCE[status],
  creative_asset_path: '',
  creative_source: 'FALLBACK',
  assets: [],
  copy_used_for_scoring: 'copy',
  analysis_status: status,
  error_reason: 'a real reason',
  ...over,
} as BundleRow);

const bundle = (rows: BundleRow[], over: Partial<BrowserAnalysisBundle> = {}): BrowserAnalysisBundle => ({
  // These are the schema-v2 tests. v2 is frozen, so they stay pinned to it explicitly:
  // the v3 additions are covered separately in tests/browser-ingest-from-bundle.test.ts.
  schema_version: BUNDLE_SCHEMA_V2,
  created_at: '2026-07-16T00:00:00.000Z',
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
    input_rows: SOURCE_ROWS,
    selected_rows: rows.length,
    success: rows.filter((r) => r.analysis_status === 'SUCCESS').length,
    review: rows.filter((r) => r.analysis_status === 'REVIEW').length,
    skipped: rows.filter((r) => r.analysis_status === 'SKIPPED').length,
    failed: rows.filter((r) => r.analysis_status === 'ERROR').length,
  },
  rows,
  ...over,
});

// ─── Schema and status variants ───────────────────────────────────────────────

test('valid SUCCESS bundle passes', () => {
  assert.deepEqual(errs(bundle([successRow()])), []);
});

for (const s of ['REVIEW', 'SKIPPED', 'ERROR'] as const) {
  test(`valid ${s} row passes without fabricated scores`, () => {
    assert.deepEqual(errs(bundle([heldRow(s)])), []);
  });
  test(`${s} row without a reason fails`, () => {
    const b = clone(bundle([heldRow(s)])) as unknown as { rows: Array<{ error_reason: string }> };
    b.rows[0]!.error_reason = '   ';
    assert.ok(errs(b).some((e) => e.includes('non-empty error_reason')));
  });
  test(`${s} row carrying result fields is rejected`, () => {
    const b = clone(bundle([heldRow(s)])) as unknown as { rows: Array<Record<string, unknown>> };
    b.rows[0]!.internal_qa_score = 9;
    assert.ok(errs(b).some((e) => e.includes('unrecognised field "internal_qa_score"')));
  });
}

test('SUCCESS row with an error reason fails', () => {
  const b = clone(bundle([successRow()])) as unknown as { rows: Array<Record<string, unknown>> };
  b.rows[0]!.error_reason = 'boom';
  assert.ok(errs(b).some((e) => e.includes('must have error_reason: null')));
});

// ─── Completeness ─────────────────────────────────────────────────────────────

test('a failed selected ad remains present as an ERROR row', () => {
  const b = bundle([heldRow('ERROR')]);
  const r = V(b);
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' | '));
  assert.equal(b.rows.length, 1);
  assert.equal(b.counts.failed, 1);
  assert.deepEqual(b.selected_ad_ids, [HELD_SOURCE.ERROR.ad_id]);
});

test('selected_ad_ids must exactly match row ids', () => {
  const b = clone(bundle([successRow()]));
  b.selected_ad_ids = ['9999999999'];
  assert.ok(errs(b).some((e) => e.includes('does not exactly match')));
});

test('status counts must derive from rows', () => {
  const b = clone(bundle([successRow()]));
  b.counts.success = 5;
  assert.ok(errs(b).some((e) => e.includes('counts.success')));
});

test('input_rows smaller than row count fails', () => {
  const b = clone(bundle([successRow()]));
  b.counts.input_rows = 0;
  assert.ok(errs(b).some((e) => e.includes('input_rows')));
});

test('selected/excluded overlap fails', () => {
  const b = clone(bundle([successRow()]));
  b.excluded_ad_ids = ['1111111111'];
  assert.ok(errs(b).some((e) => e.includes('both selected_ad_ids and excluded_ad_ids')));
});

test('duplicate row ids fail', () => {
  const b = bundle([successRow(), successRow()]);
  assert.ok(errs(b).some((e) => e.includes('duplicate ad_id')));
});

// ─── Semantic validation ──────────────────────────────────────────────────────

test('unsupported schema version fails', () => {
  assert.ok(errs(bundle([successRow()], { schema_version: 99 })).some((e) => e.includes('unsupported schema_version')));
});

for (const bad of ['2026-07-16', '2026-07-16T00:00:00Z', 'not-a-date']) {
  test(`malformed ISO timestamp "${bad}" fails`, () => {
    assert.ok(errs(bundle([successRow()], { created_at: bad })).some((e) => e.includes('exact ISO instant')));
  });
}

test('unknown source status fails', () => {
  assert.ok(errs(bundle([successRow({ source_status: 'WAT' })])).some((e) => e.includes('source_status')));
});
test('unknown media type fails', () => {
  assert.ok(errs(bundle([successRow({ media_type: 'GIF' })])).some((e) => e.includes('media_type')));
});
test('unknown QA verdict fails', () => {
  assert.ok(errs(bundle([successRow({ internal_qa_verdict: 'AWESOME' })])).some((e) => e.includes('internal_qa_verdict')));
});
test('unknown funnel / RACE / trust stage fails', () => {
  assert.ok(errs(bundle([successRow({ funnel_stage: 'XOFU' })])).some((e) => e.includes('funnel_stage')));
  assert.ok(errs(bundle([successRow({ race_stage: 'SPRINT' })])).some((e) => e.includes('race_stage')));
  assert.ok(errs(bundle([successRow({ trust_funnel_stage: 'CURIOUS' })])).some((e) => e.includes('trust_funnel_stage')));
});
test('unknown trigger name or strength fails', () => {
  assert.ok(errs(bundle([successRow({ behavioural_triggers: [{ name: 'Vibes', strength: 'MODERATE' }] })])).some((e) => e.includes('not a known behavioural trigger')));
  assert.ok(errs(bundle([successRow({ behavioural_triggers: [{ name: 'Value', strength: 'HUGE' }] })])).some((e) => e.includes('strength')));
});
test('unknown visual confidence fails', () => {
  assert.ok(errs(bundle([successRow({ visual_confidence: 'VERY_SURE' as never })])).some((e) => e.includes('visual_confidence')));
});

test('score below 0 or above 10 fails', () => {
  assert.ok(errs(bundle([successRow({ internal_qa_score: -1 })])).some((e) => e.includes('between 0 and 10')));
  assert.ok(errs(bundle([successRow({ benchmark_score: 11 })])).some((e) => e.includes('between 0 and 10')));
  assert.ok(errs(bundle([successRow({ aida_scores: { attention: 99, interest: 6, desire: 6, action: 5 } })])).some((e) => e.includes('aida_scores.attention')));
});

test('unsafe count or frame limit fails', () => {
  assert.ok(errs(bundle([successRow()], { ai_video_max_frames: 0 })).some((e) => e.includes('ai_video_max_frames')));
  assert.ok(errs(bundle([successRow()], { ai_video_max_frames: 1.5 })).some((e) => e.includes('ai_video_max_frames')));
  const b = clone(bundle([successRow()]));
  (b.counts as unknown as Record<string, unknown>).review = -1;
  assert.ok(errs(b).some((e) => e.includes('non-negative safe integer')));
});

test('MANUAL/FALLBACK cannot claim assets or visual confidence', () => {
  assert.ok(errs(bundle([successRow({ creative_source: 'MANUAL' })])).some((e) => e.includes('must not claim consumed assets')));
  assert.ok(errs(bundle([successRow({ creative_source: 'FALLBACK', assets: [], visual_confidence: 'HIGH' })])).some((e) => e.includes('visual_confidence: null')));
});

test('ASSET success must manifest at least one asset', () => {
  assert.ok(errs(bundle([successRow({ assets: [] })])).some((e) => e.includes('at least one consumed creative asset')));
});

// ── ASSET SUCCESS must declare the path its manifest came from ──
test('ASSET success with a non-empty manifest and an empty path fails', () => {
  assert.ok(errs(bundle([successRow({ creative_asset_path: '' })]))
    .some((e) => e.includes('must declare a non-empty creative_asset_path')));
});
test('ASSET success with a non-empty manifest and a whitespace-only path fails', () => {
  assert.ok(errs(bundle([successRow({ creative_asset_path: '   ' })]))
    .some((e) => e.includes('must declare a non-empty creative_asset_path')));
});
test('ASSET success with a valid contained path and manifest passes', () => {
  assert.deepEqual(errs(bundle([successRow()])), []);
});
test('the empty ASSET path rule is structural and fires with file checks disabled', () => {
  const r = validateBundle(bundle([successRow({ creative_asset_path: '' })]), { cwd: ROOT, checkFiles: false });
  assert.ok(!r.ok && r.errors.some((e) => e.includes('must declare a non-empty creative_asset_path')));
});
test('a fabricated manifest cannot bypass disk validation via an empty path', () => {
  // Assets that exist nowhere, with hashes that match nothing.
  const fake = [{ filename: 'frame-01.png', sha256: 'f'.repeat(64), bytes: 123 }];
  // Empty path: rejected outright rather than silently skipping asset checks.
  assert.ok(errs(bundle([successRow({ creative_asset_path: '', assets: fake })]))
    .some((e) => e.includes('must declare a non-empty creative_asset_path')));
  // Declared path: the fabricated manifest is caught by real disk validation.
  assert.ok(errs(bundle([successRow({ assets: fake })]))
    .some((e) => e.includes('asset checksum mismatch') || e.includes('asset size mismatch')));
});

test('VIDEO-only visual confidence rule', () => {
  // IMAGE claiming visual confidence is rejected
  assert.ok(errs(bundle([successRow({ media_type: 'IMAGE' })])).some((e) => e.includes('VIDEO-only')));
  // ASSET VIDEO without confidence is rejected
  assert.ok(errs(bundle([successRow({ visual_confidence: null })])).some((e) => e.includes('requires a valid visual_confidence')));
});

// ─── Forbidden and unsafe data ────────────────────────────────────────────────

for (const key of ['headline', 'description']) {
  test(`raw \`${key}\` key is rejected`, () => {
    const b = clone(bundle([successRow()])) as unknown as { rows: Array<Record<string, unknown>> };
    b.rows[0]![key] = 'raw listing text';
    assert.ok(errs(b).some((e) => e.includes(`forbidden key "${key}"`)));
  });
}

test('headline_score and description_score remain allowed', () => {
  assert.deepEqual(errs(bundle([successRow()])), []);   // fixture carries both
});

test('API-key prefix inside an allowed string is rejected', () => {
  assert.ok(errs(bundle([successRow({ visual_description: 'leak sk-ant-api03-abcdefgh12345678' })])).some((e) => e.includes('API key')));
});
test('data:image/ payload is rejected', () => {
  assert.ok(errs(bundle([successRow({ creative_notes: 'data:image/png;base64,AAAA' })])).some((e) => e.includes('inline image data URI')));
});
test('long base64-like payload is rejected', () => {
  assert.ok(errs(bundle([successRow({ visual_description: 'A'.repeat(600) })])).some((e) => e.includes('base64-like payload')));
});
test('raw response section headers are rejected', () => {
  assert.ok(errs(bundle([successRow({ visual_description: 'FRAME_OBSERVATIONS:\nFRAME 1: x' })])).some((e) => e.includes('section header')));
});
test('excessive string length is rejected', () => {
  assert.ok(errs(bundle([successRow({ creative_notes: 'ab '.repeat(5000) })])).some((e) => e.includes('maximum length')));
});
test('ordinary ad copy mentioning headline/description words is accepted', () => {
  // Bound to source row 8, whose ad_copy is exactly this sentence.
  assert.deepEqual(errs(bundle([successRow({
    ad_id: '7777777777', source_row_number: 8,
    copy_used_for_scoring: 'Read the description under each headline for details.',
  })])), []);
});

// ─── analysis_model is a bounded, scanned string ──────────────────────────────

test('analysis_model accepts a normal model identifier', () => {
  assert.deepEqual(errs(bundle([successRow()], { analysis_model: 'claude-haiku-4-5' })), []);
  assert.deepEqual(errs(bundle([successRow()], { analysis_model: 'claude-opus-4-8' })), []);
});
for (const [label, model] of [
  ['an Anthropic-style key', 'sk-ant-api03-abcdefgh12345678'],
  ['an sk- secret-like value', `sk-${'a'.repeat(24)}`],
  ['a data-image value', 'data:image/png;base64,AAAA'],
  ['a long base64-like value', 'A'.repeat(600)],
  ['an excessive model-name length', `claude-${'x'.repeat(100)}`],
] as const) {
  test(`analysis_model rejects ${label}`, () => {
    assert.ok(errs(bundle([successRow()], { analysis_model: model })).some((e) => e.includes('analysis_model')));
  });
}
test('a rejected analysis_model value is never echoed in the error', () => {
  const secret = 'sk-ant-api03-donotprintthisvalue1';
  const e = errs(bundle([successRow()], { analysis_model: secret }));
  assert.ok(e.length > 0);
  assert.ok(!e.join(' ').includes(secret), 'the rejected value must not appear in any error');
});

// ─── Source and asset integrity ───────────────────────────────────────────────

test('source checksum drift fails', () => {
  assert.ok(errs(bundle([successRow()], { source_csv_sha256: 'a'.repeat(64) })).some((e) => e.includes('checksum mismatch')));
});
test('source path escaping the import root fails', () => {
  assert.ok(errs(bundle([successRow()], { source_csv_path: '../outside.csv', source_csv_sha256: CSV_SUM })).some((e) => e.includes('outside')));
});
test('declared sidecar that is missing fails', () => {
  const b = bundle([successRow()], { verified_meta_path: 'data/imports/nope.verified-meta.csv', verified_meta_sha256: 'b'.repeat(64) });
  assert.ok(errs(b).some((e) => e.includes('missing or unreadable')));
});
test('sidecar drift fails', () => {
  const rel = 'data/imports/sc.verified-meta.csv';
  fs.writeFileSync(path.join(ROOT, rel), 'x', 'utf-8');
  const b = bundle([successRow()], { verified_meta_path: rel, verified_meta_sha256: 'c'.repeat(64) });
  assert.ok(errs(b).some((e) => e.includes('verified-metadata checksum mismatch')));
});
test('missing asset fails', () => {
  assert.ok(errs(bundle([successRow({ assets: [{ filename: 'frame-99.png', sha256: sha256Buffer(FRAME), bytes: FRAME.length }] })])).some((e) => e.includes('asset file missing')));
});
test('asset hash mismatch fails', () => {
  assert.ok(errs(bundle([successRow({ assets: [{ filename: 'frame-01.png', sha256: 'd'.repeat(64), bytes: FRAME.length }] })])).some((e) => e.includes('asset checksum mismatch')));
});
test('asset size mismatch fails', () => {
  assert.ok(errs(bundle([successRow({ assets: [{ filename: 'frame-01.png', sha256: sha256Buffer(FRAME), bytes: 999 }] })])).some((e) => e.includes('asset size mismatch')));
});

// ── VIDEO manifest cardinality (5a) ──
test('a VIDEO manifest equal to the frame limit passes', () => {
  assert.deepEqual(errs(bundle([successRow({ assets: manifest('frame', 4) })], { ai_video_max_frames: 4 })), []);
});
test('a VIDEO manifest below the frame limit passes', () => {
  assert.deepEqual(errs(bundle([successRow({ assets: manifest('frame', 2) })], { ai_video_max_frames: 4 })), []);
});
test('a VIDEO manifest above the declared frame limit fails', () => {
  assert.ok(errs(bundle([successRow({ assets: manifest('frame', 5) })], { ai_video_max_frames: 4 }))
    .some((e) => e.includes('ai_video_max_frames is 4')));
});
test('the VIDEO frame rule never rejects IMAGE or CAROUSEL manifests', () => {
  const image = successRow({ ad_id: '8888888888', source_row_number: 9, media_type: 'IMAGE', visual_confidence: null, assets: manifest('image', 5) });
  const carousel = successRow({ ad_id: '1212121212', source_row_number: 10, media_type: 'CAROUSEL', visual_confidence: null, assets: manifest('card', 5) });
  assert.deepEqual(errs(bundle([image], { ai_video_max_frames: 4 })), []);
  assert.deepEqual(errs(bundle([carousel], { ai_video_max_frames: 4 })), []);
});

// ── creative_asset_path containment with an empty manifest (5b) ──
test('a held row with a traversal asset path fails containment despite an empty manifest', () => {
  assert.ok(errs(bundle([heldRow('REVIEW', { creative_asset_path: '../outside-assets' })])).some((e) => e.includes('outside')));
});
test('a held row with a sibling-prefix asset path fails containment', () => {
  assert.ok(errs(bundle([heldRow('REVIEW', { creative_asset_path: 'data/creative-assets-evil' })])).some((e) => e.includes('outside')));
});
test('a MANUAL row cannot smuggle an unsafe path through an empty manifest', () => {
  const row = successRow({ creative_source: 'MANUAL', assets: [], visual_confidence: null, creative_asset_path: '../outside-assets' });
  assert.ok(errs(bundle([row])).some((e) => e.includes('outside')));
});
test('a held row with a safe contained path is accepted without requiring the file to exist', () => {
  // Row 11 records a real directory; row 12 records a contained path that is absent.
  // Neither row claims the asset was consumed, so existence is not asserted.
  assert.deepEqual(errs(bundle([heldRow('REVIEW', { ad_id: '1313131313', source_row_number: 11, creative_asset_path: ASSET_REL })])), []);
  assert.deepEqual(errs(bundle([heldRow('REVIEW', { ad_id: '1414141414', source_row_number: 12, creative_asset_path: 'data/creative-assets/castlery/missing-ad' })])), []);
});
test('an empty asset path remains valid on a held row', () => {
  assert.deepEqual(errs(bundle([heldRow('REVIEW')])), []);
});
test('debug/support filename fails', () => {
  assert.ok(errs(bundle([successRow({ assets: [{ filename: 'debug-full-page-1111111111.png', sha256: sha256Buffer(FRAME), bytes: 5 }] })])).some((e) => e.includes('not an eligible creative asset')));
});
test('duplicate manifest entries fail', () => {
  const a = { filename: 'frame-01.png', sha256: sha256Buffer(FRAME), bytes: FRAME.length };
  assert.ok(errs(bundle([successRow({ assets: [a, { ...a }] })])).some((e) => e.includes('duplicate asset entry')));
});
test('a path in the manifest filename fails', () => {
  assert.ok(errs(bundle([successRow({ assets: [{ filename: '../frame-01.png', sha256: sha256Buffer(FRAME), bytes: FRAME.length }] })])).some((e) => e.includes('bare filename')));
});
test('shared-prefix directory escape fails', () => {
  fs.mkdirSync(path.join(ROOT, 'data/creative-assets-evil'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data/creative-assets-evil/frame-01.png'), FRAME);
  const b = bundle([successRow({ creative_asset_path: 'data/creative-assets-evil' })]);
  assert.ok(errs(b).some((e) => e.includes('outside')));
});
test('direct-file asset path validates the file itself', () => {
  // Bound to source row 7, which records the direct file rather than the folder.
  const rel = `${ASSET_REL}/frame-01.png`;
  assert.deepEqual(errs(bundle([successRow({ ad_id: '6666666666', source_row_number: 7, creative_asset_path: rel })])), []);
});
test('symlink escape is contained (skipped when the OS denies symlinks)', (t) => {
  const link = path.join(ROOT, 'data/creative-assets/escape');
  const outside = path.join(ROOT, 'outside-assets');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'frame-01.png'), FRAME);
  try { fs.symlinkSync(outside, link, 'junction'); }
  catch { t.skip('symlink/junction creation denied by the OS'); return; }
  const b = bundle([successRow({ creative_asset_path: 'data/creative-assets/escape' })]);
  assert.ok(errs(b).some((e) => e.includes('outside')));
});

// ─── Standalone disk validation proves the bundle-to-source relationship (5c) ─

for (const [field, over] of [
  ['source_row_number', { source_row_number: 3 }],
  ['source_status', { source_status: 'SKIP' }],
  // IMAGE also drops visual_confidence, which is VIDEO-only: the drift is the point here.
  ['media_type', { media_type: 'IMAGE', visual_confidence: null }],
  ['creative_asset_path', { creative_asset_path: 'data/creative-assets/castlery/2222222222' }],
  ['copy_used_for_scoring', { copy_used_for_scoring: 'copy that is not in the CSV' }],
] as const) {
  test(`standalone validation detects ${field} drift against the source CSV`, () => {
    const b = bundle([successRow(over as Partial<BundleSuccessRow>)]);
    assert.ok(errs(b).some((e) => e.includes('does not match its source CSV row')));
  });
}
test('standalone validation detects a selected id absent from the source', () => {
  assert.ok(errs(bundle([successRow({ ad_id: '1010101010' })])).some((e) => e.includes('is not present in the source CSV')));
});
test('standalone validation detects the wrong input_rows count', () => {
  const b = clone(bundle([successRow()]));
  b.counts.input_rows = 99;
  assert.ok(errs(b).some((e) => e.includes('counts.input_rows 99 !=')));
});
test('standalone validation rejects a source CSV with no ad_id column', () => {
  const { rel, sum } = writeCsv('no-id-column.csv', 'collection_status,media_type\nREADY,VIDEO\n');
  const b = bundle([successRow()], { source_csv_path: rel, source_csv_sha256: sum });
  assert.ok(errs(b).some((e) => e.includes('no ad_id column')));
});
test('standalone validation rejects a blank source id', () => {
  const { rel, sum } = writeCsv('blank-id.csv', 'ad_id,collection_status\n,READY\n1111111111,READY\n');
  const b = bundle([successRow()], { source_csv_path: rel, source_csv_sha256: sum });
  assert.ok(errs(b).some((e) => e.includes('ad_id is blank')));
});
test('standalone validation rejects a malformed source id', () => {
  const { rel, sum } = writeCsv('bad-id.csv', 'ad_id,collection_status\nnot-a-number,READY\n');
  const b = bundle([successRow()], { source_csv_path: rel, source_csv_sha256: sum });
  assert.ok(errs(b).some((e) => e.includes('not an exact numeric id')));
});
test('standalone validation rejects duplicate source ids', () => {
  const { rel, sum } = writeCsv('dupe-id.csv', 'ad_id,collection_status\n1111111111,READY\n1111111111,READY\n');
  const b = bundle([successRow()], { source_csv_path: rel, source_csv_sha256: sum });
  assert.ok(errs(b).some((e) => e.includes('duplicate ad_id')));
});
test('a full-scope bundle must account for every source row', () => {
  // Exercised directly: a bundle claiming full scope while carrying fewer rows is
  // also caught by the shape rules, so this asserts the binding rule on its own.
  const { rel, sum } = writeCsv('two-rows.csv',
    `ad_id,collection_status,media_type,creative_asset_path,ad_copy\n1111111111,READY,VIDEO,${ASSET_REL},${COPY_A}\n2222222222,READY,VIDEO,${ASSET_REL},${COPY_A}\n`);
  const b = clone(bundle([successRow()], { source_csv_path: rel, source_csv_sha256: sum }));
  b.counts.input_rows = 2;
  b.counts.selected_rows = 2;
  const errors = validateBundleSourceBinding(b, path.join(ROOT, rel), ROOT);
  assert.ok(errors.some((e) => e.includes('has no bundle row')));
});
test('--no-file-checks skips source binding entirely', () => {
  const b = bundle([successRow({ copy_used_for_scoring: 'copy that is not in the CSV' })]);
  const r = validateBundle(b, { cwd: ROOT, checkFiles: false });
  assert.ok(r.ok, 'structural-only validation must not assert source identity');
});

// ─── Per-row source binding ───────────────────────────────────────────────────

const src = (over: Partial<SourceRowIdentity> = {}): SourceRowIdentity => ({
  ad_id: '1111111111', source_row_number: 2, source_status: 'READY', media_type: 'VIDEO',
  creative_asset_path: ASSET_REL, copy_used_for_scoring: 'Some advertiser ad copy.', ...over,
});
const okBundle = () => bundle([successRow()]);
const planOf = (rows: SourceRowIdentity[], b = okBundle(), o = {}) => {
  const r = planIngestion(rows, b, o);
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' | '));
  return r.plan;
};

test('READY + SUCCESS -> INSERT with verified binding', () => {
  assert.equal(planOf([src()])[0]!.action, 'INSERT');
});
for (const [field, val] of [['source_row_number', 99], ['source_status', 'SKIP'], ['media_type', 'IMAGE'], ['creative_asset_path', 'data/creative-assets/other'], ['copy_used_for_scoring', 'different copy']] as const) {
  test(`row binding drift on ${field} refuses ingestion`, () => {
    const rows = [src({ [field]: val } as Partial<SourceRowIdentity>)];
    const p = planOf(rows);
    // SKIP status routes before binding; every other drift must ERROR.
    if (field === 'source_status') assert.equal(p[0]!.action, 'SKIP');
    else { assert.equal(p[0]!.action, 'ERROR'); assert.match(p[0]!.reason, /does not match the source CSV row/); }
  });
}

// ─── Planner behaviour ────────────────────────────────────────────────────────

test('injected existing id -> UPDATE', () => {
  assert.equal(planOf([src()], okBundle(), { existing: ['1111111111'] })[0]!.action, 'UPDATE');
});
test('NEEDS_REVIEW -> REVIEW', () => {
  assert.equal(planOf([src({ source_status: 'NEEDS_REVIEW' })])[0]!.action, 'REVIEW');
});
test('SKIP -> SKIP', () => {
  assert.equal(planOf([src({ source_status: 'SKIP' })])[0]!.action, 'SKIP');
});
test('UNAVAILABLE -> UNAVAILABLE', () => {
  assert.equal(planOf([src({ source_status: 'UNAVAILABLE' })])[0]!.action, 'UNAVAILABLE');
});
test('analysis ERROR -> ERROR and does not block another valid row', () => {
  const rows = [src(), src({ ad_id: '2222222222', source_row_number: 3 })];
  const b = bundle([
    heldRow('ERROR', { ad_id: '1111111111', source_row_number: 2, copy_used_for_scoring: COPY_A, creative_asset_path: ASSET_REL }),
    successRow({ ad_id: '2222222222', source_row_number: 3 }),
  ]);
  const p = planOf(rows, b);
  assert.equal(p.find((x) => x.adId === '1111111111')!.action, 'ERROR');
  assert.equal(p.find((x) => x.adId === '2222222222')!.action, 'INSERT');
});
test('LOW visual confidence -> REVIEW and does not block another valid row', () => {
  const rows = [src(), src({ ad_id: '2222222222', source_row_number: 3 })];
  const b = bundle([successRow({ visual_confidence: 'LOW' }), successRow({ ad_id: '2222222222', source_row_number: 3 })]);
  const p = planOf(rows, b);
  assert.equal(p.find((x) => x.adId === '1111111111')!.action, 'REVIEW');
  assert.equal(p.find((x) => x.adId === '2222222222')!.action, 'INSERT');
});
test('missing bundle row -> REVIEW, never ingested', () => {
  const p = planOf([src({ ad_id: '9999999999', source_row_number: 4 })], okBundle());
  assert.equal(p[0]!.action, 'REVIEW');
});
test('missing included source id fails the plan', () => {
  const r = planIngestion([src()], okBundle(), { include: ['7777777777'] });
  assert.ok(!r.ok && r.errors.some((e) => e.includes('not present in the source CSV')));
});
test('duplicate source ids fail the plan', () => {
  const r = planIngestion([src(), src()], okBundle());
  assert.ok(!r.ok && r.errors.some((e) => e.includes('duplicate ad_id')));
});
test('malformed source id fails the plan', () => {
  const r = planIngestion([src({ ad_id: 'abc' })], okBundle());
  assert.ok(!r.ok && r.errors.some((e) => e.includes('not an exact numeric id')));
});

// ── Source rows are parsed and validated, never silently filtered (3) ──
test('a source CSV with no ad_id column fails the plan', () => {
  const r = parseSourceIdentities([{ collection_status: 'READY', media_type: 'VIDEO' }], ROOT);
  assert.ok(!r.ok && r.errors.some((e) => e.includes('no ad_id column')));
});
test('parseSourceIdentities drops no row, not even an invalid one', () => {
  const raw = [
    { ad_id: '1111111111', collection_status: 'READY' },
    { ad_id: '   ', collection_status: 'READY' },
    { ad_id: '2222222222', collection_status: 'READY' },
  ];
  const r = parseSourceIdentities(raw, ROOT);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.rows.length, 3, 'every source row must survive parsing');
});
test('a blank source ad_id fails the whole plan', () => {
  const r = planIngestion([src({ ad_id: '' })], okBundle());
  assert.ok(!r.ok && r.errors.some((e) => e.includes('ad_id is blank')));
});
test('a whitespace-only source ad_id fails the whole plan', () => {
  const parsed = parseSourceIdentities([{ ad_id: '   ', collection_status: 'READY' }], ROOT);
  assert.ok(parsed.ok);
  const r = parsed.ok ? planIngestion(parsed.rows, okBundle()) : null;
  assert.ok(r && !r.ok && r.errors.some((e) => e.includes('ad_id is blank')));
});
test('one invalid row beside valid rows fails the whole plan', () => {
  const r = planIngestion([src(), src({ ad_id: 'abc', source_row_number: 3 })], okBundle());
  assert.ok(!r.ok, 'a partial plan must never be produced');
  assert.ok(!r.ok && r.errors.some((e) => e.includes('source row 3')));
});
test('no valid row is silently omitted from a plan', () => {
  const rows = [src(), src({ ad_id: '2222222222', source_row_number: 3 })];
  const b = bundle([successRow(), successRow({ ad_id: '2222222222', source_row_number: 3 })]);
  assert.equal(planOf(rows, b).length, 2);
});
test('a rejected source ad_id is never echoed in the error', () => {
  const r = planIngestion([src({ ad_id: 'sk-ant-donotprint' })], okBundle());
  assert.ok(!r.ok && !r.errors.join(' ').includes('sk-ant-donotprint'));
});
test('include/exclude conflict fails rather than silently skipping', () => {
  const r = planIngestion([src()], okBundle(), { include: ['1111111111'], exclude: ['1111111111'] });
  assert.ok(!r.ok && r.errors.some((e) => e.includes('BOTH the include and exclude sets')));
});
test('substring ids do not match', () => {
  const r = planIngestion([src()], okBundle(), { include: ['111'] });
  assert.ok(!r.ok && r.errors.some((e) => e.includes('not present in the source CSV')));
});
test('excluded id never inserts or updates', () => {
  const p = planOf([src()], okBundle(), { exclude: ['1111111111'] });
  assert.equal(p[0]!.action, 'SKIP');
});
for (const bad of ['', '1,,2', '1,abc', '1,1']) {
  test(`id list "${bad}" is rejected`, () => {
    assert.equal(parseIdList('X', bad).ok, false);
  });
}
test('absent id list is allowed', () => {
  assert.deepEqual(parseIdList('X', undefined), { ok: true, ids: null });
});

// ─── Verified metadata ────────────────────────────────────────────────────────

const SIDECAR_HEADER = 'ad_id,verified_headline,verified_description,cta,display_url,landing_url,capture_strategy,headline_status,headline_reason,description_status,description_reason,verification_status,verification_reason,captured_at';

test('only ACCEPT verified metadata is promoted; REVIEW stays review-only', () => {
  const csv = `${SIDECAR_HEADER}\n1111111111,Good headline,Held description,Shop Now,,,structured-footer,ACCEPT,ok,REVIEW,uncertain,ACCEPT,ok,2026-07-16T00:00:00.000Z\n`;
  const vm = loadVerifiedMetaSidecar(csv);
  assert.ok(vm.ok);
  const p = planOf([src()], okBundle(), { verifiedMeta: vm.ok ? vm.map : null });
  assert.equal(p[0]!.action, 'INSERT');
  assert.equal(p[0]!.verifiedHeadline, 'Good headline');
  assert.equal(p[0]!.verifiedDescription, null, 'REVIEW description must not be promoted');
  assert.equal(p[0]!.reviewOnlyMetadata, true);
});
test('sidecar with duplicate ad ids is rejected entirely', () => {
  const csv = `${SIDECAR_HEADER}\n1111111111,a,b,,,,,ACCEPT,,ACCEPT,,ACCEPT,,\n1111111111,c,d,,,,,ACCEPT,,ACCEPT,,ACCEPT,,\n`;
  const vm = loadVerifiedMetaSidecar(csv);
  assert.ok(!vm.ok && vm.errors.some((e) => e.includes('duplicate ad_id')));
});

// ─── Output and CLI ───────────────────────────────────────────────────────────

test('atomic write succeeds and re-reads the final file', () => {
  const out = path.join(ROOT, 'w1.bundle.json');
  const r = writeBundleAtomic(bundle([successRow()]), out, { cwd: ROOT });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.sha256, sha256Buffer(fs.readFileSync(out)));
    assert.equal(r.bytes, fs.statSync(out).size);
  }
});
test('no-clobber without confirmation', () => {
  const out = path.join(ROOT, 'w2.bundle.json');
  assert.ok(writeBundleAtomic(bundle([successRow()]), out, { cwd: ROOT }).ok);
  const second = writeBundleAtomic(bundle([successRow()]), out, { cwd: ROOT });
  assert.ok(!second.ok && second.errors.some((e) => e.includes('already exists')));
});
test('confirmed overwrite replaces the file', () => {
  const out = path.join(ROOT, 'w3.bundle.json');
  assert.ok(writeBundleAtomic(bundle([successRow()]), out, { cwd: ROOT }).ok);
  assert.ok(writeBundleAtomic(bundle([successRow()]), out, { cwd: ROOT, allowOverwrite: true }).ok);
});
test('failed write leaves no temp file behind', () => {
  const dir = path.join(ROOT, 'wdir');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'sub');
  fs.mkdirSync(out, { recursive: true });   // destination is a directory → write fails
  const r = writeBundleAtomic(bundle([successRow()]), out, { cwd: ROOT, allowOverwrite: true });
  assert.ok(!r.ok);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0);
});
test('invalid bundle is never written', () => {
  const out = path.join(ROOT, 'w4.bundle.json');
  const r = writeBundleAtomic(bundle([successRow({ internal_qa_score: 99 })]), out, { cwd: ROOT });
  assert.ok(!r.ok);
  assert.equal(fs.existsSync(out), false);
});

// ── Every write goes through a temp file (1) ──

const tempsIn = (dir: string) => fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));

test('a no-overwrite write never streams into the final path', () => {
  const out = path.join(ROOT, 'w5.bundle.json');
  let seen: { finalExists: boolean; tempComplete: boolean } | null = null;
  const r = writeBundleAtomic(bundle([successRow()]), out, {
    cwd: ROOT,
    onTempWritten: (tmp) => {
      seen = {
        finalExists: fs.existsSync(out),
        tempComplete: (JSON.parse(fs.readFileSync(tmp, 'utf-8')) as BrowserAnalysisBundle).rows.length === 1,
      };
    },
  });
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' | '));
  assert.deepEqual(seen, { finalExists: false, tempComplete: true },
    'the complete bundle must exist in the temp file before the final path exists');
  assert.deepEqual(tempsIn(ROOT), [], 'the temp file must be removed after success');
});

test('a no-overwrite refusal preserves the existing final file', () => {
  const out = path.join(ROOT, 'w6.bundle.json');
  fs.writeFileSync(out, 'ORIGINAL', 'utf-8');
  const r = writeBundleAtomic(bundle([successRow()]), out, { cwd: ROOT });
  assert.ok(!r.ok && r.errors.some((e) => e.includes('already exists')));
  assert.equal(fs.readFileSync(out, 'utf-8'), 'ORIGINAL', 'the existing file must be untouched');
  assert.deepEqual(tempsIn(ROOT), [], 'the temp file must be removed after refusal');
});

test('an interrupted temporary write leaves no final file', () => {
  const out = path.join(ROOT, 'w7.bundle.json');
  const r = writeBundleAtomic(bundle([successRow()]), out, {
    cwd: ROOT,
    onTempWritten: (tmp) => fs.unlinkSync(tmp),   // simulates a lost/interrupted temp write
  });
  assert.ok(!r.ok && r.errors.some((e) => e.includes('disappeared before finalisation')));
  assert.equal(fs.existsSync(out), false, 'finalisation failure must leave no partial final file');
  assert.deepEqual(tempsIn(ROOT), []);
});

test('confirmed overwrite finalises the complete new file from the temp file', () => {
  const out = path.join(ROOT, 'w8.bundle.json');
  fs.writeFileSync(out, 'OLD', 'utf-8');
  let duringTemp = 'unset';
  const r = writeBundleAtomic(bundle([successRow()]), out, {
    cwd: ROOT,
    allowOverwrite: true,
    onTempWritten: () => { duringTemp = fs.readFileSync(out, 'utf-8'); },
  });
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' | '));
  assert.equal(duringTemp, 'OLD', 'the final file must stay untouched until finalisation');
  const written = JSON.parse(fs.readFileSync(out, 'utf-8')) as BrowserAnalysisBundle;
  assert.equal(written.rows.length, 1);
  assert.equal(written.schema_version, BUNDLE_SCHEMA_V2);
  if (r.ok) assert.equal(r.sha256, sha256Buffer(fs.readFileSync(out)));
  assert.deepEqual(tempsIn(ROOT), [], 'the temp file must be removed after a confirmed overwrite');
});

test('validator CLI arg parsing', () => {
  assert.deepEqual(parseArgs(['b.json']), { ok: true, bundlePath: 'b.json', skipFiles: false });
  assert.deepEqual(parseArgs(['--', 'b.json', '--no-file-checks']), { ok: true, bundlePath: 'b.json', skipFiles: true });
  assert.equal(parseArgs([]).ok, false);
  assert.equal(parseArgs(['a.json', 'b.json']).ok, false);
  assert.equal(parseArgs(['b.json', '--wat']).ok, false);
  assert.equal(parseArgs(['b.json', '--no-file-checks', '--no-file-checks']).ok, false);
});

// ── Cleanup is attempted, and never falsely reported as confirmed ──

test('cleanup is attempted after a successful write', () => {
  const out = path.join(ROOT, 'c1.bundle.json');
  const attempted: string[] = [];
  const r = writeBundleAtomic(bundle([successRow()]), out, {
    cwd: ROOT,
    __testHooks: { unlink: (p) => { attempted.push(p); fs.unlinkSync(p); } },
  });
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' | '));
  assert.equal(attempted.length, 1, 'the temp file must be cleaned up after success');
  if (r.ok) assert.deepEqual(r.warnings, [], 'a confirmed cleanup reports no warning');
});

test('cleanup is attempted after a failed finalisation', () => {
  const out = path.join(ROOT, 'c2.bundle.json');
  fs.writeFileSync(out, 'ORIGINAL', 'utf-8');
  const attempted: string[] = [];
  const r = writeBundleAtomic(bundle([successRow()]), out, {
    cwd: ROOT,
    __testHooks: { unlink: (p) => { attempted.push(p); fs.unlinkSync(p); } },
  });
  assert.ok(!r.ok && r.errors.some((e) => e.includes('already exists')));
  assert.equal(attempted.length, 1, 'the temp file must be cleaned up after failure');
  assert.deepEqual(tempsIn(ROOT), []);
});

test('a failed unlink after success is reported as unconfirmed, never as confirmed cleanup', () => {
  const out = path.join(ROOT, 'c3.bundle.json');
  const r = writeBundleAtomic(bundle([successRow()]), out, {
    cwd: ROOT,
    __testHooks: { unlink: () => { throw new Error('EPERM: simulated unlink failure'); } },
  });
  // Finalisation succeeded, so the valid final file stands.
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' | '));
  if (!r.ok) return;
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /NOT confirmed/);
  const written = JSON.parse(fs.readFileSync(out, 'utf-8')) as BrowserAnalysisBundle;
  assert.equal(written.rows.length, 1, 'the final bundle must remain valid');
  assert.equal(r.sha256, sha256Buffer(fs.readFileSync(out)));
  // Clean up the deliberately stranded temp file so later temp assertions stay honest.
  for (const f of tempsIn(ROOT)) fs.unlinkSync(path.join(ROOT, f));
});

test('when both the operation and cleanup fail, the original failure is preserved', () => {
  const out = path.join(ROOT, 'c4.bundle.json');
  fs.writeFileSync(out, 'ORIGINAL', 'utf-8');
  const r = writeBundleAtomic(bundle([successRow()]), out, {
    cwd: ROOT,
    __testHooks: { unlink: () => { throw new Error('EPERM: simulated unlink failure'); } },
  });
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.match(r.errors[0]!, /already exists/, 'the original failure must come first');
  assert.ok(r.errors.some((e) => e.includes('NOT confirmed')), 'the cleanup failure must also be reported');
  assert.equal(fs.readFileSync(out, 'utf-8'), 'ORIGINAL');
  for (const f of tempsIn(ROOT)) fs.unlinkSync(path.join(ROOT, f));
});

// ── Final verification fails closed ──

test('normal final verification reports the real byte size', () => {
  const out = path.join(ROOT, 'v1.bundle.json');
  const r = writeBundleAtomic(bundle([successRow()]), out, { cwd: ROOT });
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' | '));
  if (r.ok) {
    assert.equal(r.bytes, fs.statSync(out).size);
    assert.ok(r.bytes > 0);
    assert.equal(r.sha256, sha256Buffer(fs.readFileSync(out)));
  }
});

test('a simulated stat failure fails closed instead of reporting bytes: 0', () => {
  const out = path.join(ROOT, 'v2.bundle.json');
  const r = writeBundleAtomic(bundle([successRow()]), out, {
    cwd: ROOT,
    __testHooks: { statSize: () => { throw new Error('EIO: simulated stat failure'); } },
  });
  assert.ok(!r.ok, 'an unverified byte size must never be reported as success');
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('UNVERIFIED')));
  assert.ok(!JSON.stringify(r).includes('"bytes":0'));
  // The finalised file must not be damaged by a reporting failure.
  assert.equal((JSON.parse(fs.readFileSync(out, 'utf-8')) as BrowserAnalysisBundle).rows.length, 1);
});

test('a zero byte size is never passed off as verified success', () => {
  const out = path.join(ROOT, 'v3.bundle.json');
  const r = writeBundleAtomic(bundle([successRow()]), out, { cwd: ROOT, __testHooks: { statSize: () => 0 } });
  assert.ok(!r.ok && r.errors.some((e) => e.includes('does not match')));
});

test('a simulated final read/hash failure fails closed', () => {
  const out = path.join(ROOT, 'v4.bundle.json');
  const r = writeBundleAtomic(bundle([successRow()]), out, { cwd: ROOT, __testHooks: { hashFile: () => null } });
  assert.ok(!r.ok && r.errors.some((e) => e.includes('could not be re-read')));
  assert.equal((JSON.parse(fs.readFileSync(out, 'utf-8')) as BrowserAnalysisBundle).rows.length, 1,
    'the final file must not be rewritten or deleted during verification failure');
});

test('a final file that does not match what was serialised fails closed', () => {
  const out = path.join(ROOT, 'v5.bundle.json');
  const r = writeBundleAtomic(bundle([successRow()]), out, { cwd: ROOT, __testHooks: { hashFile: () => 'a'.repeat(64) } });
  assert.ok(!r.ok && r.errors.some((e) => e.includes('checksum does not match')));
});

// ─── Held-only bundle output (4) ──────────────────────────────────────────────

const rawRow = (over: Record<string, string> = {}): Record<string, string> => ({
  ad_id: '1111111111', collection_status: 'NEEDS_REVIEW', media_type: 'IMAGE',
  creative_asset_path: '', ad_copy: 'copy', ...over,
});
/** Assembly with NO analysis input at all — the held-only case. */
const assembleHeld = (rows: Record<string, string>[], scopeIds: string[] | null = null) =>
  assembleBundleRows({ rawRows: rows, scopeIds, success: new Map(), errors: new Map(), cwd: ROOT });

test('a held-only unfiltered scope produces one honest row per source row', () => {
  const r = assembleHeld([
    rawRow({ ad_id: '1111111111', collection_status: 'NEEDS_REVIEW' }),
    rawRow({ ad_id: '2222222222', collection_status: 'SKIP' }),
    rawRow({ ad_id: '3333333333', collection_status: 'UNAVAILABLE' }),
  ]);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows.map((x) => x.analysis_status), ['REVIEW', 'SKIPPED', 'SKIPPED']);
  assert.equal(r.inputRows, 3);
});
test('an exact-ID scope of only NEEDS_REVIEW yields a REVIEW row', () => {
  const r = assembleHeld([rawRow({ collection_status: 'NEEDS_REVIEW' }), rawRow({ ad_id: '2222222222', collection_status: 'READY' })], ['1111111111']);
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.rows.length, 1); assert.equal(r.rows[0]!.analysis_status, 'REVIEW'); }
});
test('an exact-ID scope of only SKIP yields a SKIPPED row', () => {
  const r = assembleHeld([rawRow({ collection_status: 'SKIP' })], ['1111111111']);
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.rows[0]!.analysis_status, 'SKIPPED'); assert.equal(r.rows[0]!.source_status, 'SKIP'); }
});
test('an exact-ID scope of only UNAVAILABLE stays SKIPPED but keeps source_status UNAVAILABLE', () => {
  const r = assembleHeld([rawRow({ collection_status: 'UNAVAILABLE' })], ['1111111111']);
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.rows[0]!.analysis_status, 'SKIPPED'); assert.equal(r.rows[0]!.source_status, 'UNAVAILABLE'); }
});
test('mixed held statuses with no READY row still produce a truthful bundle', () => {
  const r = assembleHeld([
    rawRow({ ad_id: '1111111111', collection_status: 'NEEDS_REVIEW' }),
    rawRow({ ad_id: '2222222222', collection_status: 'UNAVAILABLE' }),
    rawRow({ ad_id: '3333333333', collection_status: 'SKIP' }),
  ]);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.rows.filter((x) => x.analysis_status === 'SUCCESS').length, 0);
  assert.equal(r.rows.length, 3, 'no held row may be dropped');
  assert.ok(r.rows.every((x) => x.analysis_status !== 'SUCCESS' && x.error_reason !== null));
});
test('held-only assembly needs no analysis, network or model input', () => {
  const r = assembleHeld([rawRow()]);
  assert.ok(r.ok && r.rows.length === 1 && r.rows[0]!.analysis_status === 'REVIEW');
});
test('a requested id absent from the source fails the bundle', () => {
  const r = assembleHeld([rawRow()], ['9999999999']);
  assert.ok(!r.ok && r.errors.some((e) => e.includes('absent from the source CSV')));
});
test('a blank or duplicate source id fails bundle assembly', () => {
  assert.ok(!assembleHeld([rawRow({ ad_id: '' })]).ok);
  assert.ok(!assembleHeld([rawRow({ ad_id: '   ' })]).ok);
  const dupe = assembleHeld([rawRow(), rawRow()]);
  assert.ok(!dupe.ok && dupe.errors.some((e) => e.includes('duplicate ad_id')));
});
test('an all-held bundle validates and can be written', () => {
  const b = bundle([heldRow('REVIEW'), heldRow('SKIPPED')]);
  assert.deepEqual(errs(b), []);
  const r = writeBundleAtomic(b, path.join(ROOT, 'held.bundle.json'), { cwd: ROOT });
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' | '));
});

test('no requested output file preserves the ordinary early return', () => {
  assert.equal(decideHeldOnlyBundleOutput({ outputRequested: false, preflight: false }), 'EARLY_RETURN');
});
test('the no-spend preflight writes nothing even with an output path', () => {
  assert.equal(decideHeldOnlyBundleOutput({ outputRequested: true, preflight: true }), 'EARLY_RETURN');
  assert.equal(decideHeldOnlyBundleOutput({ outputRequested: false, preflight: true }), 'EARLY_RETURN');
});
test('a requested output with no READY rows writes a held-only bundle', () => {
  assert.equal(decideHeldOnlyBundleOutput({ outputRequested: true, preflight: false }), 'WRITE_HELD_ONLY');
});

// ─── Structural zero-side-effect boundary ─────────────────────────────────────

test('planner and pure bundle modules have no AI/browser/DB import path', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const files = {
    planner: 'scripts/plan-browser-ingest-from-bundle.ts',
    bundle: 'lib/analysis/browserAnalysisBundle.ts',
    identity: 'lib/analysis/sourceRowIdentity.ts',
    allowlist: 'lib/analysis/creativeAssetFiles.ts',
    assembly: 'lib/analysis/bundleAssembly.ts',
  };
  for (const [label, rel] of Object.entries(files)) {
    const src = strip(fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf-8'));
    for (const banned of ['creativeAssetAnalyser', 'PrismaClient', '@prisma/client', 'playwright', 'ingest-browser-collected-ads', 'resolveCreativeContext', 'analyseCreativeAsset']) {
      assert.ok(!src.includes(banned), `${label} (${rel}) must not reference ${banned}`);
    }
    assert.ok(!/[^.\w]fetch\s*\(/.test(src), `${label} must not call fetch(`);
  }
});
