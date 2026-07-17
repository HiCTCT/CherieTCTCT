/**
 * Browser-Collected Ads — BUNDLE-BACKED Ingestion  (Phase 1 part 2)
 *
 * Consumes a validated browser-analysis bundle and persists the analysis that the
 * preview ALREADY paid for. It never analyses anything itself.
 *
 * STRUCTURAL GUARANTEES — enforced by the import list, not by comments:
 *   - No Anthropic, no Vision, no creativeAssetAnalyser, no analyseAdRow, no
 *     competitor scoring, no Playwright, no browser, no fetch. There is no route from
 *     this script to any of them, and NO recompute fallback: a missing or invalid
 *     bundle fails the run; a missing row is REVIEW, never an AI call.
 *   - ANTHROPIC_API_KEY is neither required nor read.
 *
 * Ordering (deliberate — this is what closed the repeated-charge defect):
 *   1. evaluate live mode and the three required live-write flags;
 *   2. parse the CSV and fully validate the bundle, source identity, declared sidecar,
 *      assets and per-row binding — all local, no database;
 *   3. build the per-row decisions; NO Prisma boundary is created unless live writing is
 *      authorised AND at least one row is genuinely writable;
 *   4. only then: resolve the competitor, deduplicate, and insert.
 * No optional external work exists at all, so nothing can be charged before dedup.
 * In dry-run the database is never contacted — not even to construct a client — so
 * dry-run cannot report duplicates and says so rather than implying a check it did not
 * perform.
 *
 * PERSISTENCE REQUIRES SCHEMA v3. A v2 bundle records an analysis SUMMARY only: it
 * cannot truthfully fill the AdAnalysis columns the model requires non-null, so it
 * plans and reports but can never authorise an INSERT (see decidePersistence()).
 *
 * DEFAULT MODE: DRY RUN — no database writes.
 *
 * Usage:
 *   set BROWSER_ADS_FILE=data/imports/my-file.with-assets.csv
 *   set BROWSER_ANALYSIS_BUNDLE=<path>.bundle.json
 *   npm run browser:ingest
 *
 * Environment variables:
 *   BROWSER_ADS_FILE         — CSV path (default: data/imports/castlery-browser-collected-ads-pilot-01.csv)
 *   BROWSER_ANALYSIS_BUNDLE  — REQUIRED. Validated bundle produced by the preview.
 *   BROWSER_DRY_RUN          — 'false' + the two flags below to enable live writes (default: dry-run)
 *   COMPETITOR_ID            — Prisma cuid of target Competitor; optional if metaPageId is unique
 */

import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';

import {
  loadBundle, decidePersistence, loadVerifiedMetaSidecar, sha256Buffer,
  BUNDLE_SCHEMA_V3, IMPORT_ROOT,
} from '@/lib/analysis/browserAnalysisBundle';
import type { BrowserAnalysisBundle, BundleRow } from '@/lib/analysis/browserAnalysisBundle';
import { planIngestion, parseSourceIdentities } from '@/scripts/plan-browser-ingest-from-bundle';
import { buildIngestPayload } from '@/lib/analysis/browserIngestBundleMapping';
import type {
  AdWritePayload, AdAnalysisWritePayload, IngestPayload, VerifiedMetaDecisionInput,
} from '@/lib/analysis/browserIngestBundleMapping';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_FILE = 'data/imports/castlery-browser-collected-ads-pilot-01.csv';
const AD_SOURCE = 'browser_collected';

// ─── Database boundary ────────────────────────────────────────────────────────
//
// The smallest surface ingestion needs. Injected so the real orchestration can be
// tested with fakes — there is no second implementation for tests to drift from.

export type CompetitorRecord = {
  id: string;
  name: string;
  clientId: string;
  industryId: string;
  metaPageId: string | null;
  status: string;
};

