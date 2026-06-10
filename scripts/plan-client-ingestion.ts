/**
 * Plan Client Ingestion  (Phase E)
 *
 * DRY-RUN ingestion PLANNER over a client's batch outputs. Given ONE CLIENT_ID,
 * it reads (read-only) every competitor under that client that has a metaPageId,
 * derives the same output basename Phase C/D use, inspects the generated CSVs in
 * data/imports/, and classifies each competitor for ingestion — WITHOUT writing
 * to the DB, re-running scoring, or calling the live ingestion path.
 *
 * Crucially, a competitor whose CSV ended up with 0 rows AFTER the create-csv
 * retry is classified as NO_ACTIVE_ADS_OR_NO_CARDS and SKIPPED — it is NOT treated
 * as a failed ingestion, and is excluded from the "would ingest" set.
 *
 * Classes:
 *   READY_FOR_INGESTION       — .with-assets.csv has >=1 READY row (would be ingested)
 *   NO_ACTIVE_ADS_OR_NO_CARDS — base .csv has 0 data rows (post-retry empty) — SKIPPED
 *   NO_READY_ROWS             — rows exist but none READY — SKIPPED
 *   PENDING_CAPTURE           — READY rows but no .with-assets.csv yet (capture incomplete)
 *   NOT_RUN                   — no output files for this competitor
 *
 * The duplicate check mirrors the real ingestion: an ad_id already present as
 * Ad.metaAdId in the DB is counted as a duplicate that ingestion would skip.
 *
 * Read-only. No DB writes. No ingestion. No scoring. Generated files are not
 * modified. The real (gated) ingestion remains the existing `browser:ingest`.
 *
 * Inputs (env):
 *   CLIENT_ID   (required)
 *
 * Example:
 *   set "CLIENT_ID=cmp23o629000n2fn6crin5u1n"
 *   npm run browser:plan-client-ingestion
 */

import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '@/lib/db';

const LINE = '═'.repeat(64);
const SUB = '─'.repeat(64);

const CLIENT_ID = (process.env.CLIENT_ID ?? '').trim();
const IMPORTS_DIR = path.join('data', 'imports');

type Klass =
  | 'READY_FOR_INGESTION'
  | 'NO_ACTIVE_ADS_OR_NO_CARDS'
  | 'NO_READY_ROWS'
  | 'PENDING_CAPTURE'
  | 'NOT_RUN';

type Plan = {
  name: string;
  id: string;
  klass: Klass;
  csvPath: string;
  assetsPath: string;
  dataRows: number;
  readyRows: number;
  assetReadyRows: number;
  newAds: number;
  duplicateAds: number;
};

/** Filesystem-safe slug — identical to Phase C's basename derivation. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    || 'competitor';
}

/** Read a CSV into named-column records; null if the file is missing. */
function readRows(file: string): Record<string, string>[] | null {
  if (!fs.existsSync(file)) return null;
  try {
    const text = fs.readFileSync(file, 'utf-8');
    return parse(text, { columns: true, skip_empty_lines: true, relax_column_count: true }) as Record<string, string>[];
  } catch {
    return [];
  }
}

function isReady(r: Record<string, string>): boolean {
  return (r.collection_status ?? '').trim().toUpperCase() === 'READY';
}

