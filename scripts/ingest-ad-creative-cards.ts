/**
 * Ad Creative Cards — Sidecar Ingestion Script  (Phase H.3c)
 *
 * Reads per-card sidecar CSVs (data/imports/*.cards.csv) produced by
 * `browser:capture-assets` and upserts them into the AdCreativeCard table.
 *
 * It touches ONLY AdCreativeCard. It never creates Ads, never deletes cards or
 * assets, and never changes Ad / AdAnalysis / scoring / preview / UI / schema.
 *
 * ── ad_id resolution ──────────────────────────────────────────────────────────
 * The sidecar `ad_id` column is the META ad id (e.g. 844704504673875).
 * AdCreativeCard.adId is a foreign key to Ad.id (a cuid), and Prisma enforces
 * SQLite foreign keys. So each sidecar row is matched to an Ad by metaAdId, and
 * the resolved Ad.id is used as AdCreativeCard.adId. If no Ad has that metaAdId,
 * the row is skipped and reported as a "missing ad" — the Ad is NEVER created.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 * Unique key: (adId, cardIndex). Each row is read first; an identical existing
 * card is reported as "unchanged" and NOT written, so repeat runs never
 * duplicate rows and never churn updatedAt.
 *
 * ── Safety ────────────────────────────────────────────────────────────────────
 * DRY RUN by default. Live writes require ALL THREE flags:
 *   BROWSER_DRY_RUN=false
 *   BROWSER_CARD_INGEST_WRITE=true
 *   BROWSER_CARD_INGEST_CONFIRM_DB_WRITES=I_UNDERSTAND
 *
 * Usage:
 *   npm run browser:ingest-cards                                    (dry-run, all *.cards.csv)
 *   set BROWSER_CARDS_FILE=data\imports\foo.cards.csv&& npm run browser:ingest-cards
 *
 * Environment variables:
 *   BROWSER_CARDS_FILE  — single sidecar CSV path (default: all data/imports/*.cards.csv)
 *   BROWSER_DRY_RUN     — 'false' to enable live writes; anything else = dry-run (default: true)
 */

import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

// ─── Constants ──────────────────────────────────────────────────────────────

const IMPORTS_DIR = 'data/imports';
const CARDS_SUFFIX = '.cards.csv';

