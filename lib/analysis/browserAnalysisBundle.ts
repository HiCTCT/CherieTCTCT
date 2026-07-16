/**
 * Browser Analysis Bundle (Phase 1 — reusable analysis handoff)  — PURE
 *
 * A versioned, checksum-anchored record of a COMPLETED browser-ad analysis, so a
 * validated preview result can be reused by ingestion planning WITHOUT calling
 * Anthropic again.
 *
 * This module reads local files to compute/verify checksums. It does NOT call
 * Anthropic, Vision, a browser, Prisma or any network service, and it deliberately
 * does NOT import the analyser (the creative allowlist lives in a pure module).
 *
 * Honesty contract:
 *   - Every ad in the bundle scope gets exactly ONE row.
 *   - A failed analysis becomes an honest ERROR row; it is never dropped.
 *   - Non-SUCCESS rows carry a reason and CANNOT carry fabricated scores.
 *
 * Never stored: API keys/secrets, image bytes/base64, raw Anthropic response text,
 * raw browser-listing `headline`/`description`, unverified advertiser metadata,
 * debug/support asset files.
 *
 * Safety note (accurate, not overstated): the WRITER is safe by construction — it
 * only copies parsed, structured fields. The VALIDATOR adds strong defensive checks.
 * No validator can mathematically prove arbitrary prose contains no secret; the
 * checks below are targeted at known-dangerous shapes.
 */

import { parse } from 'csv-parse/sync';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { isCreativeAssetFile } from './creativeAssetFiles';
import { canonicalAssetPath, deriveSourceRowIdentity, sourceRowIdentityMismatch } from './sourceRowIdentity';
import type { SourceRowIdentity } from './sourceRowIdentity';

// ─── Versions ─────────────────────────────────────────────────────────────────

/** v2: discriminated row union + selected_rows count + per-row source binding. */
export const BUNDLE_SCHEMA_VERSION = 2;
export const BUNDLE_PROMPT_VERSION = 'video-labelled-4section.2026-07';
export const BUNDLE_PLANNER_VERSION = 'planVisionInputs.2026-07';

/** Roots that bundle-declared paths must stay inside. */
export const CREATIVE_ASSET_ROOT = 'data/creative-assets';
export const IMPORT_ROOT = 'data/imports';

// ─── Canonical enums (mirror the tracked repository definitions) ──────────────

