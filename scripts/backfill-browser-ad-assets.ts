/**
 * Backfill Captured Asset Evidence for existing browser-collected ads  (Phase H)
 *
 * The normal browser ingestion (scripts/ingest-browser-collected-ads.ts) skips
 * duplicates by competitorId + metaAdId — which is correct, but means older ads
 * ingested before Phase G never received capturedAssetPath / capturedAssetType.
 *
 * This script backfills ONLY the captured-evidence fields onto EXISTING ads. It
 * never inserts, never deletes, never touches AdAnalysis, and never changes
 * copy/headline/description/score/qualified or any relation. Existing ingestion
 * behaviour is completely unchanged (this is a separate, additive tool).
 *
 * For each READY row in BROWSER_ADS_FILE it finds the existing Ad by
 * (competitorId + metaAdId) and, only when needed, updates:
 *   - capturedAssetPath   (from CSV creative_asset_path)
 *   - capturedAssetType   (inferred from the saved files, same as ingestion)
 *   - lastCheckedAt       (now)
 *   - lastSeenActiveAt    (now — set because the row carries creative_asset_path)
 *
 * SAFETY: dry-run by default. Live writes require ALL THREE flags:
 *   BROWSER_DRY_RUN=false
 *   BROWSER_BACKFILL_WRITE=true
 *   BROWSER_BACKFILL_CONFIRM_DB_WRITES=I_UNDERSTAND
 *
 * Usage:
 *   set "BROWSER_ADS_FILE=data/imports/<file>.with-assets.csv"
 *   set "COMPETITOR_ID=<cuid>"
 *   npm run browser:backfill-assets                         (dry-run)
 */

import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

type CsvRow = Record<string, string>;

