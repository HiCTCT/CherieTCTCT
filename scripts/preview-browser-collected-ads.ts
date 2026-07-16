/**
 * Browser-Collected Ads — Dry-Run Scoring Preview
 *
 * Reads a browser-collected ads CSV, filters to READY rows, maps each row
 * into the ExampleRow shape expected by analyseAdRow(), runs the existing
 * scoring function unchanged, and prints a full scoring report.
 *
 * DRY RUN ONLY — no database writes, no ingestion, no scoring changes.
 *
 * Usage:
 *   npm run browser:preview
 *
 * Override input file:
 *   set BROWSER_ADS_FILE=data/imports/my-file.csv&& npm run browser:preview
 */

import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';

import { analyseAdRow } from '@/lib/analysis';
import type { AdFormat, AnalysisOutput, ExampleRow } from '@/lib/analysis/types';
import { resolveCreativeContext, planVisionInputs, resolveVideoMaxFrames } from '@/lib/analysis/creativeAssetAnalyser';
import type { CreativeContext, CreativeSource, VisualConfidence } from '@/lib/analysis/creativeAssetAnalyser';
import { scoreCompetitorBenchmarkAd } from '@/lib/analysis/competitorScoring';
import type { CompetitorBenchmark } from '@/lib/analysis/competitorScoring';
import {
  BUNDLE_SCHEMA_VERSION, BUNDLE_PROMPT_VERSION, BUNDLE_PLANNER_VERSION,
  buildAssetManifest, sha256File, writeBundleAtomic,
} from '@/lib/analysis/browserAnalysisBundle';
import type { BrowserAnalysisBundle, BundleRow } from '@/lib/analysis/browserAnalysisBundle';
import { assembleBundleRows, decideHeldOnlyBundleOutput } from '@/lib/analysis/bundleAssembly';
import type { BundleSuccessPayload } from '@/lib/analysis/bundleAssembly';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_FILE = 'data/imports/castlery-browser-collected-ads-pilot-01.csv';
const SCORE_THRESHOLD = 7.0;