export const SOURCE_STATUSES = ['READY', 'NEEDS_REVIEW', 'SKIP', 'UNAVAILABLE'] as const;
export const MEDIA_TYPES = ['IMAGE', 'CAROUSEL', 'VIDEO'] as const;
export const CREATIVE_SOURCES = ['ASSET', 'MANUAL', 'FALLBACK'] as const;
export const VISUAL_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export const BENCHMARK_TIERS = ['STRONG', 'MODERATE', 'WEAK', 'LOW'] as const;
export const BENCHMARK_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
/** mirrors lib/analysis/types.ts FinalVerdict */
export const QA_VERDICTS = [
  'STRONG_READY_TO_TEST', 'GOOD_NEEDS_SHARPENING', 'CLEAR_IDEA_WEAK_SIGNALS',
  'TOO_VAGUE_MAJOR_REWORK', 'INSUFFICIENT_INFORMATION',
] as const;
export const FUNNEL_STAGES = ['TOFU', 'MOFU', 'BOFU'] as const;
export const RACE_STAGES = ['REACH', 'ACT', 'CONVERT', 'ENGAGE'] as const;
export const TRUST_STAGES = ['UNAWARE', 'PROBLEM_AWARE', 'SOLUTION_AWARE', 'PRODUCT_AWARE', 'READY_TO_BUY'] as const;
export const TRIGGER_STRENGTHS = ['STRONG', 'MODERATE', 'WEAK', 'MISSING'] as const;
/** mirrors the fixed list produced by detectBehaviouralTriggers() in scoring.ts */
export const TRIGGER_NAMES = [
  'FOMO', 'Urgency', 'Social proof', 'Authority', 'Before and after', 'Risk reduction',
  'Convenience', 'Value', 'Fear of loss', 'Curiosity', 'Status', 'Belonging', 'Relief',
  'Instant gratification', 'Contrast',
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export type BundleRowStatus = 'SUCCESS' | 'REVIEW' | 'SKIPPED' | 'ERROR';
export type BundleVisualConfidence = (typeof VISUAL_CONFIDENCES)[number];
export type BundleCreativeSource = (typeof CREATIVE_SOURCES)[number];

export type BundleAsset = { filename: string; sha256: string; bytes: number };

export type BundleComponentScores = {
  // *_score names on purpose: a bare `headline`/`description` key is forbidden.
  copy_score: number;
  headline_score: number | null;
  description_score: number | null;
  creative_score: number;
  clarity_score: number;
  connection_score: number;
  conviction_score: number;
};

/** Identity + evidence shared by every row variant. */
export type BundleRowCommon = {
  ad_id: string;
  source_row_number: number;
  source_status: string;
  media_type: string;
  creative_asset_path: string;
  creative_source: BundleCreativeSource;
  assets: BundleAsset[];
  copy_used_for_scoring: string;
};

export type BundleSuccessRow = BundleRowCommon & {
  analysis_status: 'SUCCESS';
  error_reason: null;
  visual_description: string;
  visual_confidence: BundleVisualConfidence | null;
  creative_notes: string;
  aida_scores: { attention: number; interest: number; desire: number; action: number };
  component_scores: BundleComponentScores;
  internal_qa_score: number;
  internal_qa_verdict: string;
  qualified: boolean;
  benchmark_score: number;
  benchmark_tier: (typeof BENCHMARK_TIERS)[number];
  benchmark_confidence: (typeof BENCHMARK_CONFIDENCES)[number];
  funnel_stage: string;
  race_stage: string;
  trust_funnel_stage: string;
  behavioural_triggers: Array<{ name: string; strength: string }>;
  strengths: string[];
};

/** REVIEW / SKIPPED / ERROR carry a reason and NO result fields at all. */
export type BundleHeldRow = BundleRowCommon & {
  analysis_status: 'REVIEW' | 'SKIPPED' | 'ERROR';
  error_reason: string;
};

export type BundleRow = BundleSuccessRow | BundleHeldRow;

export type BrowserAnalysisBundle = {
  schema_version: number;
  created_at: string;
  source_csv_path: string;
  source_csv_sha256: string;
  verified_meta_path: string | null;
  verified_meta_sha256: string | null;
  analysis_model: string | null;
  prompt_version: string;
  planner_version: string;
  ai_video_max_frames: number;
  selected_ad_ids: string[];
  excluded_ad_ids: string[];
  counts: {
    input_rows: number;
    selected_rows: number;
    success: number;
    review: number;
    skipped: number;
    failed: number;
  };
  rows: BundleRow[];
};

export type ValidationResult =
  | { ok: true; bundle: BrowserAnalysisBundle }
  | { ok: false; errors: string[] };

// ─── Key allowlists ───────────────────────────────────────────────────────────

const COMMON_KEYS = [
  'ad_id', 'source_row_number', 'source_status', 'media_type', 'creative_asset_path',
  'creative_source', 'assets', 'copy_used_for_scoring', 'analysis_status', 'error_reason',
] as const;

const SUCCESS_ONLY_KEYS = [
  'visual_description', 'visual_confidence', 'creative_notes', 'aida_scores',
  'component_scores', 'internal_qa_score', 'internal_qa_verdict', 'qualified',
  'benchmark_score', 'benchmark_tier', 'benchmark_confidence', 'funnel_stage',
  'race_stage', 'trust_funnel_stage', 'behavioural_triggers', 'strengths',
] as const;

const SUCCESS_KEYS: readonly string[] = [...COMMON_KEYS, ...SUCCESS_ONLY_KEYS];
const HELD_KEYS: readonly string[] = [...COMMON_KEYS];

const BUNDLE_TOP_KEYS: readonly string[] = [
  'schema_version', 'created_at', 'source_csv_path', 'source_csv_sha256',
  'verified_meta_path', 'verified_meta_sha256', 'analysis_model', 'prompt_version',
  'planner_version', 'ai_video_max_frames', 'selected_ad_ids', 'excluded_ad_ids',
  'counts', 'rows',
];

const COUNT_KEYS: readonly string[] = ['input_rows', 'selected_rows', 'success', 'review', 'skipped', 'failed'];

// ─── Sensitive-content guards ─────────────────────────────────────────────────

const FORBIDDEN_KEYS: readonly string[] = [
  'headline', 'description', 'raw_headline', 'raw_description', 'listing_headline',
  'listing_description', 'api_key', 'anthropic_api_key', 'x-api-key', 'apikey',
  'secret', 'token', 'raw_response', 'response_text', 'image_base64', 'base64', 'image_bytes',
];

/** Max characters per free-text field. Generous for real ad copy, hostile to payloads. */
const MAX_TEXT_LEN: Record<string, number> = {
  copy_used_for_scoring: 20_000,
  visual_description: 8_000,
  creative_notes: 8_000,
  error_reason: 2_000,
  internal_qa_verdict: 100,
  strength: 1_000,
  // A model identifier is a short token (e.g. claude-haiku-4-5). Anything longer is
  // not a model name, and a bounded limit keeps key/base64 payloads out of the field.
  analysis_model: 80,
};

const UNSAFE_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /sk-ant-[A-Za-z0-9_-]{8,}/, what: 'Anthropic API key prefix' },
  { re: /\bsk-[A-Za-z0-9]{20,}/, what: 'API key-like token' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'private key block' },
  { re: /data:image\//i, what: 'inline image data URI' },
  { re: /[A-Za-z0-9+/]{512,}={0,2}/, what: 'long base64-like payload' },
  { re: /^\s*(FRAME_OBSERVATIONS|VISUAL_DESCRIPTION|VISUAL_CONFIDENCE|CREATIVE_NOTES)\s*:/mi, what: 'raw structured-response section header' },
];

function scanText(value: string, at: string, limitKey: string, errors: string[]): void {
  const max = MAX_TEXT_LEN[limitKey] ?? 4_000;
  if (value.length > max) errors.push(`${at} exceeds the maximum length of ${max} characters`);
  for (const { re, what } of UNSAFE_PATTERNS) {
    if (re.test(value)) errors.push(`${at} contains ${what} — refusing the bundle`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isScore(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10;
}
function isSha256(v: unknown): v is string {
  return typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v);
}
/** Exact ISO instant produced by Date#toISOString — no loose date-only parsing. */
function isExactIsoTimestamp(v: unknown): boolean {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return false;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) && d.toISOString() === v;
}
function isExactAdId(v: unknown): v is string {
  return typeof v === 'string' && /^\d+$/.test(v);
}

function findForbiddenKeys(value: unknown, at: string, out: string[]): void {
  if (Array.isArray(value)) { value.forEach((v, i) => findForbiddenKeys(v, `${at}[${i}]`, out)); return; }
  if (!isPlainObject(value)) return;
  for (const k of Object.keys(value)) {
    if (FORBIDDEN_KEYS.includes(k.toLowerCase())) {
      out.push(`forbidden key "${k}" at ${at} — raw listing metadata / secrets must never enter a bundle`);
    }
    findForbiddenKeys(value[k], `${at}.${k}`, out);
  }
}

function checkExactKeys(obj: Record<string, unknown>, allowed: readonly string[], at: string, out: string[]): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) out.push(`unrecognised field "${k}" at ${at}`);
  for (const k of allowed) if (!(k in obj)) out.push(`missing required field "${k}" at ${at}`);
}

// ─── Checksums ────────────────────────────────────────────────────────────────

export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
export function sha256File(filePath: string): string | null {
  try { return sha256Buffer(fs.readFileSync(filePath)); } catch { return null; }
}

/** realpath-based containment: defeats traversal, shared-prefix and symlink/junction escape. */
function isContained(childAbs: string, rootAbs: string): boolean {
  let c: string; let r: string;
  try { r = fs.realpathSync(rootAbs); } catch { return false; }
  try { c = fs.realpathSync(childAbs); } catch { c = path.resolve(childAbs); }
  return c === r || c.startsWith(r + path.sep);
}