/** Infer the captured asset TYPE from the saved files — identical to ingestion. */
function deriveCapturedAssetType(assetPath: string): string {
  try {
    const abs = path.resolve(assetPath);
    const st = fs.statSync(abs);
    const files = (st.isDirectory() ? fs.readdirSync(abs) : [path.basename(abs)]).map((f) => f.toLowerCase());
    if (files.some((f) => /^image-\d+\.(?:png|jpe?g|webp)$/.test(f)))      return 'CREATIVE_IMAGE';
    if (files.some((f) => /^card-\d+\.(?:png|jpe?g|webp)$/.test(f)))       return 'CAROUSEL_CARD';
    if (files.some((f) => /^frame-\d+\.(?:png|jpe?g|webp)$/.test(f)))      return 'VIDEO_FRAME';
    return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

function show(v: string | null | undefined): string {
  const s = (v ?? '').toString().trim();
  return s === '' ? '(none)' : s;
}

async function main(): Promise<void> {
  const LINE = '═'.repeat(64);
  const SUB = '─'.repeat(64);

  // ── Flags ──
  const dryRun = process.env.BROWSER_DRY_RUN !== 'false';
  const writeFlag = process.env.BROWSER_BACKFILL_WRITE === 'true';
  const confirmFlag = process.env.BROWSER_BACKFILL_CONFIRM_DB_WRITES;
  const liveWrite = !dryRun && writeFlag && confirmFlag === 'I_UNDERSTAND';

  const filePathEnv = (process.env.BROWSER_ADS_FILE ?? '').trim();
  const competitorId = (process.env.COMPETITOR_ID ?? '').trim();

  console.log(`\n${LINE}`);
  console.log('  Backfill Captured Asset Evidence (Phase H)');
  console.log(LINE);
  console.log(`  Mode:          ${liveWrite ? '⚠  LIVE WRITE MODE — DB writes ACTIVE' : 'DRY RUN — no DB writes'}`);
  console.log(`  File:          ${filePathEnv || '(BROWSER_ADS_FILE not set)'}`);
  console.log(`  Competitor ID: ${competitorId || '(COMPETITOR_ID not set)'}`);
  console.log(LINE);

  if (!filePathEnv) { console.error('\n❌ BROWSER_ADS_FILE is required (the .with-assets.csv).'); process.exit(1); }
  if (!competitorId) { console.error('\n❌ COMPETITOR_ID is required.'); process.exit(1); }

  const filePath = path.resolve(filePathEnv);
  if (!fs.existsSync(filePath)) { console.error(`\n❌ File not found: ${filePath}`); process.exit(1); }

  // Guard: BROWSER_DRY_RUN=false but not all flags set → refuse to proceed.
  if (!dryRun && !liveWrite) {
    console.error('\n❌ Live write requested but not all 3 confirmation flags are set:');
    console.error(`   BROWSER_DRY_RUN=false                              ${!dryRun ? '✓' : '✗ not set'}`);
    console.error(`   BROWSER_BACKFILL_WRITE=true                        ${writeFlag ? '✓' : '✗ missing or wrong'}`);
    console.error(`   BROWSER_BACKFILL_CONFIRM_DB_WRITES=I_UNDERSTAND    ${confirmFlag === 'I_UNDERSTAND' ? '✓' : '✗ missing or wrong'}`);
    console.error('\n   Re-run with all 3 flags, or remove BROWSER_DRY_RUN=false to stay in dry-run.');
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    // ── Resolve competitor (read-only) ──
    const competitor = await prisma.competitor.findUnique({
      where: { id: competitorId },
      select: { id: true, name: true },
    });
    if (!competitor) {
      console.error(`\n❌ COMPETITOR_ID="${competitorId}" not found in the database.`);
      await prisma.$disconnect();
      process.exit(1);
    }
    console.log(`  Competitor:    ${competitor.name} (${competitor.id})`);
    console.log(SUB);

    // ── Read CSV ──
    const records = parse(fs.readFileSync(filePath, 'utf-8'), {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }) as CsvRow[];

    const readyRows = records
      .map((row, i) => ({ row, rowNumber: i + 2 })) // +2: header + 1-based
      .filter(({ row }) => (row.collection_status ?? '').trim().toUpperCase() === 'READY');

    const counts = {
      matched: 0,
      wouldUpdate: 0,
      updated: 0,
      skippedMissingPath: 0,
      skippedNotFound: 0,
      skippedAlreadySame: 0,
      errored: 0,
    };

    for (const { row, rowNumber } of readyRows) {
      const metaAdId = (row.ad_id ?? '').trim();
      const newPath = (row.creative_asset_path ?? '').trim();

      if (!metaAdId) {
        counts.errored++;
        console.log(`\n  ⚠ Row ${rowNumber}  ad_id=(empty)  → ERRORED (no metaAdId)`);
        continue;
      }
      if (!newPath) {
        counts.skippedMissingPath++;
        console.log(`\n  ○ Row ${rowNumber}  metaAdId=${metaAdId}  → SKIPPED (missing asset path)`);
        continue;
      }

      const newType = deriveCapturedAssetType(newPath);

      try {
        const existing = await prisma.ad.findFirst({
          where: { competitorId: competitor.id, metaAdId },
          select: { id: true, capturedAssetPath: true, capturedAssetType: true },
        });

        if (!existing) {
          counts.skippedNotFound++;
          console.log(`\n  ○ Row ${rowNumber}  metaAdId=${metaAdId}  → SKIPPED (no existing ad for this competitor)`);
          continue;
        }

        counts.matched++;
        const curPath = existing.capturedAssetPath ?? null;
        const curType = existing.capturedAssetType ?? null;
        const sameAlready = (curPath ?? '') === newPath && (curType ?? '') === newType;

        const action = sameAlready ? 'SKIPPED (already same)' : (liveWrite ? 'UPDATED' : 'WOULD UPDATE');
        console.log(`\n  ${sameAlready ? '○' : '✓'} Row ${rowNumber}  metaAdId=${metaAdId}`);
        console.log(`      capturedAssetPath: ${show(curPath)}  →  ${show(newPath)}`);
        console.log(`      capturedAssetType: ${show(curType)}  →  ${show(newType)}`);
        console.log(`      action:            ${action}`);

        if (sameAlready) {
          counts.skippedAlreadySame++;
          continue;
        }

        if (liveWrite) {
          await prisma.ad.update({
            where: { id: existing.id },
            data: {
              capturedAssetPath: newPath,
              capturedAssetType: newType,
              lastCheckedAt: new Date(),
              lastSeenActiveAt: new Date(), // row carries creative_asset_path
            },
          });
          counts.updated++;
        } else {
          counts.wouldUpdate++;
        }
      } catch (err: unknown) {
        counts.errored++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`\n  ⚠ Row ${rowNumber}  metaAdId=${metaAdId}  → ERRORED: ${msg.slice(0, 140)}`);
      }
    }

    // ── Summary ──
    console.log(`\n${LINE}`);
    console.log('  SUMMARY');
    console.log(LINE);
    console.log(`  Mode:                      ${liveWrite ? 'LIVE WRITE' : 'DRY RUN'}`);
    console.log(`  File:                      ${filePath}`);
    console.log(`  Competitor:                ${competitor.name} (${competitor.id})`);
    console.log(SUB);
    console.log(`  Rows read:                 ${records.length}`);
    console.log(`  READY rows processed:      ${readyRows.length}`);
    console.log(`  Matched existing ads:      ${counts.matched}`);
    console.log(`  ${liveWrite ? 'Updated:                  ' : 'Would update:             '} ${liveWrite ? counts.updated : counts.wouldUpdate}`);
    console.log(`  Skipped (missing path):    ${counts.skippedMissingPath}`);
    console.log(`  Skipped (not found):       ${counts.skippedNotFound}`);
    console.log(`  Skipped (already same):    ${counts.skippedAlreadySame}`);
    console.log(`  Errored rows:              ${counts.errored}`);
    console.log(LINE);
    console.log('  Only capturedAssetPath / capturedAssetType / lastCheckedAt /');
    console.log('  lastSeenActiveAt are ever touched. No inserts, no deletes, no');
    console.log('  AdAnalysis changes, no copy/score/relation changes.');
    if (!liveWrite) {
      console.log('  DRY RUN — nothing was written. To write, set all 3 flags:');
      console.log('    BROWSER_DRY_RUN=false  BROWSER_BACKFILL_WRITE=true  BROWSER_BACKFILL_CONFIRM_DB_WRITES=I_UNDERSTAND');
    }
    console.log(`${LINE}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