export type IngestDb = {
  resolveCompetitor(metaPageId: string, explicitId: string | undefined): Promise<CompetitorRecord>;
  findExistingMetaAdIds(competitorId: string, metaAdIds: string[]): Promise<string[]>;
  /** Must write Ad + AdAnalysis in ONE transaction, or neither. */
  insertAdWithAnalysis(ad: AdWritePayload, analysis: AdAnalysisWritePayload): Promise<void>;
  disconnect(): Promise<void>;
};

/**
 * Creates the boundary. Called ONLY when the run actually reaches the database stage —
 * after all three live-write flags, after full source and bundle validation, and only
 * when at least one row is genuinely writable. A dry run, an invalid bundle, a source
 * mismatch, a v2 bundle or a held-only workload never calls it, so no Prisma client is
 * ever constructed for them.
 */
export type DbFactory = () => Promise<IngestDb>;

// ─── Outcomes ─────────────────────────────────────────────────────────────────

export type IngestOutcome =
  | 'WOULD_INSERT'        // valid v3 SUCCESS, new — insert only in authorised live mode
  | 'INSERTED'
  | 'SKIPPED_EXISTING'    // already in the database — never updated
  | 'BLOCKED_SCHEMA'      // v2 bundle: plannable, never persistable
  | 'REVIEW'
  | 'SKIPPED'
  | 'UNAVAILABLE'
  | 'ERROR'
  | 'WRITE_ERROR';

export type IngestRow = {
  adId: string;
  rowNumber: number;
  sourceStatus: string;
  outcome: IngestOutcome;
  reason: string;
  /** Present only for a row that is genuinely writable. */
  payload?: IngestPayload;
};

export type IngestRunResult =
  | { ok: false; errors: string[]; rows: []; dbCalls: 0 }
  | {
      ok: true;
      rows: IngestRow[];
      schemaVersion: number;
      persistable: boolean;
      liveWrite: boolean;
      inserted: number;
      writeErrors: number;
    };

export type IngestOptions = {
  csvPath: string;
  bundlePath: string | undefined;
  dryRun: boolean;
  writeFlag: boolean;
  confirmFlag: string | undefined;
  competitorId?: string;
  cwd?: string;
  now?: Date;
  log?: (msg: string) => void;
};

// ─── Verified-metadata sidecar — BOUND TO THE BUNDLE'S DECLARATION ────────────

type SidecarLoad =
  | { ok: true; map: Map<string, VerifiedMetaDecisionInput>; message: string }
  | { ok: false; errors: string[] };

/**
 * Loads ONLY the sidecar the bundle declared, from the exact bytes its checksum covers.
 *
 * There is deliberately no discovery and no fallback: if the bundle declares no sidecar,
 * ingestion uses no verified metadata at all, even when a canonical file exists beside
 * the CSV. Otherwise a sidecar created or edited AFTER the bundle was written could put
 * advertiser copy into the database that no bundle ever vouched for.
 *
 * The bytes are read ONCE and the checksum is computed over that same buffer, so there
 * is no time-of-check/time-of-use gap between verifying and parsing.
 */
function loadDeclaredSidecar(bundle: BrowserAnalysisBundle, cwd: string): SidecarLoad {
  if (!bundle.verified_meta_path || !bundle.verified_meta_sha256) {
    return { ok: true, map: new Map(), message: 'none declared by the bundle — no verified metadata will be used' };
  }

  const abs = path.resolve(cwd, bundle.verified_meta_path);
  const importRoot = path.resolve(cwd, IMPORT_ROOT);
  const contained = (() => {
    try {
      const root = fs.realpathSync(importRoot);
      let child: string;
      try { child = fs.realpathSync(abs); } catch { child = abs; }
      return child === root || child.startsWith(root + path.sep);
    } catch { return false; }
  })();
  if (!contained) return { ok: false, errors: [`declared verified_meta_path resolves outside ${IMPORT_ROOT} — refusing`] };

  let buf: Buffer;
  try { buf = fs.readFileSync(abs); }
  catch (e) { return { ok: false, errors: [`declared verified-metadata sidecar is missing or unreadable: ${bundle.verified_meta_path} (${e instanceof Error ? e.message : String(e)})`] }; }

  // Checksum the exact bytes we are about to parse — not a re-read.
  const sum = sha256Buffer(buf);
  if (sum !== bundle.verified_meta_sha256) {
    return { ok: false, errors: [`verified-metadata checksum mismatch for ${bundle.verified_meta_path} — the sidecar changed since the bundle was written`] };
  }

  // The shared strict parser — same rules as validation and the planner, no weaker
  // ingestion-only copy.
  const parsed = loadVerifiedMetaSidecar(buf.toString('utf-8'));
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  const map = new Map<string, VerifiedMetaDecisionInput>();
  for (const [id, d] of parsed.map) {
    map.set(id, {
      headline: d.headline,
      headline_status: d.headline_status,
      description: d.description,
      description_status: d.description_status,
    });
  }
  return { ok: true, map, message: `declared sidecar verified — ${map.size} usable row(s)` };
}