// ─── Shape / semantic validation (no filesystem access) ───────────────────────

export function validateBundleShape(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(value)) return { ok: false, errors: ['bundle is not a JSON object'] };

  findForbiddenKeys(value, 'bundle', errors);

  if (value.schema_version !== BUNDLE_SCHEMA_VERSION) {
    errors.push(`unsupported schema_version ${JSON.stringify(value.schema_version)} (supported: ${BUNDLE_SCHEMA_VERSION})`);
    return { ok: false, errors };
  }
  checkExactKeys(value, BUNDLE_TOP_KEYS, 'bundle', errors);

  if (!isExactIsoTimestamp(value.created_at)) errors.push('created_at must be an exact ISO instant (YYYY-MM-DDTHH:MM:SS.sssZ)');
  for (const k of ['source_csv_path', 'prompt_version', 'planner_version'] as const) {
    if (typeof value[k] !== 'string' || (value[k] as string).trim() === '') errors.push(`${k} must be a non-empty string`);
  }
  if (!isSha256(value.source_csv_sha256)) errors.push('source_csv_sha256 must be a 64-char hex digest');
  if (value.verified_meta_path !== null && (typeof value.verified_meta_path !== 'string' || value.verified_meta_path.trim() === '')) {
    errors.push('verified_meta_path must be a non-empty string or null');
  }
  if (value.verified_meta_sha256 !== null && !isSha256(value.verified_meta_sha256)) {
    errors.push('verified_meta_sha256 must be a 64-char hex digest or null');
  }
  if ((value.verified_meta_path === null) !== (value.verified_meta_sha256 === null)) {
    errors.push('verified_meta_path and verified_meta_sha256 must both be set or both be null');
  }
  if (value.analysis_model !== null) {
    if (typeof value.analysis_model !== 'string' || value.analysis_model.trim() === '') {
      errors.push('analysis_model must be a non-empty string or null');
    } else {
      // The writer sources this from the environment, so it gets the SAME bounded and
      // sensitive-content treatment as any other free string. The value is never echoed.
      scanText(value.analysis_model, 'analysis_model', 'analysis_model', errors);
    }
  }
  if (value.prompt_version !== BUNDLE_PROMPT_VERSION) errors.push(`prompt_version mismatch (expected ${BUNDLE_PROMPT_VERSION})`);
  if (value.planner_version !== BUNDLE_PLANNER_VERSION) errors.push(`planner_version mismatch (expected ${BUNDLE_PLANNER_VERSION})`);
  if (!Number.isSafeInteger(value.ai_video_max_frames) || (value.ai_video_max_frames as number) < 1) {
    errors.push('ai_video_max_frames must be a whole integer >= 1');
  }

  for (const key of ['selected_ad_ids', 'excluded_ad_ids'] as const) {
    const arr = value[key];
    if (!Array.isArray(arr) || !arr.every(isExactAdId)) { errors.push(`${key} must be an array of exact numeric id strings`); continue; }
    if (new Set(arr as string[]).size !== arr.length) errors.push(`${key} contains duplicate ids`);
  }

  if (!isPlainObject(value.counts)) {
    errors.push('counts must be an object');
  } else {
    checkExactKeys(value.counts, COUNT_KEYS, 'bundle.counts', errors);
    for (const k of Object.keys(value.counts)) {
      const n = (value.counts as Record<string, unknown>)[k];
      if (!Number.isSafeInteger(n) || (n as number) < 0) errors.push(`counts.${k} must be a non-negative safe integer`);
    }
  }

  if (!Array.isArray(value.rows)) { errors.push('rows must be an array'); return { ok: false, errors }; }
  const seen = new Set<string>();
  (value.rows as unknown[]).forEach((r, i) => validateRowShape(r, `bundle.rows[${i}]`, seen, errors));

  // VIDEO manifest cardinality: one analysis may consume at most the configured
  // number of frames, so a manifest claiming more frames than the bundle's own
  // declared limit describes a run that could not have happened. VIDEO only —
  // IMAGE and CAROUSEL manifests are governed by their own capture rules.
  const frameLimit = value.ai_video_max_frames;
  if (Number.isSafeInteger(frameLimit) && (frameLimit as number) >= 1) {
    (value.rows as unknown[]).forEach((r, i) => {
      if (!isPlainObject(r) || !Array.isArray(r.assets)) return;
      if (r.analysis_status !== 'SUCCESS' || r.creative_source !== 'ASSET' || r.media_type !== 'VIDEO') return;
      if ((r.assets as unknown[]).length > (frameLimit as number)) {
        errors.push(`bundle.rows[${i}] VIDEO manifest lists ${(r.assets as unknown[]).length} frames but ai_video_max_frames is ${frameLimit}`);
      }
    });
  }

  if (errors.length === 0) {
    const b = value as unknown as BrowserAnalysisBundle;
    const c = {
      success: b.rows.filter((r) => r.analysis_status === 'SUCCESS').length,
      review: b.rows.filter((r) => r.analysis_status === 'REVIEW').length,
      skipped: b.rows.filter((r) => r.analysis_status === 'SKIPPED').length,
      failed: b.rows.filter((r) => r.analysis_status === 'ERROR').length,
    };
    if (b.counts.success !== c.success) errors.push(`counts.success ${b.counts.success} != ${c.success} actual SUCCESS rows`);
    if (b.counts.review !== c.review) errors.push(`counts.review ${b.counts.review} != ${c.review} actual REVIEW rows`);
    if (b.counts.skipped !== c.skipped) errors.push(`counts.skipped ${b.counts.skipped} != ${c.skipped} actual SKIPPED rows`);
    if (b.counts.failed !== c.failed) errors.push(`counts.failed ${b.counts.failed} != ${c.failed} actual ERROR rows`);
    if (c.success + c.review + c.skipped + c.failed !== b.rows.length) errors.push('status counts do not sum to the row count');
    if (b.counts.selected_rows !== b.rows.length) errors.push(`counts.selected_rows ${b.counts.selected_rows} != ${b.rows.length} rows`);
    if (b.counts.input_rows < b.rows.length) errors.push('counts.input_rows cannot be smaller than the number of bundle rows');

    const rowIds = b.rows.map((r) => r.ad_id).sort();
    const selected = [...b.selected_ad_ids].sort();
    if (rowIds.length !== selected.length || rowIds.some((id, i) => id !== selected[i])) {
      errors.push('selected_ad_ids does not exactly match the set of row ad_ids');
    }
    for (const id of b.excluded_ad_ids) {
      if (b.selected_ad_ids.includes(id)) errors.push(`ad_id ${id} appears in both selected_ad_ids and excluded_ad_ids`);
    }
  }

  return errors.length === 0 ? { ok: true, bundle: value as unknown as BrowserAnalysisBundle } : { ok: false, errors };
}