const EXPECTED_HEADER = [
  'ad_id',
  'card_index',
  'asset_path',
  'media_type',
  'headline',
  'description',
  'cta',
  'display_url',
  'landing_url',
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

type CardCsvRow = {
  ad_id: string;
  card_index: string;
  asset_path: string;
  media_type: string;
  headline: string;
  description: string;
  cta: string;
  display_url: string;
  landing_url: string;
};

/** Normalised, validated card data ready for the DB (nulls, not empty strings). */
type CardData = {
  cardIndex: number;
  assetPath: string | null;
  mediaType: string;
  headline: string | null;
  description: string | null;
  cta: string | null;
  displayUrl: string | null;
  landingUrl: string | null;
};

type Counters = {
  filesScanned: number;
  totalRows: number;
  validRows: number;
  skippedRows: number;   // failed validation (bad ad_id / card_index / media_type)
  missingAdRows: number; // valid row but ad_id not found in Ad table
  create: number;        // would create / created
  update: number;        // would update / updated
  unchanged: number;
  errors: number;        // DB or unexpected errors
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Trim, and convert blank to null (never store empty strings). */
function blankToNull(s: string | undefined | null): string | null {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
}

/** Resolve the list of sidecar CSVs to process. */
function resolveInputFiles(): string[] {
  const override = process.env.BROWSER_CARDS_FILE?.trim();
  if (override) {
    return [path.resolve(override)];
  }
  const dir = path.resolve(IMPORTS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(CARDS_SUFFIX))
    .sort()
    .map((f) => path.join(dir, f));
}

/** True when an existing DB card already matches the incoming data exactly. */
function isUnchanged(
  existing: {
    assetPath: string | null;
    mediaType: string;
    headline: string | null;
    description: string | null;
    cta: string | null;
    displayUrl: string | null;
    landingUrl: string | null;
  },
  next: CardData,
): boolean {
  return (
    existing.assetPath === next.assetPath &&
    existing.mediaType === next.mediaType &&
    existing.headline === next.headline &&
    existing.description === next.description &&
    existing.cta === next.cta &&
    existing.displayUrl === next.displayUrl &&
    existing.landingUrl === next.landingUrl
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const LINE = '═'.repeat(64);
  const DIV = '─'.repeat(64);

  // ── Mode resolution ─────────────────────────────────────────────────────────
  const dryRun = process.env.BROWSER_DRY_RUN !== 'false';
  const writeFlag = process.env.BROWSER_CARD_INGEST_WRITE === 'true';
  const confirmFlag = process.env.BROWSER_CARD_INGEST_CONFIRM_DB_WRITES;
  const liveWrite = !dryRun && writeFlag && confirmFlag === 'I_UNDERSTAND';

  console.log(`\n${LINE}`);
  console.log('  Ad Creative Cards — Sidecar Ingestion (Phase H.3c)');
  console.log(LINE);
  console.log(`  Mode:        ${liveWrite ? '⚠  LIVE WRITE MODE — DB writes ACTIVE' : 'DRY RUN — no DB writes'}`);
  console.log(`  Target:      AdCreativeCard  (unique key: adId + cardIndex)`);
  console.log(LINE);

  // ── Guard: all 3 flags required for live write ────────────────────────────────
  if (!dryRun && !liveWrite) {
    console.error('\n❌ Live write requested but not all 3 confirmation flags are set:');
    console.error(`   BROWSER_DRY_RUN=false                                   ${!dryRun ? '✓' : '✗ not set'}`);
    console.error(`   BROWSER_CARD_INGEST_WRITE=true                          ${writeFlag ? '✓' : '✗ missing or wrong'}`);
    console.error(`   BROWSER_CARD_INGEST_CONFIRM_DB_WRITES=I_UNDERSTAND      ${confirmFlag === 'I_UNDERSTAND' ? '✓' : '✗ missing or wrong'}`);
    console.error('\n   Re-run with all 3 flags, or remove BROWSER_DRY_RUN=false to stay in dry-run.');
    process.exit(1);
  }

  // ── Resolve input files ───────────────────────────────────────────────────────
  const files = resolveInputFiles();
  if (files.length === 0) {
    console.log(`\n  No sidecar CSV files found.`);
    console.log(`  Looked for: ${process.env.BROWSER_CARDS_FILE?.trim() ?? path.join(path.resolve(IMPORTS_DIR), '*' + CARDS_SUFFIX)}`);
    console.log('');
    return;
  }

  console.log(`\n  Files to scan (${files.length}):`);
  for (const f of files) console.log(`    • ${path.relative(process.cwd(), f).replace(/\\/g, '/')}`);

  const counters: Counters = {
    filesScanned: 0,
    totalRows: 0,
    validRows: 0,
    skippedRows: 0,
    missingAdRows: 0,
    create: 0,
    update: 0,
    unchanged: 0,
    errors: 0,
  };

  const prisma = new PrismaClient();

  try {
    for (const file of files) {
      console.log(`\n${DIV}`);
      console.log(`  File: ${path.relative(process.cwd(), file).replace(/\\/g, '/')}`);
      console.log(DIV);

      if (!fs.existsSync(file)) {
        console.log(`  ⚠  File not found — skipping.`);
        continue;
      }
      counters.filesScanned++;

      const content = fs.readFileSync(file, 'utf-8');
      let rows: CardCsvRow[];
      try {
        rows = parse(content, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        }) as CardCsvRow[];
      } catch (err: unknown) {
        counters.errors++;
        console.error(`  ❌ Failed to parse CSV: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (rows.length === 0) {
        console.log('  (no data rows)');
        continue;
      }

      // Validate header
      const actualCols = Object.keys(rows[0]!);
      const missingCols = EXPECTED_HEADER.filter((c) => !actualCols.includes(c));
      if (missingCols.length > 0) {
        counters.errors++;
        console.error(`  ❌ Missing required columns: ${missingCols.join(', ')} — skipping file.`);
        continue;
      }

      counters.totalRows += rows.length;

      // Resolve all distinct ad_ids in this file to Ad.id via metaAdId (one query).
      const metaAdIds = Array.from(
        new Set(rows.map((r) => (r.ad_id ?? '').trim()).filter((v) => v !== '')),
      );
      const ads = metaAdIds.length
        ? await prisma.ad.findMany({
            where: { metaAdId: { in: metaAdIds } },
            select: { id: true, metaAdId: true },
          })
        : [];
      const metaToId = new Map<string, string>();
      for (const a of ads) if (a.metaAdId) metaToId.set(a.metaAdId, a.id);

      for (let i = 0; i < rows.length; i++) {
        const raw = rows[i]!;
        const rowNum = i + 2; // 1-based + header
        const metaAdId = (raw.ad_id ?? '').trim();
        const idxRaw = (raw.card_index ?? '').trim();
        const cardIndex = parseInt(idxRaw, 10);
        const mediaType = (raw.media_type ?? '').trim();

        // ── Validation ──────────────────────────────────────────────────────────
        if (!metaAdId) {
          counters.skippedRows++;
          console.log(`  ○ row ${rowNum}: SKIPPED — blank ad_id`);
          continue;
        }
        if (!Number.isInteger(cardIndex) || cardIndex < 1 || String(cardIndex) !== idxRaw) {
          counters.skippedRows++;
          console.log(`  ○ row ${rowNum} [${metaAdId}]: SKIPPED — invalid card_index "${idxRaw}"`);
          continue;
        }
        if (!mediaType) {
          counters.skippedRows++;
          console.log(`  ○ row ${rowNum} [${metaAdId}]: SKIPPED — blank media_type`);
          continue;
        }
        counters.validRows++;

        // ── Resolve ad_id → Ad.id ────────────────────────────────────────────────
        const adDbId = metaToId.get(metaAdId);
        if (!adDbId) {
          counters.missingAdRows++;
          console.log(`  ⊘ row ${rowNum} [${metaAdId}] card-${String(cardIndex).padStart(2, '0')}: MISSING AD — no Ad with metaAdId="${metaAdId}" (not created, skipped)`);
          continue;
        }

        const next: CardData = {
          cardIndex,
          assetPath: blankToNull(raw.asset_path),
          mediaType,
          headline: blankToNull(raw.headline),
          description: blankToNull(raw.description),
          cta: blankToNull(raw.cta),
          displayUrl: blankToNull(raw.display_url),
          landingUrl: blankToNull(raw.landing_url),
        };

        // ── Read-before-write (idempotent) ───────────────────────────────────────
        try {
          const existing = await prisma.adCreativeCard.findUnique({
            where: { adId_cardIndex: { adId: adDbId, cardIndex } },
            select: {
              assetPath: true, mediaType: true, headline: true, description: true,
              cta: true, displayUrl: true, landingUrl: true,
            },
          });

          const label = `row ${rowNum} [${metaAdId}] card-${String(cardIndex).padStart(2, '0')}`;

          if (!existing) {
            counters.create++;
            if (liveWrite) {
              await prisma.adCreativeCard.create({
                data: {
                  adId: adDbId,
                  cardIndex,
                  assetPath: next.assetPath,
                  mediaType: next.mediaType,
                  headline: next.headline,
                  description: next.description,
                  cta: next.cta,
                  displayUrl: next.displayUrl,
                  landingUrl: next.landingUrl,
                },
              });
              console.log(`  ✓ ${label}: CREATED`);
            } else {
              console.log(`  → ${label}: WOULD CREATE`);
            }
          } else if (isUnchanged(existing, next)) {
            counters.unchanged++;
            console.log(`  · ${label}: unchanged`);
          } else {
            counters.update++;
            if (liveWrite) {
              await prisma.adCreativeCard.update({
                where: { adId_cardIndex: { adId: adDbId, cardIndex } },
                data: {
                  assetPath: next.assetPath,
                  mediaType: next.mediaType,
                  headline: next.headline,
                  description: next.description,
                  cta: next.cta,
                  displayUrl: next.displayUrl,
                  landingUrl: next.landingUrl,
                },
              });
              console.log(`  ✓ ${label}: UPDATED`);
            } else {
              console.log(`  → ${label}: WOULD UPDATE`);
            }
          }
        } catch (err: unknown) {
          counters.errors++;
          console.error(`  ✗ row ${rowNum} [${metaAdId}] card-${cardIndex}: ❌ ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log(`  ${liveWrite ? 'WRITE SUMMARY' : 'DRY RUN SUMMARY'}`);
  console.log(LINE);
  console.log(`  Files scanned:      ${counters.filesScanned}`);
  console.log(`  Total rows:         ${counters.totalRows}`);
  console.log(`  Valid rows:         ${counters.validRows}`);
  console.log(`  Skipped rows:       ${counters.skippedRows}   (bad ad_id / card_index / media_type)`);
  console.log(`  Missing ad rows:    ${counters.missingAdRows}   (ad_id not in Ad table — not created)`);
  console.log(DIV);
  if (liveWrite) {
    console.log(`  Created:            ${counters.create}`);
    console.log(`  Updated:            ${counters.update}`);
    console.log(`  Unchanged:          ${counters.unchanged}`);
    console.log(`  Skipped:            ${counters.skippedRows}`);
    console.log(`  Missing ads:        ${counters.missingAdRows}`);
    console.log(`  Errors:             ${counters.errors}`);
  } else {
    console.log(`  Would create:       ${counters.create}`);
    console.log(`  Would update:       ${counters.update}`);
    console.log(`  Unchanged:          ${counters.unchanged}`);
    console.log(`  Errors:             ${counters.errors}`);
  }
  console.log(LINE);
  console.log('  Only AdCreativeCard is touched. No Ads created, no cards/assets deleted,');
  console.log('  no Ad / AdAnalysis / scoring / preview / UI / schema changes.');
  if (!liveWrite) {
    console.log('  DRY RUN — nothing written. To write, set all 3 flags:');
    console.log('    BROWSER_DRY_RUN=false  BROWSER_CARD_INGEST_WRITE=true  BROWSER_CARD_INGEST_CONFIRM_DB_WRITES=I_UNDERSTAND');
  }
  console.log(`${LINE}\n`);
}

main().catch((err: unknown) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