async function main(): Promise<void> {
  console.log(`\n${LINE}`);
  console.log('  Plan Client Ingestion (Phase E) — DRY RUN');
  console.log(LINE);

  if (!CLIENT_ID) {
    console.error('\n❌ CLIENT_ID is required.');
    console.error('   Example: set "CLIENT_ID=cmp23o629000n2fn6crin5u1n"');
    process.exit(1);
  }

  const client = await db.client.findUnique({
    where: { id: CLIENT_ID },
    select: { id: true, name: true, industry: { select: { name: true } } },
  });
  if (!client) {
    console.error(`\n❌ No client found with id "${CLIENT_ID}".`);
    await db.$disconnect();
    process.exit(1);
  }

  const competitors = await db.competitor.findMany({
    where: { clientId: CLIENT_ID },
    select: { id: true, name: true, metaPageId: true },
    orderBy: { name: 'asc' },
  });
  const withMeta = competitors.filter((c) => (c.metaPageId ?? '').trim() !== '');

  console.log(`  Client:                ${client.name}`);
  console.log(`  Industry:              ${client.industry?.name ?? '(none)'}`);
  console.log(`  Competitors w/ metaPageId: ${withMeta.length} of ${competitors.length}`);
  console.log(`  Imports dir:           ${path.resolve(IMPORTS_DIR)}`);
  console.log(SUB);

  const plans: Plan[] = [];

  for (const comp of withMeta) {
    const basename = `${slugify(comp.name)}-${comp.id.slice(0, 8)}-browser-collected-ads`;
    const csvPath = path.join(IMPORTS_DIR, `${basename}.csv`);
    const assetsPath = path.join(IMPORTS_DIR, `${basename}.with-assets.csv`);

    const base: Plan = {
      name: comp.name, id: comp.id, klass: 'NOT_RUN',
      csvPath, assetsPath, dataRows: 0, readyRows: 0, assetReadyRows: 0, newAds: 0, duplicateAds: 0,
    };

    const rows = readRows(csvPath);
    if (rows === null) {
      plans.push(base); // NOT_RUN — no base CSV
      continue;
    }
    base.dataRows = rows.length;
    base.readyRows = rows.filter(isReady).length;

    if (rows.length === 0) {
      plans.push({ ...base, klass: 'NO_ACTIVE_ADS_OR_NO_CARDS' });
      continue;
    }
    if (base.readyRows === 0) {
      plans.push({ ...base, klass: 'NO_READY_ROWS' });
      continue;
    }

    const assetRows = readRows(assetsPath);
    if (assetRows === null) {
      plans.push({ ...base, klass: 'PENDING_CAPTURE' });
      continue;
    }

    const readyAssetRows = assetRows.filter(isReady);
    base.assetReadyRows = readyAssetRows.length;
    if (readyAssetRows.length === 0) {
      // capture produced a file but nothing READY remained — treat as no ready rows
      plans.push({ ...base, klass: 'NO_READY_ROWS' });
      continue;
    }

    // Read-only duplicate check — same metaAdId logic the real ingestion uses.
    const adIds = readyAssetRows.map((r) => (r.ad_id ?? '').trim()).filter(Boolean);
    let duplicateAds = 0;
    if (adIds.length > 0) {
      const existing = await db.ad.findMany({
        where: { metaAdId: { in: adIds } },
        select: { metaAdId: true },
      });
      const dupSet = new Set(existing.map((a) => a.metaAdId).filter(Boolean));
      duplicateAds = adIds.filter((id) => dupSet.has(id)).length;
    }

    plans.push({
      ...base,
      klass: 'READY_FOR_INGESTION',
      newAds: adIds.length - duplicateAds,
      duplicateAds,
    });
  }

  await db.$disconnect();

  // ── Group + print the dry-run plan ──
  const by = (k: Klass) => plans.filter((p) => p.klass === k);
  const ready = by('READY_FOR_INGESTION');
  const noActive = by('NO_ACTIVE_ADS_OR_NO_CARDS');
  const noReady = by('NO_READY_ROWS');
  const pending = by('PENDING_CAPTURE');
  const notRun = by('NOT_RUN');

  const totalReadyAds = ready.reduce((a, p) => a + p.assetReadyRows, 0);
  const totalNew = ready.reduce((a, p) => a + p.newAds, 0);
  const totalDup = ready.reduce((a, p) => a + p.duplicateAds, 0);

  console.log('  WOULD INGEST (dry run):');
  if (ready.length === 0) console.log('    (none)');
  for (const p of ready) {
    console.log(`    ✓ ${p.name}: ${p.assetReadyRows} READY ad(s) → ${p.newAds} new, ${p.duplicateAds} already in DB`);
  }

  console.log(`\n  SKIPPED — no active ads / no cards (after retry):`);
  if (noActive.length === 0) console.log('    (none)');
  for (const p of noActive) console.log(`    ○ ${p.name}: 0 rows — NO_ACTIVE_ADS_OR_NO_CARDS (not a failure)`);

  if (noReady.length > 0) {
    console.log(`\n  SKIPPED — rows present but none READY:`);
    for (const p of noReady) console.log(`    ○ ${p.name}: ${p.dataRows} row(s), 0 READY`);
  }
  if (pending.length > 0) {
    console.log(`\n  PENDING CAPTURE — READY rows but no .with-assets.csv yet:`);
    for (const p of pending) console.log(`    … ${p.name}: ${p.readyRows} READY row(s) — re-run capture`);
  }
  if (notRun.length > 0) {
    console.log(`\n  NOT RUN — no batch output found:`);
    for (const p of notRun) console.log(`    – ${p.name}`);
  }

  console.log(`\n${LINE}`);
  console.log('  DRY-RUN INGESTION PLAN — SUMMARY');
  console.log(LINE);
  console.log(`  Client:                              ${client.name}`);
  console.log(`  Competitors with metaPageId:         ${withMeta.length}`);
  console.log(`  Ready for ingestion:                 ${ready.length}`);
  console.log(`  Skipped (no active ads / no cards):  ${noActive.length}`);
  console.log(`  Skipped (no READY rows):             ${noReady.length}`);
  console.log(`  Pending capture:                     ${pending.length}`);
  console.log(`  Not run:                             ${notRun.length}`);
  console.log(SUB);
  console.log(`  Total READY ads across ready CSVs:   ${totalReadyAds}`);
  console.log(`  Would ingest (new ads):              ${totalNew}`);
  console.log(`  Would skip as duplicates (in DB):    ${totalDup}`);
  console.log(LINE);
  if (ready.length > 0) {
    console.log('  To dry-run the real per-competitor ingestion (still no DB writes):');
    for (const p of ready) {
      console.log(`    set "BROWSER_ADS_FILE=${p.assetsPath}"&& set "COMPETITOR_ID=${p.id}"&& npm run browser:ingest`);
    }
    console.log(SUB);
  }
  console.log('  Read-only. No DB writes. No ingestion performed. 0-row competitors');
  console.log('  are skipped (no active ads / no cards), never counted as failures.');
  console.log(`${LINE}\n`);
}

main().catch(async (err: unknown) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
  try { await db.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