function oneOf(v: unknown, list: readonly string[]): boolean {
  return typeof v === 'string' && list.includes(v);
}

function validateRowShape(r: unknown, at: string, seen: Set<string>, errors: string[]): void {
  if (!isPlainObject(r)) { errors.push(`${at} is not an object`); return; }

  const status = r.analysis_status;
  if (!oneOf(status, ['SUCCESS', 'REVIEW', 'SKIPPED', 'ERROR'])) {
    errors.push(`${at}.analysis_status must be SUCCESS/REVIEW/SKIPPED/ERROR`);
    return;   // cannot narrow further
  }
  // Variant key allowlist — a held row carrying result fields is rejected outright.
  checkExactKeys(r, status === 'SUCCESS' ? SUCCESS_KEYS : HELD_KEYS, at, errors);

  // ── common ──
  if (!isExactAdId(r.ad_id)) errors.push(`${at}.ad_id must be an exact numeric id string`);
  else { if (seen.has(r.ad_id)) errors.push(`duplicate ad_id ${r.ad_id} at ${at}`); seen.add(r.ad_id); }

  if (!Number.isSafeInteger(r.source_row_number) || (r.source_row_number as number) < 1) {
    errors.push(`${at}.source_row_number must be a positive safe integer`);
  }
  if (!oneOf(r.source_status, SOURCE_STATUSES)) errors.push(`${at}.source_status must be one of ${SOURCE_STATUSES.join('/')}`);
  if (!oneOf(r.media_type, MEDIA_TYPES)) errors.push(`${at}.media_type must be one of ${MEDIA_TYPES.join('/')}`);
  if (typeof r.creative_asset_path !== 'string') errors.push(`${at}.creative_asset_path must be a string`);
  else if (r.creative_asset_path !== '' && r.creative_asset_path !== canonicalAssetPath(r.creative_asset_path)) {
    errors.push(`${at}.creative_asset_path is not canonical repo-relative form`);
  }
  if (!oneOf(r.creative_source, CREATIVE_SOURCES)) errors.push(`${at}.creative_source must be one of ${CREATIVE_SOURCES.join('/')}`);
  if (typeof r.copy_used_for_scoring !== 'string') errors.push(`${at}.copy_used_for_scoring must be a string`);
  else scanText(r.copy_used_for_scoring, `${at}.copy_used_for_scoring`, 'copy_used_for_scoring', errors);

  validateAssets(r, at, errors);

  // ── error_reason narrowing ──
  if (status === 'SUCCESS') {
    if (r.error_reason !== null) errors.push(`${at} SUCCESS row must have error_reason: null`);
  } else {
    if (typeof r.error_reason !== 'string' || r.error_reason.trim() === '') {
      errors.push(`${at} ${status} row must carry a non-empty error_reason`);
    } else {
      scanText(r.error_reason, `${at}.error_reason`, 'error_reason', errors);
    }
  }

  if (status !== 'SUCCESS') return;   // held rows have no result block by construction

  // ── SUCCESS result block ──
  for (const [k, lim] of [['visual_description', 'visual_description'], ['creative_notes', 'creative_notes']] as const) {
    if (typeof r[k] !== 'string') errors.push(`${at}.${k} must be a string`);
    else scanText(r[k] as string, `${at}.${k}`, lim, errors);
  }
  if (typeof r.internal_qa_verdict !== 'string' || !oneOf(r.internal_qa_verdict, QA_VERDICTS)) {
    errors.push(`${at}.internal_qa_verdict must be one of ${QA_VERDICTS.join('/')}`);
  }
  if (!oneOf(r.funnel_stage, FUNNEL_STAGES)) errors.push(`${at}.funnel_stage must be one of ${FUNNEL_STAGES.join('/')}`);
  if (!oneOf(r.race_stage, RACE_STAGES)) errors.push(`${at}.race_stage must be one of ${RACE_STAGES.join('/')}`);
  if (!oneOf(r.trust_funnel_stage, TRUST_STAGES)) errors.push(`${at}.trust_funnel_stage must be one of ${TRUST_STAGES.join('/')}`);
  if (!oneOf(r.benchmark_tier, BENCHMARK_TIERS)) errors.push(`${at}.benchmark_tier must be one of ${BENCHMARK_TIERS.join('/')}`);
  if (!oneOf(r.benchmark_confidence, BENCHMARK_CONFIDENCES)) errors.push(`${at}.benchmark_confidence must be HIGH/MEDIUM/LOW`);
  if (typeof r.qualified !== 'boolean') errors.push(`${at}.qualified must be a boolean`);
  if (!isScore(r.internal_qa_score)) errors.push(`${at}.internal_qa_score must be a number between 0 and 10`);
  if (!isScore(r.benchmark_score)) errors.push(`${at}.benchmark_score must be a number between 0 and 10`);

  if (r.visual_confidence !== null && !oneOf(r.visual_confidence, VISUAL_CONFIDENCES)) {
    errors.push(`${at}.visual_confidence must be HIGH/MEDIUM/LOW or null`);
  }

  if (!isPlainObject(r.aida_scores)) errors.push(`${at}.aida_scores must be an object`);
  else {
    checkExactKeys(r.aida_scores, ['attention', 'interest', 'desire', 'action'], `${at}.aida_scores`, errors);
    for (const k of Object.keys(r.aida_scores)) {
      if (!isScore((r.aida_scores as Record<string, unknown>)[k])) errors.push(`${at}.aida_scores.${k} must be between 0 and 10`);
    }
  }
  if (!isPlainObject(r.component_scores)) errors.push(`${at}.component_scores must be an object`);
  else {
    const cs = r.component_scores as Record<string, unknown>;
    checkExactKeys(cs, ['copy_score', 'headline_score', 'description_score', 'creative_score', 'clarity_score', 'connection_score', 'conviction_score'], `${at}.component_scores`, errors);
    for (const k of Object.keys(cs)) {
      const nullable = k === 'headline_score' || k === 'description_score';
      if (cs[k] === null && nullable) continue;
      if (!isScore(cs[k])) errors.push(`${at}.component_scores.${k} must be between 0 and 10${nullable ? ' or null' : ''}`);
    }
  }
  if (!Array.isArray(r.strengths) || !(r.strengths as unknown[]).every((s) => typeof s === 'string')) {
    errors.push(`${at}.strengths must be an array of strings`);
  } else {
    (r.strengths as string[]).forEach((s, i) => scanText(s, `${at}.strengths[${i}]`, 'strength', errors));
  }
  if (!Array.isArray(r.behavioural_triggers)) errors.push(`${at}.behavioural_triggers must be an array`);
  else {
    (r.behavioural_triggers as unknown[]).forEach((t, i) => {
      const tat = `${at}.behavioural_triggers[${i}]`;
      if (!isPlainObject(t)) { errors.push(`${tat} is not an object`); return; }
      checkExactKeys(t, ['name', 'strength'], tat, errors);
      if (!oneOf(t.name, TRIGGER_NAMES)) errors.push(`${tat}.name "${String(t.name)}" is not a known behavioural trigger`);
      if (!oneOf(t.strength, TRIGGER_STRENGTHS)) errors.push(`${tat}.strength must be one of ${TRIGGER_STRENGTHS.join('/')}`);
    });
  }

  // ── cross-field evidence rules ──
  const src = r.creative_source;
  if (src === 'ASSET') {
    if (!Array.isArray(r.assets) || (r.assets as unknown[]).length === 0) {
      errors.push(`${at} ASSET success must manifest at least one consumed creative asset`);
    }
    // An ASSET row asserts files were read from a real location. Without a declared
    // path there is nothing for disk validation to check, so a fabricated manifest
    // would ride through unverified. Structural rule: it must fail even with file
    // checks disabled.
    if (typeof r.creative_asset_path !== 'string' || r.creative_asset_path.trim() === '') {
      errors.push(`${at} ASSET success must declare a non-empty creative_asset_path — an empty path would skip all asset file, checksum and size validation`);
    }
    if (r.media_type === 'VIDEO' && !oneOf(r.visual_confidence, VISUAL_CONFIDENCES)) {
      errors.push(`${at} ASSET VIDEO success requires a valid visual_confidence`);
    }
    if (r.media_type !== 'VIDEO' && r.visual_confidence !== null) {
      errors.push(`${at} visual_confidence is VIDEO-only — ${String(r.media_type)} must use null`);
    }
  } else {
    // MANUAL / FALLBACK never consume assets and never have Vision confidence.
    if (Array.isArray(r.assets) && (r.assets as unknown[]).length > 0) {
      errors.push(`${at} ${String(src)} row must not claim consumed assets`);
    }
    if (r.visual_confidence !== null) errors.push(`${at} ${String(src)} row must have visual_confidence: null`);
  }
}

