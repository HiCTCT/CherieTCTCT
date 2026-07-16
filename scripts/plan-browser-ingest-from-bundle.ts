/**
 * Bundle-backed browser ingestion PLANNER  (Phase 1)  — NO WRITES, NO AI
 *
 * Consumes a browser-collected CSV plus a validated browser-analysis bundle and
 * produces a per-ad ingestion plan. A deliberately SEPARATE, no-write path from
 * scripts/ingest-browser-collected-ads.ts (which is untouched).
 *
 * STRUCTURAL GUARANTEES — enforced by the import list, not by comments:
 *   - No import path to the Anthropic analyser, Playwright, Prisma or SQLite.
 *   - No fetch/network. No database read or write.
 *   - No recompute fallback: missing bundle → fail; invalid bundle → fail;
 *     missing row → REVIEW; stale checksum → fail; identity drift → fail.
 *
 * "Already ingested" ids are INJECTED (BROWSER_PLAN_EXISTING_AD_IDS) rather than
 * queried, so this stays DB-free. A later phase swaps in a real lookup.
 *
 * Usage:
 *   set BROWSER_ADS_FILE=data/imports/<file>.with-assets.csv
 *   set BROWSER_ANALYSIS_BUNDLE=<path>.bundle.json
 *   npm run browser:plan-from-bundle
 */

import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';

import {
  loadBundle, bundleRowIdentity, loadVerifiedMetaSidecar,
} from '@/lib/analysis/browserAnalysisBundle';
import type { BrowserAnalysisBundle, BundleRow, VerifiedMetaDecision } from '@/lib/analysis/browserAnalysisBundle';
import { deriveSourceRowIdentity, sourceRowIdentityMismatch } from '@/lib/analysis/sourceRowIdentity';
import type { SourceRowIdentity } from '@/lib/analysis/sourceRowIdentity';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PlanAction = 'INSERT' | 'UPDATE' | 'SKIP' | 'REVIEW' | 'UNAVAILABLE' | 'ERROR';

export type PlannedAd = {
  adId: string;
  rowNumber: number;
  sourceStatus: string;
  action: PlanAction;
  reason: string;
  /** Only ACCEPTed verified metadata may appear here. */
  verifiedHeadline: string | null;
  verifiedDescription: string | null;
  /** True when a sidecar value exists but its provenance is not ACCEPT. */
  reviewOnlyMetadata: boolean;
};

export type IdSetResult = { ok: true; ids: string[] | null } | { ok: false; reason: string };

// ─── Exact-id parsing (fail closed) ───────────────────────────────────────────

export function parseIdList(name: string, raw: string | undefined): IdSetResult {
  if (raw === undefined) return { ok: true, ids: null };
  const parts = raw.split(',').map((s) => s.trim());
  const seen = new Set<string>();
  for (const p of parts) {
    if (p === '') return { ok: false, reason: `${name} contains an empty entry (check stray or trailing commas)` };
    if (!/^\d+$/.test(p)) return { ok: false, reason: `${name} contains a non-numeric entry ("${p}")` };
    if (seen.has(p)) return { ok: false, reason: `${name} contains a duplicate id ("${p}")` };
    seen.add(p);
  }
  return { ok: true, ids: Array.from(seen) };
}

// ─── Source parsing (pure, no filtering) ──────────────────────────────────────

/**
 * Turns parsed CSV rows into canonical identities WITHOUT dropping anything. A
 * missing `ad_id` column fails here; blank / malformed / duplicate ids fail in
 * planIngestion(). No row is ever silently removed to make a plan succeed.
 */
export function parseSourceIdentities(
  rawRows: Record<string, string>[],
  cwd = process.cwd(),
): { ok: true; rows: SourceRowIdentity[] } | { ok: false; errors: string[] } {
  if (rawRows.length === 0) return { ok: false, errors: ['source CSV contains no data rows'] };
  if (!Object.keys(rawRows[0]!).includes('ad_id')) {
    return { ok: false, errors: ['source CSV has no ad_id column — refusing to plan'] };
  }
  return { ok: true, rows: rawRows.map((r, i) => deriveSourceRowIdentity(r, i + 2, cwd)) };
}