// ── AI-preview spend controls (Phase 1A) ─────────────────────────────────────
// Local, env-driven guards for the (optional) paid Vision creative analysis this
// preview can perform. Nothing here changes scoring, verified-metadata rules,
// READY-only eligibility, or the no-DB / no-ingestion / no-browser guarantees.
//
//   AI_PREVIEW_PREFLIGHT=true       → no-spend workload report, then exit. Never
//                                     reads ANTHROPIC_API_KEY, never calls Anthropic.
//   AI_PREVIEW_MAX_ANALYSES=<int>   → hard cap on paid Vision requests (default 25).
//   AI_PREVIEW_CONFIRM_SPEND=I_UNDERSTAND
//                                   → explicit paid-spend confirmation, required IN
//                                     ADDITION to the API key and the cap check.
//   AI_PREVIEW_COST_PER_ANALYSIS=<num>  (optional)
//                                   → operator-supplied unit for an ESTIMATE only;
//                                     never live or hard-coded pricing.
const AI_PREVIEW_PREFLIGHT       = process.env.AI_PREVIEW_PREFLIGHT === 'true';
const AI_PREVIEW_SPEND_SENTINEL  = 'I_UNDERSTAND';
const AI_PREVIEW_CONFIRM_SPEND   = process.env.AI_PREVIEW_CONFIRM_SPEND;
const AI_PREVIEW_MAX_ANALYSES_DEFAULT = 25;
// Strict cap parsing. UNSET → safe default. If EXPLICITLY supplied, the WHOLE string
// must be a complete non-negative base-10 integer — no numeric-prefix parsing
// ("999oops"), no signs ("-1"), no decimals ("1.5"), no blank, no unsafe magnitudes.
// A malformed value is REJECTED (never silently replaced with the default).
// 0 is valid and hard-disables paid analysis.
type CapConfig = { ok: true; value: number } | { ok: false; reason: string };
const AI_PREVIEW_MAX_ANALYSES_CONFIG: CapConfig = ((): CapConfig => {
  const raw = process.env.AI_PREVIEW_MAX_ANALYSES;
  if (raw === undefined) return { ok: true, value: AI_PREVIEW_MAX_ANALYSES_DEFAULT };
  if (!/^\d+$/.test(raw)) {
    return { ok: false, reason: `AI_PREVIEW_MAX_ANALYSES must be a whole non-negative integer (got "${raw}")` };
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    return { ok: false, reason: `AI_PREVIEW_MAX_ANALYSES is not a safe integer (got "${raw}")` };
  }
  return { ok: true, value: n };
})();
const AI_PREVIEW_COST_PER_ANALYSIS = ((): number | null => {
  const raw = (process.env.AI_PREVIEW_COST_PER_ANALYSIS ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 ? n : null;
})();

const EXPECTED_HEADER = [
  'collection_status',
  'competitor_name',
  'meta_page_id',
  'ad_id',
  'ad_library_url',
  'media_type',
  'publisher_platforms',
  'ad_delivery_start_time',
  'ad_copy',
  'headline',
  'description',
  'landing_page_url',
  'notes',
  'visual_description',
  'creative_notes',
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

type BrowserAdRow = {
  collection_status: string;
  competitor_name: string;
  meta_page_id: string;
  ad_id: string;
  ad_library_url: string;
  media_type: string;
  publisher_platforms: string;
  ad_delivery_start_time: string;
  ad_copy: string;
  headline: string;
  description: string;
  landing_page_url: string;
  notes: string;
  // Optional analyst-context columns (added Phase 7.5)
  visual_description: string;
  creative_notes: string;
  // Optional creative asset column (Phase 8 — vision analysis)
  creative_asset_path?: string;
};

type ScoredRow = {
  rowNumber: number;
  adId: string;
  mediaType: string;
  format: AdFormat;
  analysis: AnalysisOutput;
  copyPreview: string;
  visualDescPreview: string;
  creativeNotesPreview: string;
  // Debug fields — exact values passed into analyseAdRow()
  exampleRowAnalysis: string;
  exampleRowCreativeAnalysis: string;
  exampleRowCopy: string;
  exampleRowHeadline: string;
  exampleRowDescription: string;
  copyWasContaminated: boolean;
  rawAdCopy: string;
  creativeSource: CreativeSource;
  // Vision's own confidence in reading the supplied visual sequence (VIDEO only).
  // Deliberately SEPARATE from benchmark.confidence (evidence-source confidence).
  visualConfidence?: VisualConfidence;
  // Phase 1 — inputs for the optional reusable analysis bundle. Recording only;
  // these have no effect on scoring.
  sourceStatus: string;
  assetPath: string;
  plannedAssetFiles: string[];
  copyUsedForScoring: string;
  benchmark: CompetitorBenchmark;
  error: null;
};

type ErroredRow = {
  rowNumber: number;
  adId: string;
  mediaType: string;
  error: string;
};

type RowResult = ScoredRow | ErroredRow;

function isErrored(r: RowResult): r is ErroredRow {
  return r.error !== null;
}

// ─── Copy cleaning ────────────────────────────────────────────────────────────

/**
 * Detects comment-contaminated ad_copy (e.g. UGC comment dumps captured by the browser).
 * Conservative patterns only — false negatives are preferred over false positives.
 *
 * Flags as contaminated when:
 *  1. Copy starts with a separator character: ; | ,
 *  2. Copy contains 3+ semicolon-separated segments that are all short (avg < 120 chars)
 *
 * Returns cleanedCopy (undefined if entire content is contaminated) and a wasContaminated flag.
 */
function cleanAdCopy(raw: string): { cleanedCopy: string | undefined; wasContaminated: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { cleanedCopy: undefined, wasContaminated: false };

  // Pattern 1: leading separator character (; | ,)
  if (/^[;|,]/.test(trimmed)) {
    return { cleanedCopy: undefined, wasContaminated: true };
  }

  // Pattern 2: multiple semicolons with short segments — UGC comment concatenation
  const parts = trimmed.split(';');
  if (parts.length >= 3) {
    const avgLen =
      parts.map((p) => p.trim().length).reduce((a, b) => a + b, 0) / parts.length;
    if (avgLen < 120) {
      return { cleanedCopy: undefined, wasContaminated: true };
    }
  }

  return { cleanedCopy: trimmed, wasContaminated: false };
}

// ─── Format derivation ────────────────────────────────────────────────────────

type FormatDerivation =
  | { ok: true;  format: AdFormat }
  | { ok: false; reason: string  };

function deriveFormat(mediaType: string): FormatDerivation {
  const mt = mediaType.trim().toUpperCase();
  if (mt === 'IMAGE' || mt === 'CAROUSEL') return { ok: true, format: 'STATIC' };
  if (mt === 'VIDEO')                       return { ok: true, format: 'VIDEO'  };
  return { ok: false, reason: `media_type="${mediaType}" is not IMAGE, CAROUSEL, or VIDEO — cannot derive format` };
}

// ─── ExampleRow mapping ───────────────────────────────────────────────────────
//
// Maps a browser-collected CSV row to the ExampleRow shape that analyseAdRow()
// expects. Mirrors the mapping in metaIngestion.ts normaliseRecord() without
// importing that DB-coupled module.

// creative context is resolved before this call (ASSET / MANUAL / FALLBACK).
// visual_description → 'Creative Analysis' → creativeAnalysisText in scorer
// creative_notes     → 'Analysis'          → analysisNotes in scorer
// ── Verified ad-level metadata sidecar (read-only join, fail-closed) ──────────
// Produced by browser:capture-assets. Canonical name: example.csv and
// example.with-assets.csv BOTH map to example.verified-meta.csv. A field is usable only
// when its own status is ACCEPT (headline_status / description_status independently).
// Absent / malformed / unreadable / duplicate-ad_id sidecars yield NO verified values
// for the affected ad/file; raw browser CSV headline/description are never used.
type VerifiedMeta = {
  headline: string; headlineStatus: string; headlineReason: string;
  description: string; descriptionStatus: string; descriptionReason: string;
  cta: string; displayUrl: string; landingUrl: string; strategy: string;
  status: string; reason: string;
};
type VerifiedMetaLoad = { map: Map<string, VerifiedMeta>; status: string; message: string };

function verifiedMetaPathFor(inputFile: string): string {
  const dir = path.dirname(inputFile);
  const base = path.basename(inputFile, '.csv').replace(/\.with-assets$/, '');
  return path.join(dir, `${base}.verified-meta.csv`);
}

const VERIFIED_REQUIRED_COLS = ['ad_id', 'verified_headline', 'verified_description', 'cta', 'display_url', 'landing_url', 'capture_strategy', 'headline_status', 'headline_reason', 'description_status', 'description_reason', 'verification_status', 'verification_reason', 'captured_at'];

function loadVerifiedMeta(inputFile: string): VerifiedMetaLoad {
  const map = new Map<string, VerifiedMeta>();
  const p = verifiedMetaPathFor(inputFile);
  if (!fs.existsSync(p)) return { map, status: 'absent', message: `absent — no sidecar at ${p}` };
  let raw: string;
  try { raw = fs.readFileSync(p, 'utf-8'); } catch (e) { return { map, status: 'unreadable', message: `unreadable: ${e instanceof Error ? e.message : String(e)}` }; }
  let rows: Record<string, string>[];
  try { rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[]; } catch (e) { return { map, status: 'malformed', message: `malformed CSV: ${e instanceof Error ? e.message : String(e)}` }; }
  if (rows.length === 0) return { map, status: 'empty', message: 'present but contains no data rows' };
  const cols = Object.keys(rows[0]!);
  const missing = VERIFIED_REQUIRED_COLS.filter((c) => !cols.includes(c));
  if (missing.length) return { map, status: 'malformed', message: `malformed header — missing columns: ${missing.join(', ')}` };
  // Any duplicate non-empty ad_id invalidates the ENTIRE sidecar (fail closed): return an
  // empty map so NO ad from this file contributes verified headline/description.
  const counts = new Map<string, number>();
  for (const r of rows) { const id = (r.ad_id ?? '').trim(); if (id) counts.set(id, (counts.get(id) ?? 0) + 1); }
  const dups = Array.from(counts.entries()).filter(([, n]) => n > 1).map(([id]) => id);
  if (dups.length) return { map, status: 'duplicates', message: `duplicate ad_id(s) — entire sidecar ignored (fail closed): ${dups.join(', ')}` };
  for (const r of rows) {
    const id = (r.ad_id ?? '').trim();
    if (!id) continue;
    map.set(id, {
      headline:    (r.verified_headline ?? '').trim(),    headlineStatus:    (r.headline_status ?? '').trim().toUpperCase(),    headlineReason:    (r.headline_reason ?? '').trim(),
      description: (r.verified_description ?? '').trim(), descriptionStatus: (r.description_status ?? '').trim().toUpperCase(), descriptionReason: (r.description_reason ?? '').trim(),
      cta:         (r.cta ?? '').trim(),                  displayUrl:        (r.display_url ?? '').trim(),                      landingUrl:        (r.landing_url ?? '').trim(),
      strategy:    (r.capture_strategy ?? '').trim(),
      status:      (r.verification_status ?? '').trim().toUpperCase(),  reason: (r.verification_reason ?? '').trim(),
    });
  }
  return { map, status: 'ok', message: `ok — ${map.size} usable row(s)` };
}

function toExampleRow(row: BrowserAdRow, creative: CreativeContext, verified?: VerifiedMeta): ExampleRow {
  // Strip comment-contaminated ad_copy before passing to scorer.
  // cleanedCopy is undefined when the entire field is contaminated. Headline and
  // description are also excluded (unscoped listing metadata), so there is no
  // headline fallback — scoring relies on the available creative context and other valid fields.
  const { cleanedCopy } = cleanAdCopy(row.ad_copy);
  return {
    Product:      row.competitor_name.trim() || 'Unknown Advertiser',
    'Ad Link':    row.ad_library_url.trim()  || undefined,
    Copy:         cleanedCopy                || undefined,
    // Verified ad-level metadata is the ONLY accepted source of headline/description,
    // gated PER FIELD. Raw browser listing headline/description are never used.
    Headline:     (verified && verified.headlineStatus === 'ACCEPT' && verified.headline) ? verified.headline : undefined,
    Description:  (verified && verified.descriptionStatus === 'ACCEPT' && verified.description) ? verified.description : undefined,
    'Active Since': row.ad_delivery_start_time.trim() || undefined,
    Analysis:            creative.creative_notes      || undefined,
    'Creative Analysis': creative.visual_description  || undefined,
    Improvement:              undefined,
    'Creative Improvements':  undefined,
    'Other Feedbacks':        undefined,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(str: string | undefined, max: number): string {
  if (!str) return '(empty)';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function scoreBar(score: number): string {
  const filled = Math.round(score);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${score.toFixed(1)}`;
}

function fmt(n: number | null): string {
  return n === null ? 'N/A (not provided)' : n.toFixed(1);
}

// ─── API key guard ────────────────────────────────────────────────────────────

/**
 * Aborts if any READY row has creative_asset_path set but ANTHROPIC_API_KEY
 * is absent. Called after bucketing rows, before any API call or DB access.
 */
function assertApiKeyIfAssets(
  readyRows: Array<{ row: BrowserAdRow; rowNumber: number }>,
): void {
  const rowsWithAssets = readyRows.filter(({ row }) => row.creative_asset_path?.trim());
  if (rowsWithAssets.length === 0) return;

  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    const rowNums = rowsWithAssets.map((r) => r.rowNumber).join(', ');
    console.error('\n❌ ANTHROPIC_API_KEY is required.');
    console.error(`   ${rowsWithAssets.length} READY row(s) have creative_asset_path set (row(s): ${rowNums}).`);
    console.error('   Set ANTHROPIC_API_KEY=<key> before re-running,');
    console.error('   or remove creative_asset_path from those rows to run without vision analysis.');
    process.exit(1);
  }
}

// ── AI-preview workload counting (Phase 1A / 1C) ─────────────────────────────
// Counts the paid Vision workload for a file WITHOUT reading the API key, calling
// Anthropic, scoring, or touching the DB. File selection mirrors
// analyseCreativeAsset() via the shared planner: a CAROUSEL folder sends every card
// image in ONE request; a VIDEO folder sends up to AI_VIDEO_MAX_FRAMES sequential
// frames in ONE request; an IMAGE folder uses its one eligible image; a single file
// is that one file. Every ad is exactly ONE logical Vision request.
type AdVisionUnit = {
  adId: string; mediaType: string; exists: boolean;
  kind: string;           // CAROUSEL | VIDEO | IMAGE | SINGLE_FILE | NONE | MISSING
  eligibleFiles: number;  // eligible creative files present at the path
  plannedInputs: number;  // images actually sent in this ad's ONE request
};
type AiWorkload = {
  readyWithPath: number;      // READY rows with a non-blank creative_asset_path
  pathMissing: number;        // path set but not found on disk (→ manual fallback, no Vision)
  noEligibleFiles: number;    // path found but 0 ELIGIBLE creative files → NOT sent to Vision
  visionAnalyses: number;     // one Vision request each
  eligibleFilesTotal: number; // eligible creative files present across Vision-eligible ads
  plannedInputsTotal: number; // images that would ACTUALLY be sent
  units: AdVisionUnit[];
};

// Uses the SHARED planner (planVisionInputs) that the analyser itself uses to build a
// request, so these counts are exactly the payload a paid run would send. Debug /
// audit / diagnostic / full-page / modal / support files are excluded by the allowlist.
function computeAiWorkload(
  readyRows: Array<{ row: BrowserAdRow; rowNumber: number }>,
  maxVideoFrames: number,
): AiWorkload {
  const units: AdVisionUnit[] = [];
  let readyWithPath = 0, pathMissing = 0, noEligibleFiles = 0, visionAnalyses = 0;
  let eligibleFilesTotal = 0, plannedInputsTotal = 0;
  for (const { row } of readyRows) {
    const assetPath = row.creative_asset_path?.trim() ?? '';
    if (!assetPath) continue;
    readyWithPath++;
    const adId = row.ad_id.trim();
    const mt = row.media_type.trim().toUpperCase();
    const resolved = path.resolve(assetPath);
    if (!fs.existsSync(resolved)) {
      pathMissing++;
      units.push({ adId, mediaType: mt, exists: false, kind: 'MISSING', eligibleFiles: 0, plannedInputs: 0 });
      continue;
    }
    const plan = planVisionInputs(resolved, row.media_type, maxVideoFrames);
    if (plan.planned.length === 0) {
      noEligibleFiles++;
      units.push({ adId, mediaType: mt, exists: true, kind: 'NONE', eligibleFiles: plan.eligible.length, plannedInputs: 0 });
      continue;
    }
    visionAnalyses++;
    eligibleFilesTotal  += plan.eligible.length;
    plannedInputsTotal  += plan.planned.length;
    units.push({ adId, mediaType: mt, exists: true, kind: plan.kind, eligibleFiles: plan.eligible.length, plannedInputs: plan.planned.length });
  }
  return { readyWithPath, pathMissing, noEligibleFiles, visionAnalyses, eligibleFilesTotal, plannedInputsTotal, units };
}

// ── Exact-ID preview filter (Phase 1C) ───────────────────────────────────────
// AI_PREVIEW_ONLY_AD_IDS: comma-separated EXACT numeric Meta Library IDs. Absent →
// the normal READY workload. Whitespace is trimmed; malformed / empty / duplicate
// entries FAIL CLOSED. Matching is exact string equality — never partial/substring.
type IdFilter = { ok: true; ids: string[] | null } | { ok: false; reason: string };
function resolveOnlyAdIds(): IdFilter {
  const raw = process.env.AI_PREVIEW_ONLY_AD_IDS;
  if (raw === undefined) return { ok: true, ids: null };
  const parts = raw.split(',').map((s) => s.trim());
  const seen = new Set<string>();
  for (const p of parts) {
    if (p === '') return { ok: false, reason: 'AI_PREVIEW_ONLY_AD_IDS contains an empty entry (check stray or trailing commas)' };
    if (!/^\d+$/.test(p)) return { ok: false, reason: `AI_PREVIEW_ONLY_AD_IDS contains a non-numeric entry ("${p}")` };
    if (seen.has(p)) return { ok: false, reason: `AI_PREVIEW_ONLY_AD_IDS contains a duplicate id ("${p}")` };
    seen.add(p);
  }
  return { ok: true, ids: Array.from(seen) };
}

function buildSkippedByStatus(rawRows: Record<string, string>[]): Array<{ status: string; count: number }> {
  const m = new Map<string, number>();
  for (const raw of rawRows) {
    const s = (raw.collection_status ?? '').trim().toUpperCase();
    if (s === 'READY') continue;
    const key = s || '(blank)';
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return Array.from(m.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => a.status.localeCompare(b.status));
}

function printAiPreflight(
  LINE: string,
  DIV: string,
  filePath: string,
  totalRows: number,
  readyCount: number,
  skipped: Array<{ status: string; count: number }>,
  workload: AiWorkload,
  cap: number,
  maxVideoFrames: number,
): void {
  const allowed = workload.visionAnalyses <= cap;
  console.log(`\n${LINE}`);
  console.log('  AI PREVIEW PREFLIGHT — NO-SPEND WORKLOAD REPORT');
  console.log(LINE);
  console.log(`  File:                              ${filePath}`);
  console.log(`  Total input rows:                  ${totalRows}`);
  console.log(`  READY rows:                        ${readyCount}`);
  console.log('  Skipped rows by status:');
  if (skipped.length === 0) console.log('    (none)');
  for (const s of skipped) console.log(`    ${s.status.padEnd(14)} ${s.count}`);
  console.log(DIV);
  console.log(`  READY rows with creative_asset_path:            ${workload.readyWithPath}`);
  console.log(`    · asset path missing on disk:                 ${workload.pathMissing}  (manual fallback, no Vision)`);
  console.log(`    · no eligible creative files (excluded):      ${workload.noEligibleFiles}  (not sent to Vision)`);
  console.log(`  Logical ad analyses requiring Vision:           ${workload.visionAnalyses}  (one Vision request each)`);
  console.log(`  Eligible creative files present:                ${workload.eligibleFilesTotal}  (debug/support excluded)`);
  console.log(`  Planned image inputs to send:                   ${workload.plannedInputsTotal}  (actual Vision payload images)`);
  console.log(`  Configured max video frames (AI_VIDEO_MAX_FRAMES): ${maxVideoFrames}`);
  const videoUnits = workload.units.filter((u) => u.kind === 'VIDEO');
  if (videoUnits.length > 0) {
    console.log('  Video frames selected per video ad:');
    for (const u of videoUnits) {
      console.log(`    ${u.adId}   ${u.plannedInputs} of ${u.eligibleFiles} eligible frame(s)`);
    }
  }
  console.log(DIV);
  console.log(`  Configured max analyses (AI_PREVIEW_MAX_ANALYSES): ${cap}`);
  console.log(`  Cap decision (on analyses, not files):          ${allowed ? 'ALLOWED' : 'BLOCKED'}  (${workload.visionAnalyses} vs cap ${cap})`);
  if (!allowed) {
    console.log('    A paid run would FAIL CLOSED before any API call.');
    console.log('    Reduce the input, or raise AI_PREVIEW_MAX_ANALYSES explicitly.');
  }
  if (workload.noEligibleFiles > 0) {
    console.log(`  Batch gate:                        BLOCKED  (${workload.noEligibleFiles} READY row(s) have an asset path with no eligible creative file)`);
    console.log('    A paid run would FAIL CLOSED for the WHOLE batch before any API call.');
  }
  if (AI_PREVIEW_COST_PER_ANALYSIS !== null) {
    const est = (workload.visionAnalyses * AI_PREVIEW_COST_PER_ANALYSIS).toFixed(4);
    console.log('  ESTIMATE (operator-configured unit, NOT live pricing):');
    console.log(`    ${workload.visionAnalyses} × ${AI_PREVIEW_COST_PER_ANALYSIS} = ${est}  (from AI_PREVIEW_COST_PER_ANALYSIS)`);
  }
  console.log(DIV);
  console.log('  NO Anthropic API call.  NO database write.  NO ingestion.  NO browser.');
  console.log('  ANTHROPIC_API_KEY is NOT required and NOT read in preflight mode.');
  console.log(LINE);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const LINE = '═'.repeat(63);
  const DIV  = '─'.repeat(63);

  // ── AI-preview cap config (Phase 1A): reject a malformed value before anything ──
  if (!AI_PREVIEW_MAX_ANALYSES_CONFIG.ok) {
    console.error('\n❌ Invalid AI-preview configuration — refusing to run.');
    console.error(`   ${AI_PREVIEW_MAX_ANALYSES_CONFIG.reason}`);
    console.error(`   Accepted: unset (default ${AI_PREVIEW_MAX_ANALYSES_DEFAULT}), or a whole non-negative integer such as 0, 5, 25.`);
    console.error('   0 hard-disables paid Vision analysis.');
    process.exit(1);
  }
  const aiMaxAnalyses = AI_PREVIEW_MAX_ANALYSES_CONFIG.value;

  // ── Video frame budget: reject a malformed AI_VIDEO_MAX_FRAMES before anything ──
  const videoFramesCfg = resolveVideoMaxFrames();
  if (!videoFramesCfg.ok) {
    console.error('\n❌ Invalid AI-preview configuration — refusing to run.');
    console.error(`   ${videoFramesCfg.reason}`);
    console.error('   Accepted: unset (default 4), or a whole integer >= 1. 0 is invalid for a paid video analysis.');
    process.exit(1);
  }
  const aiMaxVideoFrames = videoFramesCfg.value;

  // ── Exact-ID filter: reject a malformed AI_PREVIEW_ONLY_AD_IDS before anything ──
  const idFilter = resolveOnlyAdIds();
  if (!idFilter.ok) {
    console.error('\n❌ Invalid AI-preview configuration — refusing to run.');
    console.error(`   ${idFilter.reason}`);
    console.error('   Accepted: unset, or a comma-separated list of exact numeric Library IDs.');
    process.exit(1);
  }

  // Opt-in reusable-bundle output. Resolved up front because a held-only scope must
  // still be able to produce a requested bundle after the early returns below.
  const bundleOut = (process.env.AI_PREVIEW_OUTPUT_FILE ?? '').trim();

  // ── Resolve file path ────────────────────────────────────────────────────────
  const filePath = path.resolve(process.env.BROWSER_ADS_FILE ?? DEFAULT_FILE);

  console.log(`\n${LINE}`);
  console.log('  Browser-Collected Ads — Scoring Preview');
  console.log(LINE);
  console.log(`  Mode:         DRY RUN — SCORING PREVIEW ONLY`);
  console.log(`  File:         ${filePath}`);
  console.log(`  Score threshold: ${SCORE_THRESHOLD.toFixed(1)}`);
  console.log(`  DB writes:    0`);
  console.log(`  Ingestion:    none`);
  console.log(LINE);

  // ── Read and parse CSV ───────────────────────────────────────────────────────
  if (!fs.existsSync(filePath)) {
    console.error(`\n❌ File not found: ${filePath}`);
    console.error('   Set BROWSER_ADS_FILE to override the default path.');
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  const rawRows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  if (rawRows.length === 0) {
    console.error('\n❌ CSV has no data rows.');
    process.exit(1);
  }

  // ── Validate header ──────────────────────────────────────────────────────────
  const actualCols  = Object.keys(rawRows[0]!);
  const missingCols = EXPECTED_HEADER.filter((c) => !actualCols.includes(c));

  if (missingCols.length > 0) {
    console.error(`\n❌ Missing required columns: ${missingCols.join(', ')}`);
    process.exit(1);
  }

  // ── Bucket rows by status ────────────────────────────────────────────────────
  let needsReviewCount = 0;
  let skipCount        = 0;
  let otherCount       = 0;
  const readyRows: Array<{ row: BrowserAdRow; rowNumber: number }> = [];

  rawRows.forEach((raw, idx) => {
    const row    = raw as unknown as BrowserAdRow;
    const status = (row.collection_status ?? '').trim().toUpperCase();
    const rowNum = idx + 2; // 1-based + header offset

    if      (status === 'READY')        readyRows.push({ row, rowNumber: rowNum });
    else if (status === 'NEEDS_REVIEW') needsReviewCount++;
    else if (status === 'SKIP')         skipCount++;
    else                                otherCount++;
  });

  console.log(`\n${DIV}`);
  console.log('  Input Summary');
  console.log(DIV);
  console.log(`  Total rows read:        ${rawRows.length}`);
  console.log(`  READY (will score):     ${readyRows.length}`);
  console.log(`  NEEDS_REVIEW (skipped): ${needsReviewCount}`);
  console.log(`  SKIP (skipped):         ${skipCount}`);
  if (otherCount > 0) console.log(`  Other/unknown (skipped):${otherCount}`);

  if (readyRows.length === 0) {
    console.log('\n  ⚠  No READY rows found. Nothing to score.');
    // A held-only scope is an honest result. When an output file was requested, record
    // it rather than producing nothing — no READY row means no Anthropic call is needed.
    if (decideHeldOnlyBundleOutput({ outputRequested: bundleOut !== '', preflight: AI_PREVIEW_PREFLIGHT }) === 'WRITE_HELD_ONLY') {
      writeAnalysisBundle({ bundleOut, filePath, rawRows, idFilter, aiMaxVideoFrames, scored: [], errored: [], LINE });
    }
    printSafetyFooter(LINE);
    return;
  }

  // ── Exact-ID selection (Phase 1C) ────────────────────────────────────────────
  // The SAME filtered set is used by the preflight and by paid mode. Exact string
  // equality only — no partial or substring matching.
  let workRows = readyRows;
  if (idFilter.ids) {
    const wanted   = new Set(idFilter.ids);
    const allIds   = new Set(rawRows.map((r) => (r.ad_id ?? '').trim()).filter(Boolean));
    const readyIds = new Set(readyRows.map(({ row }) => row.ad_id.trim()));
    workRows = readyRows.filter(({ row }) => wanted.has(row.ad_id.trim()));
    const notPresent = idFilter.ids.filter((id) => !allIds.has(id));
    const notReady   = idFilter.ids.filter((id) => allIds.has(id) && !readyIds.has(id));

    console.log(`\n${DIV}`);
    console.log('  Exact-ID filter (AI_PREVIEW_ONLY_AD_IDS)');
    console.log(DIV);
    console.log(`  Requested IDs:        ${idFilter.ids.length}  (${idFilter.ids.join(', ')})`);
    console.log(`  Matched READY rows:   ${workRows.length}`);
    if (notPresent.length > 0) console.log(`  ⚠  Not present in file: ${notPresent.join(', ')}`);
    if (notReady.length > 0)   console.log(`  ⚠  Present but not READY (skipped): ${notReady.join(', ')}`);
    if (workRows.length === 0) {
      console.log('\n  ⚠  No requested ID matched a READY row — nothing to process.');
      // The requested ads exist but are all held/skipped/unavailable: record that
      // honestly when an output file was requested. Requested IDs that are absent
      // from the source still fail inside the writer.
      if (decideHeldOnlyBundleOutput({ outputRequested: bundleOut !== '', preflight: AI_PREVIEW_PREFLIGHT }) === 'WRITE_HELD_ONLY') {
        writeAnalysisBundle({ bundleOut, filePath, rawRows, idFilter, aiMaxVideoFrames, scored: [], errored: [], LINE });
      }
      printSafetyFooter(LINE);
      return;
    }
  }

  // ── AI-preview spend controls (Phase 1A) ─────────────────────────────────────
  // Compute the paid Vision workload up front (no key read, no API call, no DB).
  const aiWorkload = computeAiWorkload(workRows, aiMaxVideoFrames);

  // No-spend preflight: report the workload + cap decision and STOP. This path
  // never reads ANTHROPIC_API_KEY, never calls Anthropic, and never scores.
  if (AI_PREVIEW_PREFLIGHT) {
    printAiPreflight(LINE, DIV, filePath, rawRows.length, workRows.length, buildSkippedByStatus(rawRows), aiWorkload, aiMaxAnalyses, aiMaxVideoFrames);
    console.log('');
    printSafetyFooter(LINE);
    return;
  }

  // ── Paid path — every gate below runs BEFORE any Anthropic call ──────────────
  // 1) API key required when any selected READY row carries a creative_asset_path.
  assertApiKeyIfAssets(workRows);
  // 2) WHOLE-BATCH integrity gate: if ANY READY row has an asset path but no eligible
  //    creative file after filtering, fail closed for the ENTIRE batch here — before
  //    scoring — so a mixed batch can never spend on the valid rows and only then hit
  //    an invalid one. Counts only; no secrets are printed.
  if (aiWorkload.noEligibleFiles > 0) {
    const badIds = aiWorkload.units.filter((u) => u.exists && u.eligibleFiles === 0).map((u) => u.adId);
    console.error('\n❌ Batch blocked: READY row(s) have an asset path with no eligible creative file — no API call made.');
    console.error(`   Affected rows: ${aiWorkload.noEligibleFiles} of ${aiWorkload.readyWithPath} READY row(s) with an asset path.`);
    if (badIds.length > 0) console.error(`   Library ID(s): ${badIds.join(', ')}`);
    console.error('   Eligible creative files are image-NN / card-NN / frame-NN images only.');
    console.error('   Re-capture those ads, or clear their creative_asset_path, then re-run.');
    console.error('   Inspect with the no-spend preflight:  AI_PREVIEW_PREFLIGHT=true');
    process.exit(1);
  }
  // 3) Explicit spend confirmation + hard cap, but only when real Vision requests
  //    would occur (assets present AND found on disk). Fail closed before scoring.
  if (aiWorkload.visionAnalyses > 0) {
    if (AI_PREVIEW_CONFIRM_SPEND !== AI_PREVIEW_SPEND_SENTINEL) {
      console.error('\n❌ Paid Vision preview is not confirmed — no API call made.');
      console.error(`   ${aiWorkload.visionAnalyses} READY ad(s) would each make one Vision request.`);
      console.error('   Run the no-spend preflight first:   AI_PREVIEW_PREFLIGHT=true');
      console.error(`   Then authorise paid analysis with:  AI_PREVIEW_CONFIRM_SPEND=${AI_PREVIEW_SPEND_SENTINEL}`);
      process.exit(1);
    }
    if (aiWorkload.visionAnalyses > aiMaxAnalyses) {
      console.error('\n❌ Vision analysis count exceeds the cap — failing closed before any API call.');
      console.error(`   Analyses required: ${aiWorkload.visionAnalyses}   Cap (AI_PREVIEW_MAX_ANALYSES): ${aiMaxAnalyses}`);
      if (aiMaxAnalyses === 0) console.error('   Cap is 0 — paid Vision analysis is hard-disabled.');
      console.error('   Reduce the input, or raise AI_PREVIEW_MAX_ANALYSES explicitly to proceed.');
      process.exit(1);
    }
  }

  // Verified ad-level metadata sidecar (read-only, fail-closed). Per-field ACCEPT is the
  // only source of headline/description; raw CSV headline/description are ignored entirely.
  const verifiedLoad = loadVerifiedMeta(filePath);
  const verifiedMeta = verifiedLoad.map;
  console.log(`  Verified-meta sidecar: ${verifiedMetaPathFor(filePath)}`);
  console.log(`    status: ${verifiedLoad.status.toUpperCase()} — ${verifiedLoad.message}`);
  if (verifiedLoad.status !== 'ok') console.log('    ⚠  No verified headline/description will be used from this sidecar (fail closed).');

  // ── Score each READY row ─────────────────────────────────────────────────────
  const results: RowResult[] = [];
  let staticCount  = 0;
  let videoCount   = 0;
  let invalidCount = 0;

  for (const { row, rowNumber } of workRows) {
    const adId = row.ad_id.trim() || `(row ${rowNumber})`;
    const verified = verifiedMeta.get(row.ad_id.trim());
    const vUsedH = !!(verified && verified.headlineStatus === 'ACCEPT' && verified.headline);
    const vUsedD = !!(verified && verified.descriptionStatus === 'ACCEPT' && verified.description);
    console.log(`  • verified-meta [${adId}]: ${verified ? `overall=${verified.status} strategy=${verified.strategy}` : 'NONE (no usable sidecar row)'} | headline ${vUsedH ? `ACCEPT used: "${truncate(verified!.headline, 60)}"` : `blank (${verified ? verified.headlineStatus : 'no row'})`} | description ${vUsedD ? `ACCEPT used: "${truncate(verified!.description, 60)}"` : `blank (${verified ? verified.descriptionStatus : 'no row'})`}`);

    const derived = deriveFormat(row.media_type);
    if (!derived.ok) {
      invalidCount++;
      results.push({ rowNumber, adId, mediaType: row.media_type, error: derived.reason });
      continue;
    }

    const format = derived.format;
    if (format === 'STATIC') staticCount++;
    else                     videoCount++;

    try {
      // Resolve creative context: ASSET (vision API) → MANUAL (CSV text) → FALLBACK
      const creative = await resolveCreativeContext(row, row.media_type);

      const exampleRow = toExampleRow(row, creative, verified);
      const analysis   = analyseAdRow(exampleRow, format);
      const benchmark  = scoreCompetitorBenchmarkAd(analysis, creative.source);
      const { wasContaminated: copyWasContaminated } = cleanAdCopy(row.ad_copy);
      results.push({
        rowNumber,
        adId,
        mediaType: row.media_type.trim().toUpperCase(),
        format,
        analysis,
        benchmark,
        copyPreview:          truncate(row.ad_copy.trim(), 80),
        visualDescPreview:    truncate(creative.visual_description, 80),
        creativeNotesPreview: truncate(creative.creative_notes, 80),
        // Capture the exact ExampleRow values sent to the scorer for debugging
        exampleRowAnalysis:           exampleRow.Analysis              ?? '(empty)',
        exampleRowCreativeAnalysis:   exampleRow['Creative Analysis']  ?? '(empty)',
        exampleRowCopy:               exampleRow.Copy                  ?? '(empty)',
        exampleRowHeadline:           exampleRow.Headline              ?? '(empty)',
        exampleRowDescription:        exampleRow.Description           ?? '(empty)',
        copyWasContaminated,
        rawAdCopy:            row.ad_copy.trim(),
        creativeSource:       creative.source,
        visualConfidence:     creative.visual_confidence,
        sourceStatus:         (row.collection_status ?? '').trim(),
        assetPath:            row.creative_asset_path?.trim() ?? '',
        plannedAssetFiles:    (() => {
          const p = row.creative_asset_path?.trim();
          if (!p) return [] as string[];
          const resolved = path.resolve(p);
          if (!fs.existsSync(resolved)) return [] as string[];
          return planVisionInputs(resolved, row.media_type, aiMaxVideoFrames).planned;
        })(),
        copyUsedForScoring:   exampleRow.Copy ?? '',
        error: null,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ rowNumber, adId, mediaType: row.media_type, error: `Scoring threw: ${message}` });
      invalidCount++;
    }
  }

  const scored  = results.filter((r): r is ScoredRow  => !isErrored(r));
  const errored = results.filter((r): r is ErroredRow =>  isErrored(r));

  // ── Format breakdown ─────────────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log('  Format Breakdown');
  console.log(DIV);
  console.log(`  STATIC (IMAGE + CAROUSEL): ${staticCount}`);
  console.log(`  VIDEO:                     ${videoCount}`);
  if (invalidCount > 0) {
    console.log(`  Invalid / errored:         ${invalidCount}`);
  }

  // ── Per-row scoring detail ───────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  Per-Row Scoring Detail');
  console.log(LINE);

  for (const result of results) {
    if (isErrored(result)) {
      console.log(`\n  ✗ Row ${result.rowNumber}  ad_id=${result.adId}`);
      console.log(`    media_type: ${result.mediaType}`);
      console.log(`    ❌ ERROR: ${result.error}`);
      continue;
    }

    const {
      rowNumber, adId, mediaType, format, analysis,
      copyPreview, visualDescPreview, creativeNotesPreview,
      exampleRowAnalysis, exampleRowCreativeAnalysis,
      exampleRowCopy, exampleRowHeadline, exampleRowDescription,
      copyWasContaminated, rawAdCopy, creativeSource, visualConfidence, benchmark,
    } = result;

    const sourceLabel =
      creativeSource === 'ASSET'    ? '[ASSET]    — vision analysis from creative_asset_path' :
      creativeSource === 'MANUAL'   ? '[MANUAL]   — from CSV visual_description / creative_notes' :
                                      '[FALLBACK] — machine-scored baseline (no asset or manual text)';
    const qualIcon = analysis.qualified ? '✓' : '○';

    console.log(`\n  ${qualIcon} Row ${rowNumber}  ad_id=${adId}`);
    console.log(`    media_type:     ${mediaType}  →  format: ${format}`);
    console.log(`    Creative source:${sourceLabel}`);
    // Vision's confidence in reading the supplied visual sequence. This is NOT the
    // competitor-benchmark confidence below, and is never mapped into it.
    console.log(`    Visual confidence: ${visualConfidence ?? 'N/A'}   [Vision: model confidence identifying the supplied visual sequence]`);
    if (copyWasContaminated) {
      console.log(`    ⚠  WARN [ad_copy]: comment-contaminated — excluded from scorer Copy field`);
      console.log(`    Raw copy:       ${truncate(rawAdCopy, 80)}`);
      console.log(`    Scorer Copy:    (empty — scorer will use Headline instead)`);
    } else {
      console.log(`    Copy preview:   ${copyPreview}`);
    }
    console.log(`    Visual desc:    ${visualDescPreview}`);
    console.log(`    Creative notes: ${creativeNotesPreview}`);
    console.log('');
    console.log('    ── [ExampleRow sent to analyseAdRow] ──────────────────');
    console.log(`      Analysis:          ${truncate(exampleRowAnalysis, 120)}`);
    console.log(`      Creative Analysis: ${truncate(exampleRowCreativeAnalysis, 120)}`);
    console.log(`      Copy:              ${truncate(exampleRowCopy, 120)}`);
    console.log(`      Headline:          (excluded — unscoped browser listing metadata, not scored)`);
    console.log(`      Description:       (excluded — unscoped browser listing metadata, not scored)`);
    console.log('    ───────────────────────────────────────────────────────');
    console.log('');
    // ── Competitor benchmark (primary lens for competitor ads) ──
    const confIcon = benchmark.confidence === 'HIGH' ? '🟢' : benchmark.confidence === 'MEDIUM' ? '🟡' : '🔴';
    console.log('    ══ COMPETITOR BENCHMARK (primary for competitor ads) ══');
    console.log(`    Benchmark score:  ${scoreBar(benchmark.benchmarkScore)}`);
    console.log(`    Benchmark tier:   ${benchmark.tier}`);
    console.log(`    Benchmark confidence: ${confIcon} ${benchmark.confidence}   [evidence-source confidence — NOT visual confidence]`);
    console.log(`    Evidence source:  ${benchmark.evidenceSource}`);
    console.log(`    Formula:          ${benchmark.formula}`);
    console.log(`    Inputs:           ${benchmark.breakdown.map((b) => `${b.label}=${b.value.toFixed(1)}×${b.weight}`).join('  ')}`);
    if (benchmark.warning) console.log(`    ⚠  ${benchmark.warning}`);
    console.log('');
    // ── Internal QA score (OOM internal scorer — shown for comparison only) ──
    console.log(`    Internal QA score: ${scoreBar(analysis.overallScore)}`);
    console.log(`    QA qualified:      ${analysis.qualified ? `YES ✓  (≥ ${SCORE_THRESHOLD})` : `NO    (below ${SCORE_THRESHOLD})`}   [internal QA gate — not the competitor decision]`);
    console.log(`    QA final verdict:  ${analysis.finalVerdict}`);
    console.log('');
    console.log('    Component scores:');
    console.log(`      Copy:         ${fmt(analysis.copyScore)}`);
    console.log(`      Headline:     ${fmt(analysis.headlineScore)}`);
    console.log(`      Description:  ${fmt(analysis.descriptionScore)}`);
    console.log(`      Creative:     ${fmt(analysis.creativeScore)}`);
    console.log(`      Clarity:      ${analysis.clarityScore.toFixed(1)}`);
    console.log(`      Connection:   ${analysis.connectionScore.toFixed(1)}`);
    console.log(`      Conviction:   ${analysis.convictionScore.toFixed(1)}`);
    console.log('');
    console.log('    AIDA scores:');
    console.log(`      Attention:    ${analysis.aidaScores.attention.toFixed(1)}`);
    console.log(`      Interest:     ${analysis.aidaScores.interest.toFixed(1)}`);
    console.log(`      Desire:       ${analysis.aidaScores.desire.toFixed(1)}`);
    console.log(`      Action:       ${analysis.aidaScores.action.toFixed(1)}`);
    console.log('');
    console.log(`    Funnel stage:  ${analysis.funnelStage}`);
    console.log(`    RACE stage:    ${analysis.raceStage}`);
    console.log(`    Trust funnel:  ${analysis.trustFunnelStage}`);

    const activeTriggers = analysis.behaviouralTriggers.filter(
      (t) => t.strength !== 'MISSING',
    );
    if (activeTriggers.length > 0) {
      const triggerStr = activeTriggers
        .map((t) => `${t.name} (${t.strength})`)
        .join(', ');
      console.log(`    Triggers:      ${triggerStr}`);
    } else {
      console.log('    Triggers:      none detected');
    }

    if (analysis.strengths.length > 0) {
      const top = analysis.strengths.slice(0, 2);
      console.log(`    Strengths:     ${top.join(' | ')}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const totalScored    = scored.length;
  const totalErrored   = errored.length;
  const qualifiedRows  = scored.filter((r) => r.analysis.qualified);
  const avgScore       = totalScored > 0
    ? scored.reduce((sum, r) => sum + r.analysis.overallScore, 0) / totalScored
    : 0;

  const band = (lo: number, hi: number) =>
    scored.filter((r) => r.analysis.overallScore >= lo && r.analysis.overallScore < hi).length;

  console.log(`\n${LINE}`);
  console.log('  INTERNAL QA SUMMARY  (OOM internal scorer — for comparison only)');
  console.log(LINE);
  console.log(`  READY rows processed:    ${workRows.length}`);
  console.log(`  Successfully scored:     ${totalScored}`);
  if (totalErrored > 0) {
    console.log(`  Errored (not scored):    ${totalErrored}`);
  }
  console.log(`  Qualified (≥ ${SCORE_THRESHOLD}):       ${qualifiedRows.length} of ${totalScored}`);
  console.log(`  Not qualified:           ${totalScored - qualifiedRows.length} of ${totalScored}`);
  console.log(`  Average score:           ${totalScored > 0 ? avgScore.toFixed(2) : 'N/A'}`);
  console.log('');
  console.log('  Score distribution:');
  console.log(`    ≥ 9.0          :  ${scored.filter((r) => r.analysis.overallScore >= 9.0).length}`);
  console.log(`    8.0 – 8.9      :  ${band(8.0, 9.0)}`);
  console.log(`    7.0 – 7.9      :  ${band(7.0, 8.0)}`);
  console.log(`    below 7.0      :  ${scored.filter((r) => r.analysis.overallScore < 7.0).length}`);

  // ── Competitor benchmark summary (the primary lens for competitor ads) ──
  const avgBenchmark = totalScored > 0
    ? scored.reduce((sum, r) => sum + r.benchmark.benchmarkScore, 0) / totalScored
    : 0;
  const tierCount = (t: string) => scored.filter((r) => r.benchmark.tier === t).length;
  const confCount = (c: string) => scored.filter((r) => r.benchmark.confidence === c).length;

  console.log(`\n${LINE}`);
  console.log('  COMPETITOR BENCHMARK SUMMARY  (primary lens for competitor ads)');
  console.log(LINE);
  console.log(`  Average benchmark score: ${totalScored > 0 ? avgBenchmark.toFixed(2) : 'N/A'}`);
  console.log('');
  console.log('  Tier distribution:');
  console.log(`    Strong   (8.0–10) :  ${tierCount('Strong competitor signal')}`);
  console.log(`    Moderate (6.5–7.9):  ${tierCount('Moderate competitor signal')}`);
  console.log(`    Weak     (5.0–6.4):  ${tierCount('Weak competitor signal')}`);
  console.log(`    Low      (< 5.0)  :  ${tierCount('Low competitor signal')}`);
  console.log('');
  console.log('  Confidence distribution:');
  console.log(`    🟢 HIGH   (ASSET / Vision)        :  ${confCount('HIGH')}`);
  console.log(`    🟡 MEDIUM (MANUAL CSV text)       :  ${confCount('MEDIUM')}`);
  console.log(`    🔴 LOW    (FALLBACK / no evidence):  ${confCount('LOW')}`);
  const lowConf = confCount('MEDIUM') + confCount('LOW');
  if (lowConf > 0) {
    console.log('');
    console.log(`  ⚠  ${lowConf} row(s) are MEDIUM/LOW confidence — their benchmark scores`);
    console.log('     are based on manual text or no creative evidence, not Vision analysis.');
    console.log('     Do not rank them alongside HIGH-confidence rows without this caveat.');
  }

  // ── Final verdict ────────────────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  FINAL VERDICT');
  console.log(LINE);

  const hasFail = totalErrored > 0;

  if (!hasFail) {
    const strong   = scored.filter((r) => r.benchmark.tier === 'Strong competitor signal').length;
    const moderate = scored.filter((r) => r.benchmark.tier === 'Moderate competitor signal').length;
    const highConf = scored.filter((r) => r.benchmark.confidence === 'HIGH').length;
    console.log(`\n  ✓ PASS`);
    console.log(`    ${totalScored} READY row(s) scored with 0 errors.`);
    console.log('');
    console.log('    Competitor benchmark (the decision lens for competitor ads):');
    console.log(`      ${strong} strong + ${moderate} moderate competitor signal(s); ${highConf}/${totalScored} are HIGH confidence (Vision).`);
    console.log('      Use the benchmark score + tier + confidence to rank competitor ads —');
    console.log('      NOT the internal QA "qualified ≥ 7" gate, which is built for OOM\'s own ads.');
    console.log('');
    console.log(`    (Internal QA: ${qualifiedRows.length}/${totalScored} would pass the 7.0 QA gate — shown for comparison only.)`);
    console.log('    Next step: confirm these benchmark scores look right before any ingestion work.');
  } else {
    console.log(`\n  ✗ FAIL`);
    console.log(`    ${totalErrored} row(s) errored during scoring.`);
    console.log('    Review error details above. Fix the CSV or scoring input before proceeding.');
    for (const e of errored) {
      console.log(`    Row ${e.rowNumber} (ad_id=${e.adId}): ${e.error}`);
    }
  }

  // ── Optional reusable analysis bundle (Phase 1) ──────────────────────────────
  // Opt-in only. Never written during the no-spend preflight (that path returns
  // earlier). Writing does not affect scoring and touches no database.
  if (bundleOut) {
    writeAnalysisBundle({ bundleOut, filePath, rawRows, idFilter, aiMaxVideoFrames, scored, errored, LINE });
  }

  console.log('');
  printSafetyFooter(LINE);
}

/**
 * Writes the opt-in reusable analysis bundle. Row assembly lives in the pure
 * lib/analysis/bundleAssembly module, so the honesty contract is testable without
 * running preview. Called for scored runs AND for held-only scopes (no READY rows),
 * which are an honest result rather than a reason to produce nothing.
 *
 * A REQUESTED bundle that cannot be produced fails the command; it never warns.
 */
function writeAnalysisBundle(args: {
  bundleOut: string;
  filePath: string;
  rawRows: Record<string, string>[];
  idFilter: { ids: string[] | null };
  aiMaxVideoFrames: number;
  scored: ScoredRow[];
  errored: ErroredRow[];
  LINE: string;
}): void {
  const { bundleOut, filePath, rawRows, idFilter, aiMaxVideoFrames, scored, errored, LINE } = args;

  console.log(`\n${LINE}`);
  console.log('  REUSABLE ANALYSIS BUNDLE');
  console.log(LINE);

  const fail = (msg: string, details: string[] = []): never => {
    console.error(`  ❌ ${msg}`);
    for (const d of details) console.error(`     • ${d}`);
    console.log(LINE);
    process.exit(1);
  };

  const srcSum = sha256File(filePath);
  const vmPath = verifiedMetaPathFor(filePath);
  const vmSum  = fs.existsSync(vmPath) ? sha256File(vmPath) : null;
  if (!srcSum) fail('Could not checksum the source CSV — bundle not written.');
  // If the expected sidecar exists but could not be read, fail rather than
  // recording it as absent.
  if (fs.existsSync(vmPath) && !vmSum) fail(`Verified-metadata sidecar exists but could not be read: ${vmPath}`);

  // Bundle scope: every source row, or exactly the requested IDs (any status).
  // A selected ad is NEVER dropped because its analysis failed or never ran.
  const success = new Map<string, BundleSuccessPayload>(scored.map((s) => [s.adId, {
    creative_source: s.creativeSource,
    assets: buildAssetManifest(s.plannedAssetFiles),
    visual_description: s.exampleRowCreativeAnalysis === '(empty)' ? '' : s.exampleRowCreativeAnalysis,
    visual_confidence: s.visualConfidence ?? null,
    creative_notes: s.exampleRowAnalysis === '(empty)' ? '' : s.exampleRowAnalysis,
    aida_scores: {
      attention: s.analysis.aidaScores.attention,
      interest:  s.analysis.aidaScores.interest,
      desire:    s.analysis.aidaScores.desire,
      action:    s.analysis.aidaScores.action,
    },
    component_scores: {
      copy_score:        s.analysis.copyScore,
      headline_score:    s.analysis.headlineScore,
      description_score: s.analysis.descriptionScore,
      creative_score:    s.analysis.creativeScore,
      clarity_score:     s.analysis.clarityScore,
      connection_score:  s.analysis.connectionScore,
      conviction_score:  s.analysis.convictionScore,
    },
    internal_qa_score: s.analysis.overallScore,
    internal_qa_verdict: s.analysis.finalVerdict,
    qualified: s.analysis.qualified,
    benchmark_score: s.benchmark.benchmarkScore,
    benchmark_tier: s.benchmark.tierToken,
    benchmark_confidence: s.benchmark.confidence,
    funnel_stage: s.analysis.funnelStage,
    race_stage: s.analysis.raceStage,
    trust_funnel_stage: s.analysis.trustFunnelStage,
    behavioural_triggers: s.analysis.behaviouralTriggers.map((t) => ({ name: t.name, strength: t.strength })),
    strengths: s.analysis.strengths,
  }]));

  const assembled = assembleBundleRows({
    rawRows,
    scopeIds: idFilter.ids,
    success,
    errors: new Map(errored.map((e) => [e.adId, e.error])),
  });
  if (!assembled.ok) fail('Bundle NOT written — the source CSV could not be honestly represented.', assembled.errors);
  const { rows, inputRows } = assembled as { ok: true; rows: BundleRow[]; inputRows: number };

  const count = (s: string) => rows.filter((r) => r.analysis_status === s).length;
  const bundle: BrowserAnalysisBundle = {
    schema_version: BUNDLE_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    source_csv_path: path.relative(process.cwd(), filePath).replace(/\\/g, '/'),
    source_csv_sha256: srcSum!,
    verified_meta_path: vmSum ? path.relative(process.cwd(), vmPath).replace(/\\/g, '/') : null,
    verified_meta_sha256: vmSum,
    // No consumed asset means no Vision request happened, so no model is recorded.
    analysis_model: rows.some((r) => r.creative_source === 'ASSET') ? (process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5') : null,
    prompt_version: BUNDLE_PROMPT_VERSION,
    planner_version: BUNDLE_PLANNER_VERSION,
    ai_video_max_frames: aiMaxVideoFrames,
    selected_ad_ids: rows.map((r) => r.ad_id),
    excluded_ad_ids: [],
    counts: {
      input_rows: inputRows,
      selected_rows: rows.length,
      success: count('SUCCESS'),
      review: count('REVIEW'),
      skipped: count('SKIPPED'),
      failed: count('ERROR'),   // derived from rows — never reset
    },
    rows,
  };

  const allowOverwrite = process.env.AI_PREVIEW_CONFIRM_OVERWRITE === 'I_UNDERSTAND';
  const written = writeBundleAtomic(bundle, bundleOut, { allowOverwrite });
  if (!written.ok) {
    const hint = allowOverwrite ? [] : ['To replace an existing bundle set AI_PREVIEW_CONFIRM_OVERWRITE=I_UNDERSTAND'];
    fail('Bundle NOT written — requested output failed.', [...written.errors, ...hint]);
  } else {
    console.log('  ✓ Bundle written (validated; temp file finalised atomically; final file re-read)');
    console.log(`    Path    : ${written.path}`);
    console.log(`    SHA-256 : ${written.sha256}`);
    console.log(`    Bytes   : ${written.bytes}   Rows: ${rows.length}`);
    console.log(`    SUCCESS ${bundle.counts.success}  REVIEW ${bundle.counts.review}  SKIPPED ${bundle.counts.skipped}  ERROR ${bundle.counts.failed}`);
    console.log('    Contents are not printed. No database was written.');
  }
  console.log(LINE);
}

function printSafetyFooter(LINE: string): void {
  console.log(LINE);
  console.log('  Safety confirmation');
  console.log(LINE);
  console.log('  No database writes were performed.');
  console.log('  No scoring changes were made.');
  console.log('  No ingestion was performed.');
  console.log('  data/imports/*.csv remains uncommitted by design.');
  console.log(LINE);
  console.log('');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('\n❌ Fatal error:', message);
  process.exit(1);
});