function validateAssets(r: Record<string, unknown>, at: string, errors: string[]): void {
  if (!Array.isArray(r.assets)) { errors.push(`${at}.assets must be an array`); return; }
  const seenFiles = new Set<string>();
  (r.assets as unknown[]).forEach((a, i) => {
    const aat = `${at}.assets[${i}]`;
    if (!isPlainObject(a)) { errors.push(`${aat} is not an object`); return; }
    checkExactKeys(a, ['filename', 'sha256', 'bytes'], aat, errors);
    if (typeof a.filename !== 'string' || a.filename.trim() === '') {
      errors.push(`${aat}.filename must be non-empty`);
    } else {
      if (a.filename !== path.basename(a.filename) || a.filename.includes('/') || a.filename.includes('\\')) {
        errors.push(`${aat}.filename must be a bare filename, not a path`);
      }
      if (!isCreativeAssetFile(a.filename)) {
        errors.push(`${aat}.filename "${a.filename}" is not an eligible creative asset (debug/support files are forbidden)`);
      }
      if (seenFiles.has(a.filename)) errors.push(`${aat} duplicate asset entry "${a.filename}"`);
      seenFiles.add(a.filename);
    }
    if (!isSha256(a.sha256)) errors.push(`${aat}.sha256 must be a 64-char hex digest`);
    if (!Number.isSafeInteger(a.bytes) || (a.bytes as number) < 0) errors.push(`${aat}.bytes must be a non-negative safe integer`);
  });
}

// ─── Filesystem identity validation ───────────────────────────────────────────