// ─── Planner (pure) ───────────────────────────────────────────────────────────

export type PlanOptions = {
  include?: string[] | null;
  exclude?: string[] | null;
  existing?: string[] | null;
  verifiedMeta?: Map<string, VerifiedMetaDecision> | null;
};

export type PlanResult = { ok: true; plan: PlannedAd[] } | { ok: false; errors: string[] };

/**
 * Pure planning over canonical source identities. Exact numeric string equality only.
 * Each row is decided independently: one held row never blocks another valid row.
 */
export function planIngestion(
  sourceRows: SourceRowIdentity[],
  bundle: BrowserAnalysisBundle,
  opts: PlanOptions = {},
): PlanResult {
  const errors: string[] = [];

  // Source hygiene — reject before planning anything. Every row is parsed and
  // validated; an invalid row fails the WHOLE plan rather than being dropped, so a
  // partial plan can never look like a complete one. Offending values are never echoed.
  const seen = new Set<string>();
  for (const r of sourceRows) {
    if (r.ad_id === '') { errors.push(`source row ${r.source_row_number}: ad_id is blank`); continue; }
    if (!/^\d+$/.test(r.ad_id)) { errors.push(`source row ${r.source_row_number}: ad_id is not an exact numeric id`); continue; }
    if (seen.has(r.ad_id)) errors.push(`source CSV contains duplicate ad_id ${r.ad_id}`);
    seen.add(r.ad_id);
  }

  const include = opts.include ? new Set(opts.include) : null;
  const exclude = new Set(opts.exclude ?? []);
  const existing = new Set(opts.existing ?? []);

  // Include/exclude conflicts are configuration errors, never silent SKIPs.
  if (include) {
    for (const id of include) if (exclude.has(id)) errors.push(`id ${id} appears in BOTH the include and exclude sets`);
    for (const id of include) if (!seen.has(id)) errors.push(`requested include id ${id} is not present in the source CSV`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const byId = new Map<string, BundleRow>(bundle.rows.map((r) => [r.ad_id, r]));
  const vm = opts.verifiedMeta ?? null;
  const out: PlannedAd[] = [];

  for (const row of sourceRows) {
    const blank = { verifiedHeadline: null, verifiedDescription: null, reviewOnlyMetadata: false };
    const base = { adId: row.ad_id, rowNumber: row.source_row_number, sourceStatus: row.source_status };

    if (exclude.has(row.ad_id)) { out.push({ ...base, ...blank, action: 'SKIP', reason: 'excluded by BROWSER_PLAN_EXCLUDE_AD_IDS' }); continue; }
    if (include && !include.has(row.ad_id)) { out.push({ ...base, ...blank, action: 'SKIP', reason: 'not in BROWSER_PLAN_ONLY_AD_IDS include set' }); continue; }

    const status = row.source_status;
    if (status === 'NEEDS_REVIEW') { out.push({ ...base, ...blank, action: 'REVIEW', reason: 'source status NEEDS_REVIEW — capture could not establish the ad state' }); continue; }
    if (status === 'UNAVAILABLE') { out.push({ ...base, ...blank, action: 'UNAVAILABLE', reason: 'source status UNAVAILABLE — ad positively detected as ended/not in library' }); continue; }
    if (status === 'SKIP') { out.push({ ...base, ...blank, action: 'SKIP', reason: 'source status SKIP' }); continue; }
    if (status !== 'READY') { out.push({ ...base, ...blank, action: 'REVIEW', reason: `unrecognised source status "${status}" — failing closed to review` }); continue; }

    // Bundle entry is mandatory — never recompute, never call AI.
    const b = byId.get(row.ad_id);
    if (!b) { out.push({ ...base, ...blank, action: 'REVIEW', reason: 'no analysis found in bundle for this ad — re-run preview to produce one (never auto-analysed here)' }); continue; }

    // Per-row source binding: a whole-file checksum is not enough.
    const drift = sourceRowIdentityMismatch(bundleRowIdentity(b), row);
    if (drift.length > 0) {
      out.push({ ...base, ...blank, action: 'ERROR', reason: `bundle row does not match the source CSV row (${drift.join(', ')}) — refusing to ingest` });
      continue;
    }

    // Held variants carry no result block at all — narrow them out in one step.
    if (b.analysis_status !== 'SUCCESS') {
      const action: PlanAction =
        b.analysis_status === 'ERROR' ? 'ERROR' :
        b.analysis_status === 'REVIEW' ? 'REVIEW' : 'SKIP';
      const label =
        b.analysis_status === 'ERROR' ? 'analysis error' :
        b.analysis_status === 'REVIEW' ? 'analysis flagged for review' : 'analysis skipped';
      out.push({ ...base, ...blank, action, reason: `${label}: ${b.error_reason}` });
      continue;
    }

    if (b.visual_confidence === 'LOW') {
      out.push({ ...base, ...blank, action: 'REVIEW', reason: 'LOW visual confidence — model could not confidently identify the visual sequence' });
      continue;
    }

    // Verified metadata: ACCEPT-only may be planned; anything else stays review-only.
    let vh: string | null = null;
    let vd: string | null = null;
    let reviewOnly = false;
    if (vm) {
      const d = vm.get(row.ad_id);
      if (d) {
        if (d.ad_id !== row.ad_id) {
          out.push({ ...base, ...blank, action: 'REVIEW', reason: 'verified-metadata provenance mismatch — sidecar row is not for this ad' });
          continue;
        }
        if (d.headline_status === 'ACCEPT' && d.headline) vh = d.headline; else if (d.headline) reviewOnly = true;
        if (d.description_status === 'ACCEPT' && d.description) vd = d.description; else if (d.description) reviewOnly = true;
      }
    }

    out.push({
      ...base,
      action: existing.has(row.ad_id) ? 'UPDATE' : 'INSERT',
      reason: existing.has(row.ad_id)
        ? 'validated bundle analysis; ad already present (injected existing-id set)'
        : 'READY + validated SUCCESS analysis from bundle; source row binding verified',
      verifiedHeadline: vh,
      verifiedDescription: vd,
      reviewOnlyMetadata: reviewOnly,
    });
  }
  return { ok: true, plan: out };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const LINE = '═'.repeat(63);
  const DIV = '─'.repeat(63);

  const csvPath = process.env.BROWSER_ADS_FILE;
  const bundlePath = process.env.BROWSER_ANALYSIS_BUNDLE;

  console.log(`\n${LINE}`);
  console.log('  Browser Ingestion Planner — BUNDLE-BACKED, NO WRITES');
  console.log(LINE);
  console.log('  No Anthropic call.  No Vision.  No browser.  No database.  No writes.');
  console.log('  Analysis is REUSED from the bundle and never recomputed.');
  console.log(LINE);

  if (!csvPath) { console.error('\n❌ BROWSER_ADS_FILE is required.'); process.exit(1); }
  if (!bundlePath) { console.error('\n❌ BROWSER_ANALYSIS_BUNDLE is required — this planner is bundle-only and has no AI fallback.'); process.exit(1); }

  const include = parseIdList('BROWSER_PLAN_ONLY_AD_IDS', process.env.BROWSER_PLAN_ONLY_AD_IDS);
  const exclude = parseIdList('BROWSER_PLAN_EXCLUDE_AD_IDS', process.env.BROWSER_PLAN_EXCLUDE_AD_IDS);
  const existing = parseIdList('BROWSER_PLAN_EXISTING_AD_IDS', process.env.BROWSER_PLAN_EXISTING_AD_IDS);
  for (const cfg of [include, exclude, existing]) {
    if (!cfg.ok) { console.error(`\n❌ Invalid configuration — refusing to run.\n   ${cfg.reason}`); process.exit(1); }
  }

  const loaded = loadBundle(bundlePath);
  if (!loaded.ok) {
    console.error('\n❌ Bundle rejected — refusing to plan (no fallback to re-analysis).');
    console.error(`   Bundle: ${bundlePath}`);
    for (const e of loaded.errors) console.error(`     • ${e}`);
    process.exit(1);
  }
  const bundle = loaded.bundle;

  const csvAbs = path.resolve(csvPath);
  if (csvAbs !== path.resolve(bundle.source_csv_path)) {
    console.error('\n❌ Source identity mismatch — refusing to plan.');
    console.error(`   CSV given : ${csvAbs}`);
    console.error(`   Bundle for: ${path.resolve(bundle.source_csv_path)}`);
    process.exit(1);
  }

  let rawRows: Record<string, string>[];
  try {
    rawRows = parse(fs.readFileSync(csvAbs, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  } catch (e) {
    console.error(`\n❌ Could not read source CSV: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const parsedSource = parseSourceIdentities(rawRows);
  if (!parsedSource.ok) {
    console.error('\n❌ Source CSV rejected — refusing to plan.');
    for (const e of parsedSource.errors) console.error(`     • ${e}`);
    process.exit(1);
  }
  const sourceRows = parsedSource.rows;

  // Verified-metadata sidecar (read-only, provenance-aware).
  let verifiedMeta: Map<string, VerifiedMetaDecision> | null = null;
  if (bundle.verified_meta_path) {
    let text: string;
    try { text = fs.readFileSync(path.resolve(bundle.verified_meta_path), 'utf-8'); }
    catch (e) { console.error(`\n❌ Declared verified-metadata sidecar unreadable: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
    const vm = loadVerifiedMetaSidecar(text);
    if (!vm.ok) { console.error('\n❌ Verified-metadata sidecar rejected — refusing to plan.'); for (const e of vm.errors) console.error(`     • ${e}`); process.exit(1); }
    verifiedMeta = vm.map;
  }

  const result = planIngestion(sourceRows, bundle, {
    include: include.ok ? include.ids : null,
    exclude: exclude.ok ? exclude.ids : null,
    existing: existing.ok ? existing.ids : null,
    verifiedMeta,
  });
  if (!result.ok) {
    console.error('\n❌ Plan rejected — refusing to proceed.');
    for (const e of result.errors) console.error(`     • ${e}`);
    process.exit(1);
  }
  const plan = result.plan;

  console.log(`\n  Source CSV : ${bundle.source_csv_path}`);
  console.log(`  Bundle     : ${bundlePath}  (schema v${bundle.schema_version}, validated)`);
  console.log(`  Sidecar    : ${bundle.verified_meta_path ?? '(none)'}`);
  console.log(`  Rows read  : ${sourceRows.length}`);
  if (include.ok && include.ids) console.log(`  Include set: ${include.ids.join(', ')}`);
  if (exclude.ok && exclude.ids) console.log(`  Exclude set: ${exclude.ids.join(', ')}`);
  if (existing.ok && existing.ids) console.log(`  Existing   : ${existing.ids.join(', ')} (injected — no DB read)`);

  console.log(`\n${DIV}`);
  console.log('  Per-ad plan');
  console.log(DIV);
  for (const p of plan) {
    console.log(`  ${p.action.padEnd(11)} ${p.adId.padEnd(18)} row ${String(p.rowNumber).padEnd(3)} ${p.sourceStatus.padEnd(13)} ${p.reason}`);
    if (p.verifiedHeadline || p.verifiedDescription) {
      console.log(`              ↳ verified (ACCEPT only): headline=${p.verifiedHeadline ? 'yes' : 'blank'} description=${p.verifiedDescription ? 'yes' : 'blank'}`);
    }
    if (p.reviewOnlyMetadata) console.log('              ↳ some sidecar metadata is REVIEW-only and was NOT promoted');
  }

  const tally = (a: PlanAction) => plan.filter((p) => p.action === a).length;
  console.log(`\n${DIV}`);
  console.log('  Summary');
  console.log(DIV);
  for (const a of ['INSERT', 'UPDATE', 'SKIP', 'REVIEW', 'UNAVAILABLE', 'ERROR'] as PlanAction[]) {
    console.log(`  ${a.padEnd(12)} ${tally(a)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(12)} ${plan.length}   (held/missing rows are counted, never hidden)`);
  console.log(`\n${LINE}`);
  console.log('  PLAN ONLY — nothing was written. No Anthropic call was made.');
  console.log('  No database was read or written. Analysis came only from the bundle.');
  console.log(`${LINE}\n`);
}

if (require.main === module) main();
