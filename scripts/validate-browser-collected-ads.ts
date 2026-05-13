/**
 * Browser-Collected Ads — QA and Normalisation Preview Script
 *
 * Reads a browser-collected ads CSV, validates READY rows, and maps them
 * into a MetaAdRecord-like shape for inspection.
 *
 * DRY RUN ONLY — no database writes, no scoring, no ingestion.
 *
 * Usage:
 *   npm run browser:validate
 *
 * Override input file:
 *   set BROWSER_ADS_FILE=data/imports/my-other-file.csv&& npm run browser:validate
 *
 * Expected header:
 *   collection_status,competitor_name,meta_page_id,ad_id,ad_library_url,
 *   media_type,publisher_platforms,ad_delivery_start_time,ad_copy,headline,
 *   description,landing_page_url,notes,visual_description,creative_notes
 *
 * Optional analyst-context columns (warn if blank, never error):
 *   visual_description  — maps to Creative Analysis in analyseAdRow()
 *   creative_notes      — maps to Analysis in analyseAdRow()
 */

import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

type CollectionStatus = 'READY' | 'NEEDS_REVIEW' | 'SKIP' | string;
type BrowserMediaType = 'IMAGE' | 'VIDEO' | 'CAROUSEL' | 'UNKNOWN' | string;
type AnalysisFormat = 'STATIC' | 'VIDEO' | 'NEEDS_REVIEW';

/** Raw parsed row from the browser-collected CSV. */
type BrowserAdRow = {
  collection_status: CollectionStatus;
  competitor_name: string;
  meta_page_id: string;
  ad_id: string;
  ad_library_url: string;
  media_type: BrowserMediaType;
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
};

/**
 * MetaAdRecord-like shape produced by normalisation.
 * Mirrors lib/providers/meta/types.ts MetaAdRecord exactly,
 * plus two diagnostic-only fields not stored in the DB.
 */
type NormalisedAdRecord = {
  // Core MetaAdRecord fields
  id: string;
  page_id: string;
  page_name: string;
  ad_snapshot_url: string;
  ad_delivery_start_time: string;
  ad_delivery_stop_time: null;
  ad_creation_time: undefined;
  publisher_platforms: string[];
  ad_creative_bodies: string[];
  ad_creative_link_titles: string[];
  ad_creative_link_descriptions: string[];
  // Diagnostic-only fields (not in MetaAdRecord — printed only, never stored)
  _browser_media_type: BrowserMediaType;
  _planned_format: AnalysisFormat;
  _landing_page_url: string;
};

type ValidationError = {
  rowNumber: number;
  adId: string;
  field: string;
  message: string;
  severity: 'ERROR' | 'WARN';
};