export function validateBundleAgainstDisk(bundle: BrowserAnalysisBundle, cwd = process.cwd()): string[] {
  const errors: string[] = [];
  const assetRoot = path.resolve(cwd, CREATIVE_ASSET_ROOT);
  const importRoot = path.resolve(cwd, IMPORT_ROOT);

  // Source CSV — must sit inside the import root and match byte-for-byte.
  const srcAbs = path.resolve(cwd, bundle.source_csv_path);
  let sourceTrusted = false;
  if (!isContained(srcAbs, importRoot)) {
    errors.push(`source_csv_path resolves outside ${IMPORT_ROOT} — refusing`);
  } else {
    const sum = sha256File(srcAbs);
    if (sum === null) errors.push(`source CSV not readable: ${bundle.source_csv_path}`);
    else if (sum !== bundle.source_csv_sha256) errors.push(`source CSV checksum mismatch for ${bundle.source_csv_path} (bundle is stale)`);
    else sourceTrusted = true;
  }

  // Per-row binding is only meaningful against a source we have already proven is
  // the exact file this bundle was built from.
  if (sourceTrusted) errors.push(...validateBundleSourceBinding(bundle, srcAbs, cwd));

  // Verified-metadata sidecar — declared means it MUST exist and match.
  if (bundle.verified_meta_path && bundle.verified_meta_sha256) {
    const vmAbs = path.resolve(cwd, bundle.verified_meta_path);
    if (!isContained(vmAbs, importRoot)) {
      errors.push(`verified_meta_path resolves outside ${IMPORT_ROOT} — refusing`);
    } else {
      const sum = sha256File(vmAbs);
      if (sum === null) errors.push(`declared verified-metadata sidecar is missing or unreadable: ${bundle.verified_meta_path}`);
      else if (sum !== bundle.verified_meta_sha256) errors.push(`verified-metadata checksum mismatch for ${bundle.verified_meta_path} (bundle is stale)`);
    }
  }

  for (const row of bundle.rows) {
    // Containment is checked for EVERY declared path, including held rows with no
    // manifest: an unsafe path must never ride along just because nothing was consumed.
    //
    // This skip can only ever apply to a row that consumed nothing: an ASSET SUCCESS row
    // with an empty path is rejected by validateBundleShape(), which runs first and
    // short-circuits, so a manifest can never reach here with no path to validate against.
    if (row.creative_asset_path === '') continue;
    const target = path.resolve(cwd, row.creative_asset_path);
    if (!isContained(target, assetRoot)) {
      errors.push(`ad ${row.ad_id}: creative_asset_path resolves outside ${CREATIVE_ASSET_ROOT}`);
      continue;
    }
    // Existence is only required where the row CLAIMS the asset was consumed. A held
    // row records the path capture wrote down; it never asserts the file was read.
    if (row.assets.length === 0) continue;
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(target); } catch { stat = null; }
    if (!stat) { errors.push(`ad ${row.ad_id}: creative_asset_path not found — ${row.creative_asset_path}`); continue; }

    for (const a of row.assets) {
      // Supports BOTH analyser shapes: a directory of creatives, or a direct file.
      const fileAbs = stat.isDirectory() ? path.resolve(target, a.filename) : target;
      if (!stat.isDirectory() && path.basename(target) !== a.filename) {
        errors.push(`ad ${row.ad_id}: direct-file creative_asset_path does not match manifest entry "${a.filename}"`);
        continue;
      }
      if (!isContained(fileAbs, assetRoot)) {
        errors.push(`ad ${row.ad_id}: asset "${a.filename}" resolves outside ${CREATIVE_ASSET_ROOT}`);
        continue;
      }
      let st: fs.Stats;
      try { st = fs.statSync(fileAbs); } catch { errors.push(`ad ${row.ad_id}: asset file missing — ${a.filename}`); continue; }
      if (st.size !== a.bytes) errors.push(`ad ${row.ad_id}: asset size mismatch — ${a.filename} (disk ${st.size}, manifest ${a.bytes})`);
      const sum = sha256File(fileAbs);
      if (sum === null) { errors.push(`ad ${row.ad_id}: asset unreadable — ${a.filename}`); continue; }
      if (sum !== a.sha256) errors.push(`ad ${row.ad_id}: asset checksum mismatch — ${a.filename} (asset changed since analysis)`);
    }
  }
  return errors;
}

/**
 * Independent bundle-to-source proof, using the SAME canonical identity rules as the
 * preview writer and the planner (there is exactly one implementation of them).
 *
 * A whole-file checksum only proves the CSV has not changed. This proves the bundle
 * actually describes THAT CSV: same row count, every selected id present, and every
 * row bound field-by-field to its own source row rather than to some other row.
 */