// ─── Mixed-competitor guard (unchanged rule) ──────────────────────────────────

export function assertSingleCompetitor(readyRows: Record<string, string>[], filePath: string): string | null {
  const pageIdMap = new Map<string, { count: number; exampleName: string }>();
  for (const row of readyRows) {
    const pid = (row.meta_page_id ?? '').trim();
    const name = (row.competitor_name ?? '').trim() || '(unknown)';
    const existing = pageIdMap.get(pid);
    if (existing) existing.count++;
    else pageIdMap.set(pid, { count: 1, exampleName: name });
  }
  if (pageIdMap.size <= 1) return null;
  const detail = Array.from(pageIdMap.entries())
    .map(([pid, { count, exampleName }]) => `  • meta_page_id: ${pid}  (${count} READY row(s), competitor_name: "${exampleName}")`)
    .join('\n');
  return (
    `CSV contains READY rows from ${pageIdMap.size} different competitors (${filePath}):\n\n${detail}\n\n` +
    'Each CSV file must contain READY rows for one competitor only.\n' +
    'Split the file into separate CSVs — one per competitor — then re-run.'
  );
}

// ─── Captured-asset type (mechanical, from the saved files) ───────────────────

function deriveCapturedAssetType(assetPath: string, cwd: string): string | null {
  if (!assetPath) return null;
  try {
    const abs = path.resolve(cwd, assetPath);
    const st = fs.statSync(abs);
    const files = (st.isDirectory() ? fs.readdirSync(abs) : [path.basename(abs)]).map((f) => f.toLowerCase());
    if (files.some((f) => /^image-\d+\.(?:png|jpe?g|webp)$/.test(f))) return 'CREATIVE_IMAGE';
    if (files.some((f) => /^card-\d+\.(?:png|jpe?g|webp)$/.test(f))) return 'CAROUSEL_CARD';
    if (files.some((f) => /^frame-\d+\.(?:png|jpe?g|webp)$/.test(f))) return 'VIDEO_FRAME';
  } catch { /* missing/unreadable — UNKNOWN */ }
  return 'UNKNOWN';
}

// ─── Plan action → outcome ────────────────────────────────────────────────────

function outcomeForPlan(p: PlannedActionLite): IngestOutcome {
  switch (p) {
    case 'REVIEW': return 'REVIEW';
    case 'UNAVAILABLE': return 'UNAVAILABLE';
    case 'SKIP': return 'SKIPPED';
    case 'ERROR': return 'ERROR';
    default: return 'REVIEW';
  }
}
type PlannedActionLite = 'INSERT' | 'UPDATE' | 'SKIP' | 'REVIEW' | 'UNAVAILABLE' | 'ERROR';

// ─── Orchestration ────────────────────────────────────────────────────────────

/**
 * The real ingestion flow. `db` is contacted ONLY after full validation AND live-write
 * authorisation — a dry run, an invalid bundle or a v2 bundle reaches zero database calls.
 */