type ValidatedRow = {
  rowNumber: number;
  raw: BrowserAdRow;
  record: NormalisedAdRecord;
  errors: ValidationError[];
  warnings: ValidationError[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

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

const VALID_MEDIA_TYPES: BrowserMediaType[] = ['IMAGE', 'VIDEO', 'CAROUSEL', 'UNKNOWN'];
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC_REGEX = /^\d+$/;
const AD_LIBRARY_PREFIX = 'https://www.facebook.com/ads/library/?id=';
const DEFAULT_FILE = 'data/imports/castlery-browser-collected-ads-pilot-01.csv';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function truncate(str: string, max: number): string {
  if (!str) return '(empty)';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function extractDomain(url: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
}

function deriveFormat(mediaType: BrowserMediaType): AnalysisFormat {
  if (mediaType === 'IMAGE' || mediaType === 'CAROUSEL') return 'STATIC';
  if (mediaType === 'VIDEO') return 'VIDEO';
  return 'NEEDS_REVIEW';
}

/**
 * Detects comment-contaminated ad_copy (e.g. UGC comment dumps captured by the browser).
 * Conservative patterns only — false negatives are preferred over false positives.
 *
 * Flags as contaminated when:
 *  1. Copy starts with a separator character: ; | ,
 *  2. Copy contains 3+ semicolon-separated segments that are all short (avg < 120 chars)
 *
 * Returns cleanedCopy (undefined if entire content is contaminated) and a wasContaminated flag.
 * Does NOT modify or truncate partial contamination — if flagged, the whole field is discarded.
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

// ─── Validation ───────────────────────────────────────────────────────────────

function validateReadyRow(
  row: BrowserAdRow,
  rowNumber: number,
): ValidationError[] {
  const issues: ValidationError[] = [];

  const err = (field: string, message: string): ValidationError => ({
    rowNumber,
    adId: row.ad_id || '(no ad_id)',
    field,
    message,
    severity: 'ERROR',
  });

  const warn = (field: string, message: string): ValidationError => ({
    rowNumber,
    adId: row.ad_id || '(no ad_id)',
    field,
    message,
    severity: 'WARN',
  });

  // competitor_name
  if (!row.competitor_name.trim()) {
    issues.push(err('competitor_name', 'Must be non-empty'));
  }

  // meta_page_id
  if (!NUMERIC_REGEX.test(row.meta_page_id.trim())) {
    issues.push(err('meta_page_id', `Must be numeric — got: "${row.meta_page_id}"`));
  }

  // ad_id
  const adId = row.ad_id.trim();
  if (!NUMERIC_REGEX.test(adId)) {
    issues.push(err('ad_id', `Must be numeric — got: "${row.ad_id}"`));
  }

  // ad_library_url — prefix check
  const adUrl = row.ad_library_url.trim();
  if (!adUrl.startsWith(AD_LIBRARY_PREFIX)) {
    issues.push(
      err('ad_library_url', `Must start with "${AD_LIBRARY_PREFIX}" — got: "${adUrl.slice(0, 60)}"`),
    );
  } else {
    // ad_id must match id= in URL
    const urlId = adUrl.slice(AD_LIBRARY_PREFIX.length).split('&')[0];
    if (adId && urlId !== adId) {
      issues.push(
        err('ad_library_url', `ad_id (${adId}) does not match id= in URL (${urlId})`),
      );
    }
  }

  // ad_library_url — no access token
  if (/access_token=/i.test(adUrl)) {
    issues.push(err('ad_library_url', 'URL contains access_token= — remove before storing'));
  }

  // media_type
  const mt = row.media_type.trim().toUpperCase();
  if (!VALID_MEDIA_TYPES.includes(mt)) {
    issues.push(
      err('media_type', `Must be IMAGE, VIDEO, CAROUSEL, or UNKNOWN — got: "${row.media_type}"`),
    );
  }
  if (mt === 'UNKNOWN') {
    issues.push(
      warn('media_type', 'UNKNOWN media_type will be flagged as NEEDS_REVIEW for format derivation'),
    );
  }

  // ad_delivery_start_time
  const dateVal = row.ad_delivery_start_time.trim();
  if (dateVal && !DATE_REGEX.test(dateVal)) {
    issues.push(
      err('ad_delivery_start_time', `Must be YYYY-MM-DD — got: "${dateVal}"`),
    );
  }
  if (!dateVal) {
    issues.push(warn('ad_delivery_start_time', 'Date is empty — activeSince will be null in DB'));
  }

  // ad_copy OR headline must be non-empty
  if (!row.ad_copy.trim() && !row.headline.trim()) {
    issues.push(err('ad_copy/headline', 'At least one of ad_copy or headline must be non-empty'));
  }

  // Warn when ad_copy appears comment-contaminated (leading separator or short semicolon-separated segments)
  if (row.ad_copy.trim()) {
    const { wasContaminated } = cleanAdCopy(row.ad_copy);
    if (wasContaminated) {
      issues.push(
        warn(
          'ad_copy',
          `ad_copy appears comment-contaminated — starts with a separator character or contains multiple short semicolon-separated segments. ` +
            `Raw: "${truncate(row.ad_copy.trim(), 60)}". ` +
            `Copy field will be excluded from scorer input during preview and ingestion.`,
        ),
      );
    }
  }

  // landing_page_url — optional but if present must be http/https
  const lpUrl = row.landing_page_url.trim();
  if (lpUrl && !lpUrl.startsWith('http://') && !lpUrl.startsWith('https://')) {
    issues.push(
      warn('landing_page_url', `Expected http:// or https:// — got: "${lpUrl.slice(0, 40)}"`),
    );
  }

  // visual_description — optional but recommended (maps to Creative Analysis in scorer)
  if (!row.visual_description?.trim()) {
    issues.push(
      warn('visual_description', 'Empty — scorer will use baseline creativeScore (~2.0). Add a brief visual description for meaningful scoring.'),
    );
  }

  // creative_notes — optional but recommended (maps to Analysis in scorer)
  if (!row.creative_notes?.trim()) {
    issues.push(
      warn('creative_notes', 'Empty — scorer will miss funnel stage, triggers, and AIDA signals. Add brief analyst notes for meaningful scoring.'),
    );
  }

  return issues;
}

// ─── Normalisation ────────────────────────────────────────────────────────────

function normaliseRow(row: BrowserAdRow): NormalisedAdRecord {
  const mt = row.media_type.trim().toUpperCase() as BrowserMediaType;
  const platforms = row.publisher_platforms
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  return {
    id: row.ad_id.trim(),
    page_id: row.meta_page_id.trim(),
    page_name: row.competitor_name.trim(),
    ad_snapshot_url: row.ad_library_url.trim(),
    ad_delivery_start_time: row.ad_delivery_start_time.trim(),
    ad_delivery_stop_time: null,
    ad_creation_time: undefined,
    publisher_platforms: platforms,
    ad_creative_bodies: row.ad_copy.trim() ? [row.ad_copy.trim()] : [],
    ad_creative_link_titles: row.headline.trim() ? [row.headline.trim()] : [],
    ad_creative_link_descriptions: row.description.trim() ? [row.description.trim()] : [],
    // Diagnostic-only fields
    _browser_media_type: mt,
    _planned_format: deriveFormat(mt),
    _landing_page_url: row.landing_page_url.trim(),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const LINE  = '═'.repeat(63);
  const DIV   = '─'.repeat(63);

  // ── Resolve file path ────────────────────────────────────────────────────────
  const filePath = path.resolve(process.env.BROWSER_ADS_FILE ?? DEFAULT_FILE);

  console.log(`\n${LINE}`);
  console.log('  Browser-Collected Ads — QA and Normalisation Preview');
  console.log(LINE);
  console.log(`  Mode:       DRY RUN ONLY`);
  console.log(`  File:       ${filePath}`);
  console.log(`  DB writes:  0`);
  console.log(`  Scoring:    none`);
  console.log(`  Ingestion:  none`);
  console.log(LINE);

  // ── Read file ────────────────────────────────────────────────────────────────
  if (!fs.existsSync(filePath)) {
    console.error(`\n❌ File not found: ${filePath}`);
    console.error('   Set BROWSER_ADS_FILE to override the default path.');
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  // ── Parse CSV ────────────────────────────────────────────────────────────────
  const rawRows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: false,
    relax_column_count: false,
  }) as Record<string, string>[];

  if (rawRows.length === 0) {
    console.error('\n❌ CSV has no data rows.');
    process.exit(1);
  }

  // ── Validate header ──────────────────────────────────────────────────────────
  const actualCols = Object.keys(rawRows[0]!);
  const missingCols = EXPECTED_HEADER.filter((c) => !actualCols.includes(c));
  const extraCols   = actualCols.filter((c) => !(EXPECTED_HEADER as readonly string[]).includes(c));

  if (missingCols.length > 0) {
    console.error(`\n❌ Missing required columns: ${missingCols.join(', ')}`);
    process.exit(1);
  }
  if (extraCols.length > 0) {
    // visual_description and creative_notes are now expected — only flag truly unknown extras
    console.log(`\n  ⚠  Unknown extra columns (ignored): ${extraCols.join(', ')}`);
  }

  // ── Bucket rows by status ────────────────────────────────────────────────────
  let readyCount       = 0;
  let needsReviewCount = 0;
  let skipCount        = 0;
  let otherCount       = 0;

  const readyRows: Array<{ row: BrowserAdRow; rowNumber: number }> = [];

  rawRows.forEach((raw, idx) => {
    const row = raw as unknown as BrowserAdRow;
    const status = (row.collection_status ?? '').trim().toUpperCase();
    const rowNumber = idx + 2; // +2: 1-based + header row

    if (status === 'READY') {
      readyCount++;
      readyRows.push({ row, rowNumber });
    } else if (status === 'NEEDS_REVIEW') {
      needsReviewCount++;
    } else if (status === 'SKIP') {
      skipCount++;
    } else {
      otherCount++;
    }
  });

  console.log(`\n${DIV}`);
  console.log('  Row Summary');
  console.log(DIV);
  console.log(`  Total rows read:   ${rawRows.length}`);
  console.log(`  READY:             ${readyCount}`);
  console.log(`  NEEDS_REVIEW:      ${needsReviewCount}  (skipped — not validated)`);
  console.log(`  SKIP:              ${skipCount}  (skipped — not validated)`);
  if (otherCount > 0) {
    console.log(`  Other/unknown:     ${otherCount}  (skipped)`);
  }

  if (readyCount === 0) {
    console.log('\n  ⚠  No READY rows found. Nothing to validate.');
    console.log(`\n${LINE}`);
    printSafetyFooter();
    return;
  }

  // ── Validate and normalise READY rows ────────────────────────────────────────
  const validated: ValidatedRow[] = [];

  for (const { row, rowNumber } of readyRows) {
    const issues   = validateReadyRow(row, rowNumber);
    const errors   = issues.filter((i) => i.severity === 'ERROR');
    const warnings = issues.filter((i) => i.severity === 'WARN');
    const record   = normaliseRow(row);
    validated.push({ rowNumber, raw: row, record, errors, warnings });
  }

  const totalErrors   = validated.reduce((n, v) => n + v.errors.length, 0);
  const totalWarnings = validated.reduce((n, v) => n + v.warnings.length, 0);

  // ── Format breakdown ─────────────────────────────────────────────────────────
  const staticCount      = validated.filter((v) => v.record._planned_format === 'STATIC').length;
  const videoCount       = validated.filter((v) => v.record._planned_format === 'VIDEO').length;
  const needsFormatReview = validated.filter((v) => v.record._planned_format === 'NEEDS_REVIEW').length;

  console.log(`\n${DIV}`);
  console.log('  Format Breakdown (READY rows only)');
  console.log(DIV);
  console.log(`  STATIC (IMAGE + CAROUSEL):  ${staticCount}`);
  console.log(`  VIDEO:                      ${videoCount}`);
  console.log(`  NEEDS_REVIEW (UNKNOWN):     ${needsFormatReview}`);

  // ── Per-row detail ────────────────────────────────────────────────────────────
  console.log(`\n${DIV}`);
  console.log('  READY Row Details');
  console.log(DIV);

  for (const v of validated) {
    const { rowNumber, record, errors, warnings } = v;
    const statusIcon = errors.length > 0 ? '✗' : warnings.length > 0 ? '⚠' : '✓';
    const domain = extractDomain(record._landing_page_url);

    console.log(`\n  ${statusIcon} Row ${rowNumber}  ad_id=${record.id}`);
    console.log(`    media_type:    ${record._browser_media_type}  →  format: ${record._planned_format}`);
    console.log(`    page_name:     ${record.page_name}`);
    console.log(`    page_id:       ${record.page_id}`);
    console.log(`    started:       ${record.ad_delivery_start_time || '(empty)'}`);
    console.log(`    platforms:     ${record.publisher_platforms.join(', ') || '(empty)'}`);
    console.log(`    copy:          ${truncate(record.ad_creative_bodies[0] ?? '', 80)}`);
    console.log(`    headline:      ${truncate(record.ad_creative_link_titles[0] ?? '', 80)}`);
    console.log(`    description:   ${truncate(record.ad_creative_link_descriptions[0] ?? '', 80)}`);
    console.log(`    landing page:  ${domain || '(none)'}`);
    console.log(`    visual_desc:   ${truncate(v.raw.visual_description ?? '', 80)}`);
    console.log(`    creative_notes:${truncate(v.raw.creative_notes ?? '', 80)}`);

    if (errors.length > 0) {
      for (const e of errors) {
        console.log(`    ❌ ERROR [${e.field}]: ${e.message}`);
      }
    }
    if (warnings.length > 0) {
      for (const w of warnings) {
        console.log(`    ⚠  WARN  [${w.field}]: ${w.message}`);
      }
    }
  }

  // ── Validation error list ─────────────────────────────────────────────────────
  if (totalErrors > 0) {
    console.log(`\n${DIV}`);
    console.log(`  ❌ Validation Errors (${totalErrors} total)`);
    console.log(DIV);
    for (const v of validated) {
      for (const e of v.errors) {
        console.log(`  Row ${e.rowNumber}  [${e.field}]  ${e.message}`);
      }
    }
  }

  if (totalWarnings > 0) {
    console.log(`\n${DIV}`);
    console.log(`  ⚠  Warnings (${totalWarnings} total — will not block ingestion)`);
    console.log(DIV);
    for (const v of validated) {
      for (const w of v.warnings) {
        console.log(`  Row ${w.rowNumber}  [${w.field}]  ${w.message}`);
      }
    }
  }

  // ── Final verdict ────────────────────────────────────────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  FINAL VERDICT');
  console.log(LINE);

  if (totalErrors === 0) {
    console.log(`\n  ✓ PASS`);
    console.log(`    ${readyCount} READY row(s) validated with 0 errors.`);
    if (totalWarnings > 0) {
      console.log(`    ${totalWarnings} warning(s) noted — review before live ingestion but will not block.`);
    }
    console.log(`    Browser-collected CSV is ready for next dry-run planning.`);
    console.log(`    Next step: build ingest-browser-collected-ads.ts with META_DRY_RUN=true support.`);
  } else {
    console.log(`\n  ✗ FAIL`);
    console.log(`    ${totalErrors} validation error(s) found across ${readyCount} READY row(s).`);
    console.log(`    Fix the CSV before proceeding to ingestion dry-run.`);
  }

  console.log('');
  printSafetyFooter();
}

function printSafetyFooter(): void {
  const LINE = '═'.repeat(63);
  console.log(LINE);
  console.log('  Safety confirmation');
  console.log(LINE);
  console.log('  No database writes were performed.');
  console.log('  No scoring was performed.');
  console.log('  No ingestion was performed.');
  console.log('  data/imports/*.csv remains uncommitted by design.');
  console.log(LINE);
  console.log('');
}

main();