export function validateBundleSourceBinding(
  bundle: BrowserAnalysisBundle,
  sourceAbsPath: string,
  cwd = process.cwd(),
): string[] {
  const errors: string[] = [];

  let text: string;
  try { text = fs.readFileSync(sourceAbsPath, 'utf-8'); }
  catch { return [`source CSV not readable for row binding: ${bundle.source_csv_path}`]; }

  let rawRows: Record<string, string>[];
  try { rawRows = parse(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[]; }
  catch (e) { return [`source CSV could not be parsed for row binding: ${e instanceof Error ? e.message : String(e)}`]; }

  if (rawRows.length === 0) return ['source CSV contains no data rows'];
  if (!Object.keys(rawRows[0]!).includes('ad_id')) {
    return ['source CSV has no ad_id column — bundle rows cannot be bound to source rows'];
  }

  // Source hygiene first: an untrustworthy source cannot bind anything. Offending
  // values are never echoed back.
  const byId = new Map<string, SourceRowIdentity>();
  rawRows.forEach((raw, i) => {
    const ident = deriveSourceRowIdentity(raw, i + 2, cwd);
    if (ident.ad_id === '') { errors.push(`source row ${i + 2}: ad_id is blank`); return; }
    if (!/^\d+$/.test(ident.ad_id)) { errors.push(`source row ${i + 2}: ad_id is not an exact numeric id`); return; }
    if (byId.has(ident.ad_id)) { errors.push(`source CSV contains duplicate ad_id ${ident.ad_id}`); return; }
    byId.set(ident.ad_id, ident);
  });
  if (errors.length > 0) return errors;

  if (bundle.counts.input_rows !== rawRows.length) {
    errors.push(`counts.input_rows ${bundle.counts.input_rows} != ${rawRows.length} data row(s) in ${bundle.source_csv_path}`);
  }
  for (const id of bundle.selected_ad_ids) if (!byId.has(id)) errors.push(`selected ad_id ${id} is not present in the source CSV`);
  for (const id of bundle.excluded_ad_ids) if (!byId.has(id)) errors.push(`excluded ad_id ${id} is not present in the source CSV`);

  for (const row of bundle.rows) {
    const actual = byId.get(row.ad_id);
    if (!actual) continue;   // already reported via selected_ad_ids
    const drift = sourceRowIdentityMismatch(bundleRowIdentity(row), actual);
    if (drift.length > 0) {
      errors.push(`ad ${row.ad_id}: bundle row does not match its source CSV row (${drift.join(', ')})`);
    }
  }

  // Scope semantics: a bundle claiming the whole source (no exact-ID filter) must
  // account for every source row. A filtered bundle is scoped to exactly its
  // selected ids, which are proven present above.
  if (bundle.counts.selected_rows === rawRows.length) {
    const selected = new Set(bundle.selected_ad_ids);
    for (const id of byId.keys()) {
      if (!selected.has(id)) errors.push(`bundle claims full source scope but source ad_id ${id} has no bundle row`);
    }
  }
  return errors;
}

export function validateBundle(value: unknown, opts: { checkFiles?: boolean; cwd?: string } = {}): ValidationResult {
  const shape = validateBundleShape(value);
  if (!shape.ok) return shape;
  if (opts.checkFiles === false) return shape;
  const errors = validateBundleAgainstDisk(shape.bundle, opts.cwd ?? process.cwd());
  return errors.length === 0 ? shape : { ok: false, errors };
}

export function loadBundle(bundlePath: string, opts: { checkFiles?: boolean; cwd?: string } = {}): ValidationResult {
  let raw: string;
  try { raw = fs.readFileSync(path.resolve(bundlePath), 'utf-8'); }
  catch (e) { return { ok: false, errors: [`bundle not readable: ${e instanceof Error ? e.message : String(e)}`] }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { ok: false, errors: [`bundle is not valid JSON: ${e instanceof Error ? e.message : String(e)}`] }; }
  return validateBundle(parsed, opts);
}

// ─── Per-row source binding ───────────────────────────────────────────────────

/** The identity a bundle row asserts about its CSV row. */
export function bundleRowIdentity(row: BundleRow): SourceRowIdentity {
  return {
    ad_id: row.ad_id,
    source_row_number: row.source_row_number,
    source_status: row.source_status,
    media_type: row.media_type,
    creative_asset_path: row.creative_asset_path,
    copy_used_for_scoring: row.copy_used_for_scoring,
  };
}

// ─── Serialisation ────────────────────────────────────────────────────────────

export function serializeBundle(bundle: BrowserAnalysisBundle): string {
  const ordered: Record<string, unknown> = {};
  for (const k of BUNDLE_TOP_KEYS) {
    if (k === 'rows') {
      ordered.rows = bundle.rows.map((r) => {
        const keys = r.analysis_status === 'SUCCESS' ? SUCCESS_KEYS : HELD_KEYS;
        const o: Record<string, unknown> = {};
        for (const rk of keys) o[rk] = (r as unknown as Record<string, unknown>)[rk];
        return o;
      });
    } else {
      ordered[k] = (bundle as unknown as Record<string, unknown>)[k];
    }
  }
  return JSON.stringify(ordered, null, 2) + '\n';
}

/**
 * Writes a validated bundle via a same-directory temporary file. Bundle content is
 * NEVER streamed into the final destination, so an interrupted write cannot leave a
 * misleading final bundle: the temp file is fully written, flushed and closed before
 * the destination is created at all.
 *
 * Finalisation, and the EXACT guarantee each mode provides:
 *
 *  - No overwrite (default): `link(tmp, final)`. The link is atomic and fails with
 *    EEXIST if the destination exists, so the no-clobber decision is made by the
 *    filesystem — there is no check-then-write race. Temp and destination are always
 *    in the same directory, hence the same filesystem. If the filesystem cannot
 *    perform this operation (e.g. no hard-link support), NOTHING is written and the
 *    call fails: we do not fall back to a weaker copy that could be interrupted, and
 *    we do not claim atomicity the code did not provide.
 *
 *  - Confirmed overwrite: `rename(tmp, final)`, which replaces the destination in one
 *    step. Rename is atomic on the same filesystem on POSIX, and on Windows resolves
 *    to MoveFileEx with MOVEFILE_REPLACE_EXISTING on NTFS. A failed rename leaves the
 *    previous file untouched and writes no partial final file.
 *
 * Temp-file removal is ATTEMPTED on both success and failure, but it is best-effort:
 * the filesystem can refuse it. Cleanup is never reported as confirmed when it was
 * not — a failure to remove the (now redundant) temp file appends a warning rather
 * than being swallowed, and never invalidates an already-valid final file.
 *
 * The returned checksum and byte size are verified against the ACTUAL final file and
 * fail closed: no success is returned unless the file on disk was re-read, matched the
 * serialised bundle, and reported a real byte size.
 */
export function writeBundleAtomic(
  bundle: BrowserAnalysisBundle,
  outPath: string,
  opts: {
    allowOverwrite?: boolean;
    cwd?: string;
    /** Test seam: fires once the temp file is complete and BEFORE the final path exists. */
    onTempWritten?: (tmpPath: string) => void;
    /** Test seam: simulate cleanup / verification failures. Never set in production. */
    __testHooks?: {
      unlink?: (p: string) => void;
      statSize?: (p: string) => number;
      hashFile?: (p: string) => string | null;
    };
  } = {},
): { ok: true; path: string; sha256: string; bytes: number; warnings: string[] } | { ok: false; errors: string[] } {
  const abs = path.resolve(outPath);
  // The COMPLETE bundle is validated before any file is created.
  const check = validateBundle(bundle, { cwd: opts.cwd });
  if (!check.ok) return { ok: false, errors: ['bundle failed validation before write:', ...check.errors] };

  const body = serializeBundle(bundle);
  const expected = Buffer.from(body, 'utf-8');
  const dir = path.dirname(abs);
  const hooks = opts.__testHooks;
  const unlinkFile = hooks?.unlink ?? ((p: string) => fs.unlinkSync(p));
  const statSize = hooks?.statSize ?? ((p: string) => fs.statSync(p).size);
  const hashFile = hooks?.hashFile ?? sha256File;

  let tmp: string | null = null;
  /** Set when a temp file was left behind: cleanup attempted, outcome NOT confirmed. */
  let cleanupUnconfirmed = false;
  // The temp filename is never surfaced: it is derived from the caller's output path.
  const CLEANUP_WARNING = 'the temporary bundle file could not be removed — cleanup is best-effort and was NOT confirmed; a stray temp file may remain beside the output';

  const attemptCleanup = (): void => {
    if (!tmp) return;
    try {
      if (fs.existsSync(tmp)) unlinkFile(tmp);
    } catch {
      cleanupUnconfirmed = true;
    }
  };

  /** Cleanup is attempted on EVERY exit, and an unconfirmed cleanup is reported, not hidden. */
  const fail = (errors: string[]): { ok: false; errors: string[] } => {
    attemptCleanup();
    // The original operational failure always comes first and is never replaced.
    return { ok: false, errors: cleanupUnconfirmed ? [...errors, CLEANUP_WARNING] : errors };
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    tmp = path.join(dir, `.${path.basename(abs)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);

    // 1) Fully write, flush and close the temporary file.
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(fd, body, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    opts.onTempWritten?.(tmp);

    // 2) Finalise from the completed temporary file only.
    if (!opts.allowOverwrite) {
      try {
        fs.linkSync(tmp, abs);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'EEXIST') {
          return fail([`output file already exists: ${outPath} — refusing to overwrite`]);
        }
        if (err.code === 'ENOENT') {
          return fail(['the temporary bundle file disappeared before finalisation — no bundle was written']);
        }
        return fail([
          `atomic no-clobber finalisation is not available for ${outPath} (${err.code ?? 'unknown error'})`,
          'refusing to write: this filesystem cannot create the output without a check-then-write race',
        ]);
      }
    } else {
      fs.renameSync(tmp, abs);
      tmp = null;   // rename consumed the temp file
    }
  } catch (e) {
    return fail([`failed to write bundle: ${e instanceof Error ? e.message : String(e)}`]);
  }

  // The final file is now complete. Remove the redundant temp link before verifying;
  // a cleanup failure here cannot invalidate a final file that is already correct.
  attemptCleanup();

  // ── Verify the ACTUAL final file, and fail closed ────────────────────────────
  // Every failure below leaves the finalised file untouched: it exists and may well
  // be valid — what we cannot do is CLAIM it was verified.
  const unverified = (why: string) => fail([
    `the bundle file EXISTS at ${outPath} but ${why} — treat this output as UNVERIFIED, not as absent`,
    'do not consume this bundle until it has been validated:  npm run browser:bundle:validate -- <path>',
  ]);

  const finalSum = hashFile(abs);
  if (finalSum === null) return unverified('it could not be re-read for checksum verification');
  if (finalSum !== sha256Buffer(expected)) {
    return unverified('its checksum does not match the bundle that was serialised');
  }

  let bytes: number;
  try {
    bytes = statSize(abs);
  } catch (e) {
    return unverified(`its byte size could not be read (${e instanceof Error ? e.message : String(e)})`);
  }
  // A serialised bundle is never empty, so a 0-byte "success" is a reporting failure,
  // never a fact to pass on.
  if (!Number.isSafeInteger(bytes) || bytes !== expected.length) {
    return unverified(`its byte size (${String(bytes)}) does not match the ${expected.length} bytes written`);
  }

  return { ok: true, path: abs, sha256: finalSum, bytes, warnings: cleanupUnconfirmed ? [CLEANUP_WARNING] : [] };
}

/** Asset manifest for the files an analysis actually consumed. Allowlist only. */
export function buildAssetManifest(plannedFiles: string[], cwd = process.cwd()): BundleAsset[] {
  const out: BundleAsset[] = [];
  for (const f of plannedFiles) {
    const abs = path.resolve(cwd, f);
    const name = path.basename(abs);
    if (!isCreativeAssetFile(name)) continue;
    const sum = sha256File(abs);
    if (sum === null) continue;
    let bytes = 0;
    try { bytes = fs.statSync(abs).size; } catch { bytes = 0; }
    out.push({ filename: name, sha256: sum, bytes });
  }
  return out;
}

// ─── Verified-metadata sidecar (read-only, provenance-aware) ──────────────────

export type VerifiedMetaDecision = {
  ad_id: string;
  headline: string;
  headline_status: string;
  description: string;
  description_status: string;
  verification_status: string;
};

const VERIFIED_COLS = [
  'ad_id', 'verified_headline', 'verified_description', 'cta', 'display_url', 'landing_url',
  'capture_strategy', 'headline_status', 'headline_reason', 'description_status',
  'description_reason', 'verification_status', 'verification_reason', 'captured_at',
];

/**
 * Strict, fail-closed sidecar loader. Any duplicate ad_id invalidates the WHOLE
 * sidecar (matching the capture/preview/ingest contract). Only per-field ACCEPT
 * values are ever surfaced; raw browser listing text can never enter here.
 */
export function loadVerifiedMetaSidecar(
  csvText: string,
): { ok: true; map: Map<string, VerifiedMetaDecision> } | { ok: false; errors: string[] } {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { ok: false, errors: ['verified-metadata sidecar is empty'] };

  const header = splitCsvLine(lines[0]!);
  const missing = VERIFIED_COLS.filter((c) => !header.includes(c));
  if (missing.length) return { ok: false, errors: [`verified-metadata sidecar header missing: ${missing.join(', ')}`] };

  const idx = (c: string) => header.indexOf(c);
  const map = new Map<string, VerifiedMetaDecision>();
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const id = (cells[idx('ad_id')] ?? '').trim();
    if (id === '') continue;
    if (map.has(id)) return { ok: false, errors: [`verified-metadata sidecar has duplicate ad_id ${id} — entire sidecar rejected`] };
    map.set(id, {
      ad_id: id,
      headline: (cells[idx('verified_headline')] ?? '').trim(),
      headline_status: (cells[idx('headline_status')] ?? '').trim().toUpperCase(),
      description: (cells[idx('verified_description')] ?? '').trim(),
      description_status: (cells[idx('description_status')] ?? '').trim().toUpperCase(),
      verification_status: (cells[idx('verification_status')] ?? '').trim().toUpperCase(),
    });
  }
  return { ok: true, map };
}

/** Minimal RFC4180-ish splitter (quoted fields, doubled quotes). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