export async function runIngestion(opts: IngestOptions, getDb: DbFactory | null): Promise<IngestRunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => { /* quiet by default in tests */ });
  const fail = (...errors: string[]): IngestRunResult => ({ ok: false, errors, rows: [], dbCalls: 0 });

  const liveWrite = !opts.dryRun && opts.writeFlag && opts.confirmFlag === 'I_UNDERSTAND';
  if (!opts.dryRun && !liveWrite) {
    return fail(
      'Live write mode requires all 3 flags to be set correctly:',
      `  BROWSER_DRY_RUN=false                          ${!opts.dryRun ? '✓' : '✗ not set'}`,
      `  BROWSER_INGEST_WRITE=true                      ${opts.writeFlag ? '✓' : '✗ missing or wrong'}`,
      `  BROWSER_INGEST_CONFIRM_DB_WRITES=I_UNDERSTAND  ${opts.confirmFlag === 'I_UNDERSTAND' ? '✓' : '✗ missing or wrong'}`,
    );
  }

  // ── 1. Bundle is mandatory. There is no analysis fallback. ──
  if (!opts.bundlePath || !opts.bundlePath.trim()) {
    return fail(
      'BROWSER_ANALYSIS_BUNDLE is required — ingestion is bundle-only and never analyses anything itself.',
      'Produce one with the preview (AI_PREVIEW_OUTPUT_FILE), then re-run.',
    );
  }

  // ── 2. Source CSV ──
  const csvAbs = path.resolve(cwd, opts.csvPath);
  if (!fs.existsSync(csvAbs)) return fail(`File not found: ${csvAbs}`);
  let rawRows: Record<string, string>[];
  try {
    rawRows = parse(fs.readFileSync(csvAbs, 'utf-8'), { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  } catch (e) {
    return fail(`Could not read source CSV: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (rawRows.length === 0) return fail('CSV has no data rows.');

  // ── 3. Full bundle validation — structure, source, sidecar, assets, row identity ──
  //     checkFiles stays ON: the production path never trusts a bundle it has not
  //     verified against the files on disk.
  const loaded = loadBundle(path.resolve(cwd, opts.bundlePath), { cwd });
  if (!loaded.ok) {
    return fail('Bundle rejected — refusing to ingest (there is no fallback to re-analysis).', ...loaded.errors);
  }
  const bundle: BrowserAnalysisBundle = loaded.bundle;

  if (path.resolve(cwd, bundle.source_csv_path) !== csvAbs) {
    return fail(
      'Source identity mismatch — refusing to ingest.',
      `  CSV given : ${csvAbs}`,
      `  Bundle for: ${path.resolve(cwd, bundle.source_csv_path)}`,
    );
  }

  // ── 4. Canonical source identities (no silent row dropping) ──
  const parsed = parseSourceIdentities(rawRows, cwd);
  if (!parsed.ok) return fail('Source CSV rejected — refusing to ingest.', ...parsed.errors);

  const readyRaw = rawRows.filter((r) => (r.collection_status ?? '').trim().toUpperCase() === 'READY');
  const mixed = assertSingleCompetitor(readyRaw, csvAbs);
  if (mixed) return fail(mixed);

  // ── 5. Verified metadata — ONLY what the bundle declared, from checksum-covered bytes ──
  const sidecar = loadDeclaredSidecar(bundle, cwd);
  if (!sidecar.ok) {
    return fail('Declared verified-metadata sidecar rejected — refusing to ingest.', ...sidecar.errors);
  }
  log(`  Verified-meta sidecar: ${sidecar.message}`);

  // ── 6. Per-row decisions — reuses the Part 1 planner verbatim. Still no writes. ──
  const planned = planIngestion(parsed.rows, bundle, { verifiedMeta: null });
  if (!planned.ok) return fail('Plan rejected — refusing to ingest.', ...planned.errors);

  const byId = new Map<string, BundleRow>(bundle.rows.map((r) => [r.ad_id, r]));
  const persistableSchema = bundle.schema_version >= BUNDLE_SCHEMA_V3;
  // Safe to parse: validation has already proven created_at is an exact ISO instant.
  const bundleCreatedAt = new Date(bundle.created_at);
  const rows: IngestRow[] = [];

  for (const p of planned.plan) {
    const base = { adId: p.adId, rowNumber: p.rowNumber, sourceStatus: p.sourceStatus };

    // Anything the planner already held stays held, verbatim.
    if (p.action !== 'INSERT' && p.action !== 'UPDATE') {
      rows.push({ ...base, outcome: outcomeForPlan(p.action), reason: p.reason });
      continue;
    }

    const bundleRow = byId.get(p.adId);
    if (!bundleRow) {
      rows.push({ ...base, outcome: 'REVIEW', reason: 'no analysis found in bundle for this ad — never auto-analysed here' });
      continue;
    }

    // The persistence gate. A v2 bundle stops here, by design.
    const decision = decidePersistence(bundle, bundleRow);
    if (!decision.persistable) {
      rows.push({
        ...base,
        outcome: persistableSchema ? 'REVIEW' : 'BLOCKED_SCHEMA',
        reason: decision.reason,
      });
      continue;
    }

    const identity = parsed.rows.find((s) => s.ad_id === p.adId)!;
    const raw = rawRows[identity.source_row_number - 2] ?? {};
    const vm = sidecar.map.get(p.adId) ?? null;
    const activeSinceRaw = (raw.ad_delivery_start_time ?? '').trim();
    const activeSince = activeSinceRaw ? new Date(activeSinceRaw) : null;

    const built = buildIngestPayload(decision.row, {
      competitorId: '', clientId: '', industryId: '',   // filled after competitor resolution
      productOrService: (raw.competitor_name ?? '').trim(),
      adLink: (raw.ad_library_url ?? '').trim(),
      activeSince: activeSince && !Number.isNaN(activeSince.getTime()) ? activeSince : null,
      primaryCopy: identity.copy_used_for_scoring,
      capturedAssetType: deriveCapturedAssetType(bundleRow.creative_asset_path, cwd),
      verifiedMeta: vm,
      adSource: AD_SOURCE,
      now,
      // The benchmark was computed during preview, at the bundle's created_at — which
      // strict validation has already proven is an exact ISO instant.
      benchmarkScoredAt: bundleCreatedAt,
    });
    if (!built.ok) {
      rows.push({ ...base, outcome: 'ERROR', reason: built.reason });
      continue;
    }

    rows.push({
      ...base,
      outcome: 'WOULD_INSERT',
      reason: 'READY + validated v3 SUCCESS analysis reused from the bundle; no AI call was made',
      payload: built.payload,
    });
  }

  const summary = { schemaVersion: bundle.schema_version, persistable: persistableSchema, liveWrite };

  // ── 7. Dry run stops here: the database is never contacted. ──
  if (!liveWrite) {
    return { ok: true, rows, ...summary, inserted: 0, writeErrors: 0 };
  }
  if (!persistableSchema) {
    return fail(
      `Bundle is schema v${bundle.schema_version} — it cannot authorise any INSERT.`,
      `Only a schema v${BUNDLE_SCHEMA_V3} bundle records the complete analysis needed to write truthfully.`,
      'Re-run the preview to produce one. Analysis is never recomputed here.',
    );
  }
  const writable = rows.filter((r) => r.outcome === 'WOULD_INSERT' && r.payload);
  if (writable.length === 0) {
    // Nothing to write: the database is never contacted, so no client is constructed.
    return { ok: true, rows, ...summary, inserted: 0, writeErrors: 0 };
  }
  if (!getDb) return fail('No database boundary was provided — refusing to continue.');

  // ── 8. The database stage. This is the FIRST point at which a client exists: every
  //     flag is satisfied, the bundle is fully validated, and a row is genuinely writable.
  let db: IngestDb;
  try {
    db = await getDb();
  } catch (e) {
    return fail(`Could not open the database boundary: ${e instanceof Error ? e.message : String(e)}`);
  }

  let competitor: CompetitorRecord;
  try {
    const metaPageId = (readyRaw[0]?.meta_page_id ?? '').trim();
    competitor = await db.resolveCompetitor(metaPageId, opts.competitorId);
  } catch (e) {
    return fail(`Competitor lookup failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── 9. Duplicate detection BEFORE any write. No optional work precedes it. ──
  let existing: Set<string>;
  try {
    existing = new Set(await db.findExistingMetaAdIds(competitor.id, writable.map((r) => r.adId)));
  } catch (e) {
    return fail(`Duplicate check failed — refusing to write: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── 10. An existing ad is skipped, never updated. Insert-only policy unchanged. ──
  const toWrite: IngestRow[] = [];
  for (const r of writable) {
    if (existing.has(r.adId)) {
      r.outcome = 'SKIPPED_EXISTING';
      r.reason = 'metaAdId already present for this competitor — skipped, never updated';
      delete r.payload;
      continue;
    }
    toWrite.push(r);
  }

  // ── 11. Transactional inserts, isolated per row. ──
  let inserted = 0;
  let writeErrors = 0;
  for (const r of toWrite) {
    const payload = r.payload!;
    try {
      await db.insertAdWithAnalysis(
        { ...payload.ad, competitorId: competitor.id, clientId: competitor.clientId, industryId: competitor.industryId },
        payload.analysis,
      );
      r.outcome = 'INSERTED';
      inserted++;
      log(`  ✓ Inserted  row ${r.rowNumber}  ad_id=${r.adId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes('unique constraint')) {
        r.outcome = 'SKIPPED_EXISTING';
        r.reason = 'metaAdId already present (detected at write time) — skipped, never updated';
      } else {
        r.outcome = 'WRITE_ERROR';
        r.reason = msg;
        writeErrors++;
        log(`  ✗ Error     row ${r.rowNumber}  ad_id=${r.adId}: ${msg}`);
      }
    }
  }

  return { ok: true, rows, ...summary, inserted, writeErrors };
}

// ─── Real database boundary (Prisma) ──────────────────────────────────────────
//
// Imported lazily inside main() so that importing this module for tests never loads
// Prisma and can never open a database handle.

async function createPrismaDb(): Promise<IngestDb> {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const select = { id: true, name: true, clientId: true, industryId: true, metaPageId: true, status: true };

  return {
    async resolveCompetitor(metaPageId, explicitId) {
      if (explicitId) {
        const c = await prisma.competitor.findUnique({ where: { id: explicitId }, select });
        if (!c) throw new Error(`COMPETITOR_ID="${explicitId}" was not found in the database.`);
        return c;
      }
      const matches = await prisma.competitor.findMany({ where: { metaPageId }, select });
      if (matches.length === 0) throw new Error(`No competitor found with metaPageId "${metaPageId}". Set COMPETITOR_ID to the correct competitor cuid.`);
      if (matches.length > 1) {
        const list = matches.map((m) => `  • id: ${m.id}  name: ${m.name}`).join('\n');
        throw new Error(`Multiple competitors share metaPageId "${metaPageId}":\n${list}\n\nSet COMPETITOR_ID=<id> to specify which.`);
      }
      return matches[0]!;
    },
    async findExistingMetaAdIds(competitorId, metaAdIds) {
      if (metaAdIds.length === 0) return [];
      const found = await prisma.ad.findMany({
        where: { competitorId, metaAdId: { in: metaAdIds } },
        select: { metaAdId: true },
      });
      return found.map((a) => a.metaAdId!).filter(Boolean);
    },
    async insertAdWithAnalysis(ad, analysis) {
      await prisma.$transaction(async (tx) => {
        const created = await tx.ad.create({ data: { ...ad, productOrService: ad.productOrService ?? undefined } });
        await tx.adAnalysis.create({ data: { ...analysis, adId: created.id } });
      });
    },
    async disconnect() { await prisma.$disconnect(); },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const LINE = '═'.repeat(63);
  const DIV = '─'.repeat(63);

  const dryRun = process.env.BROWSER_DRY_RUN !== 'false';
  const writeFlag = process.env.BROWSER_INGEST_WRITE === 'true';
  const confirmFlag = process.env.BROWSER_INGEST_CONFIRM_DB_WRITES;
  const liveWrite = !dryRun && writeFlag && confirmFlag === 'I_UNDERSTAND';
  const csvPath = path.resolve(process.env.BROWSER_ADS_FILE ?? DEFAULT_FILE);
  const bundlePath = process.env.BROWSER_ANALYSIS_BUNDLE;

  console.log(`\n${LINE}`);
  console.log('  Browser-Collected Ads — Ingestion (BUNDLE-BACKED)');
  console.log(LINE);
  console.log('  No Anthropic call.  No Vision.  No browser.  No re-analysis.');
  console.log('  Analysis is REUSED from the validated bundle and never recomputed.');
  console.log(LINE);
  console.log(`  Mode:          ${dryRun ? 'DRY RUN — no DB writes, no DB reads' : '⚠  LIVE WRITE MODE — DB writes are ACTIVE'}`);
  console.log(`  File:          ${csvPath}`);
  console.log(`  Bundle:        ${bundlePath ?? '(none — required)'}`);
  console.log(`  adSource:      ${AD_SOURCE}`);
  if (dryRun) {
    console.log('  To enable live writes, set all 3 flags:');
    console.log('    BROWSER_DRY_RUN=false');
    console.log('    BROWSER_INGEST_WRITE=true');
    console.log('    BROWSER_INGEST_CONFIRM_DB_WRITES=I_UNDERSTAND');
  }
  console.log(LINE);

  // A lazy factory: nothing is constructed until the run actually reaches the database
  // stage, which it cannot do before the flags AND full validation are satisfied.
  let db: IngestDb | null = null;
  const getDb = async (): Promise<IngestDb> => {
    db = await createPrismaDb();
    return db;
  };

  try {
    const result = await runIngestion(
      {
        csvPath, bundlePath, dryRun, writeFlag, confirmFlag,
        competitorId: process.env.COMPETITOR_ID?.trim() || undefined,
        log: (m) => console.log(m),
      },
      liveWrite ? getDb : null,
    );

    if (!result.ok) {
      console.error('\n❌ Refusing to proceed.');
      for (const e of result.errors) console.error(`   ${e}`);
      console.log('');
      process.exit(1);
    }

    console.log(`\n${DIV}`);
    console.log(`  Bundle schema v${result.schemaVersion}${result.persistable ? '' : ' — PLANNING ONLY, cannot authorise any INSERT'}`);
    console.log(DIV);
    for (const r of result.rows) {
      console.log(`  ${r.outcome.padEnd(17)} ${r.adId.padEnd(18)} row ${String(r.rowNumber).padEnd(3)} ${r.sourceStatus.padEnd(13)} ${r.reason}`);
    }

    const tally = (o: IngestOutcome) => result.rows.filter((r) => r.outcome === o).length;
    console.log(`\n${DIV}`);
    console.log('  Summary');
    console.log(DIV);
    for (const o of ['WOULD_INSERT', 'INSERTED', 'SKIPPED_EXISTING', 'BLOCKED_SCHEMA', 'REVIEW', 'SKIPPED', 'UNAVAILABLE', 'ERROR', 'WRITE_ERROR'] as IngestOutcome[]) {
      const n = tally(o);
      if (n > 0) console.log(`  ${o.padEnd(18)} ${n}`);
    }
    console.log(`  ${'TOTAL'.padEnd(18)} ${result.rows.length}   (held rows are counted, never hidden)`);

    console.log(`\n${LINE}`);
    console.log('  Safety confirmation');
    console.log(LINE);
    if (!result.liveWrite) {
      console.log('  No database writes were performed.');
      console.log('  No database READ was performed either — dry run never contacts the database,');
      console.log('  so duplicates are not reported here. They are detected before any live insert.');
    } else {
      console.log('  No existing records were updated or deleted.');
      console.log(`  Inserted ${result.inserted} Ad + AdAnalysis record(s); ${result.writeErrors} write error(s).`);
    }
    console.log('  No Anthropic call was made. No analysis was recomputed.');
    console.log('  No schema changes were made.');
    console.log(LINE);
    console.log('');
  } finally {
    // Only if a boundary was actually created.
    if (db) await (db as IngestDb).disconnect();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
