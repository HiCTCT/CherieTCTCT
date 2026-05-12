/**
 * Phase 7 — CSV Audit Script
 *
 * Reads a raw competitor CSV, classifies every row, auto-fills extractable
 * Meta Page IDs, and writes 7 sorted output CSVs plus a terminal summary.
 *
 * Read-only: no database, no Prisma, no Meta API calls, no imports.
 *
 * Usage:
 *   npm run import:audit
 *
 * Custom file (Windows):
 *   set AUDIT_IMPORT_FILE=data/imports/other-file.csv&& npm run import:audit
 */

import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_INPUT = 'data/imports/oom-raw-competitors.csv';
const OUTPUT_DIR = 'data/imports';

const IMPORT_COLUMNS = [
  'Client Name',
  'Industry',
  'What They Sell',
  'Competitor Name',
  'Competitor Website',
  'Facebook Page URL',
  'Meta Ad Library URL',
  'Meta Page ID',
  'Notes',
] as const;

const AUDIT_EXTRA_COLUMNS = [
  'Audit Row Number',
  'Audit Category',
  'Audit Issues',
  'Conflicting Rows',
] as const;

// Output file for each category — order determines terminal summary order
const OUTPUT_FILES: Record<AuditCategory, string> = {
  READY_TO_IMPORT_AND_SCAN: 'audit-ready-to-import-and-scan.csv',
  READY_TO_IMPORT_NOT_SCAN_READY: 'audit-ready-to-import-not-scan-ready.csv',
  NEEDS_META_ID_REVIEW: 'audit-needs-meta-id-review.csv',
  NEEDS_FACEBOOK_URL_REVIEW: 'audit-needs-facebook-url-review.csv',
  NEEDS_DUPLICATE_REVIEW: 'audit-needs-duplicate-review.csv',
  BLOCKED_INVALID_REQUIRED_FIELDS: 'audit-blocked-invalid-required-fields.csv',
  BLOCKED_DUPLICATE_WITHIN_CLIENT: 'audit-blocked-duplicates.csv',
};

// Import-ready files use the 9-column format with Notes augmented.
// All other files use the 9-column format + 4 audit columns.
const IMPORT_READY_CATEGORIES = new Set<AuditCategory>([
  'READY_TO_IMPORT_AND_SCAN',
  'READY_TO_IMPORT_NOT_SCAN_READY',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

type AuditCategory =
  | 'READY_TO_IMPORT_AND_SCAN'
  | 'READY_TO_IMPORT_NOT_SCAN_READY'
  | 'NEEDS_META_ID_REVIEW'
  | 'NEEDS_FACEBOOK_URL_REVIEW'
  | 'NEEDS_DUPLICATE_REVIEW'
  | 'BLOCKED_INVALID_REQUIRED_FIELDS'
  | 'BLOCKED_DUPLICATE_WITHIN_CLIENT';

type FacebookUrlQuality =
  | 'blank'
  | 'valid'
  | 'mobile'
  | 'http_only'
  | 'ad_library_url'
  | 'invalid';

type ProcessedRow = {
  rowNumber: number;           // 1-based data index; spreadsheet row = rowNumber + 1
  clientName: string;
  industry: string;
  whatTheySell: string;
  competitorName: string;
  competitorWebsite: string;
  facebookPageUrl: string;
  metaAdLibraryUrl: string;
  metaPageIdRaw: string;       // original column value, untouched
  notes: string;
  // derived
  extractedMetaPageId: string | null;   // from Meta Ad Library URL
  resolvedMetaPageId: string | null;    // column if numeric, else extracted
  facebookUrlQuality: FacebookUrlQuality;
};

type ClassifiedRow = ProcessedRow & {
  category: AuditCategory;
  auditIssues: string[];
  conflictingRows: string[];
};

// ── CSV helpers ───────────────────────────────────────────────────────────────

function escapeField(value: string): string {
  if (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function toCsvLine(fields: string[]): string {
  return fields.map(escapeField).join(',');
}

// ── Field helpers ─────────────────────────────────────────────────────────────

function trimField(v: string | undefined | null): string {
  return (v ?? '').trim();
}

function isNumeric(v: string): boolean {
  return v.length > 0 && /^\d+$/.test(v);
}

function normalizeUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

function extractMetaPageIdFromUrl(url: string): string | null {
  if (!url) return null;
  const match = url.match(/view_all_page_id=(\d+)/);
  return match?.[1] ?? null;
}

// ── Facebook URL classification ───────────────────────────────────────────────

function classifyFacebookUrl(url: string): FacebookUrlQuality {
  if (!url) return 'blank';
  if (/^https?:\/\/m\.facebook\.com\//i.test(url)) return 'mobile';
  if (/\/ads\/library\//i.test(url)) return 'ad_library_url';
  if (/^http:\/\/(www\.)?facebook\.com\//i.test(url)) return 'http_only';
  if (/^https:\/\/(www\.)?facebook\.com\//i.test(url)) return 'valid';
  return 'invalid';
}

function facebookUrlIssueText(quality: FacebookUrlQuality, url: string): string | null {
  switch (quality) {
    case 'mobile':
      return `Facebook URL is a mobile URL (m.facebook.com) — replace with desktop URL: https://www.facebook.com/...`;
    case 'ad_library_url':
      return `Facebook URL is an Ad Library search URL, not a Page URL — find the advertiser's actual Page URL`;
    case 'http_only':
      return `Facebook URL uses HTTP not HTTPS — change to: ${url.replace(/^http:\/\//, 'https://')}`;
    case 'invalid':
      return `Facebook URL is not a valid facebook.com URL — must start with https://facebook.com/ or https://www.facebook.com/`;
    default:
      return null;
  }
}

// ── Duplicate map helpers ─────────────────────────────────────────────────────

function addToMap(map: Map<string, number[]>, key: string, rowNumber: number): void {
  if (!map.has(key)) map.set(key, []);
  map.get(key)!.push(rowNumber);
}

type ConflictEntry = { signal: string; otherRows: number[] };

function buildConflictLookup(
  maps: Array<{ map: Map<string, number[]>; label: string }>,
): Map<number, ConflictEntry[]> {
  const lookup = new Map<number, ConflictEntry[]>();
  for (const { map, label } of maps) {
    for (const rows of map.values()) {
      if (rows.length < 2) continue;
      for (const rowNum of rows) {
        const others = rows.filter((r) => r !== rowNum);
        if (!lookup.has(rowNum)) lookup.set(rowNum, []);
        lookup.get(rowNum)!.push({ signal: label, otherRows: others });
      }
    }
  }
  return lookup;
}

function countDupGroups(map: Map<string, number[]>): number {
  let count = 0;
  for (const rows of map.values()) {
    if (rows.length >= 2) count++;
  }
  return count;
}

// ── CSV writing ───────────────────────────────────────────────────────────────

function writeImportReadyFile(rows: ClassifiedRow[], filePath: string): void {
  const lines: string[] = [toCsvLine([...IMPORT_COLUMNS])];

  for (const row of rows) {
    // Auto-fill Meta Page ID from URL if extraction was needed
    const metaPageId = row.resolvedMetaPageId ?? row.metaPageIdRaw;

    // Augment Notes with audit annotations
    let notes = row.notes;
    if (row.auditIssues.length > 0) {
      const annotation = row.auditIssues.join(' | ');
      notes = notes ? `${notes} | ${annotation}` : annotation;
    }

    lines.push(
      toCsvLine([
        row.clientName,
        row.industry,
        row.whatTheySell,
        row.competitorName,
        row.competitorWebsite,
        row.facebookPageUrl,
        row.metaAdLibraryUrl,
        metaPageId,
        notes,
      ]),
    );
  }

  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

function writeReviewFile(rows: ClassifiedRow[], filePath: string): void {
  const header = [...IMPORT_COLUMNS, ...AUDIT_EXTRA_COLUMNS];
  const lines: string[] = [toCsvLine(header)];

  for (const row of rows) {
    // NEEDS_META_ID_REVIEW: never auto-fill — the conflict must be resolved manually
    const metaPageId =
      row.category === 'NEEDS_META_ID_REVIEW'
        ? row.metaPageIdRaw
        : (row.resolvedMetaPageId ?? row.metaPageIdRaw);

    lines.push(
      toCsvLine([
        row.clientName,
        row.industry,
        row.whatTheySell,
        row.competitorName,
        row.competitorWebsite,
        row.facebookPageUrl,
        row.metaAdLibraryUrl,
        metaPageId,
        row.notes,
        // Audit columns
        String(row.rowNumber + 1),  // +1 = spreadsheet row number (header is row 1)
        row.category,
        row.auditIssues.join(' | '),
        row.conflictingRows.join(' | '),
      ]),
    );
  }

  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  // ── Resolve input path ───────────────────────────────────────────────────────
  const inputPath = path.resolve(process.env.AUDIT_IMPORT_FILE ?? DEFAULT_INPUT);

  if (!fs.existsSync(inputPath)) {
    console.error(`\n❌ Input file not found: ${inputPath}`);
    console.error(`   Default: ${path.resolve(DEFAULT_INPUT)}`);
    console.error(`   Override: set AUDIT_IMPORT_FILE=data/imports/your-file.csv`);
    process.exit(1);
  }

  const LINE = '═══════════════════════════════════════════════════════════════';
  const DIV  = '───────────────────────────────────────────────────────────────';

  console.log(`\n${LINE}`);
  console.log('  Phase 7 — CSV Audit');
  console.log(LINE);
  console.log(`  Input:  ${inputPath}`);
  console.log('  Mode:   read-only — no database, no imports, no Meta API calls');

  // ── Parse CSV ────────────────────────────────────────────────────────────────
  const content = fs.readFileSync(inputPath, 'utf-8');
  const rawRows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  if (rawRows.length === 0) {
    console.error('\n❌ Input file is empty or contains only a header row.');
    process.exit(1);
  }

  // ── Validate header ──────────────────────────────────────────────────────────
  const actualColumns = Object.keys(rawRows[0]!);
  const missingColumns = IMPORT_COLUMNS.filter((c) => !actualColumns.includes(c));
  if (missingColumns.length > 0) {
    console.error(`\n❌ Missing required columns: ${missingColumns.join(', ')}`);
    console.error(`   Expected columns: ${IMPORT_COLUMNS.join(', ')}`);
    process.exit(1);
  }

  console.log(`  Rows:   ${rawRows.length}`);

  // ── Pass 1: Parse and derive fields ──────────────────────────────────────────
  const processed: ProcessedRow[] = rawRows.map((raw, index) => {
    const metaPageIdRaw   = trimField(raw['Meta Page ID']);
    const metaAdLibraryUrl = trimField(raw['Meta Ad Library URL']);
    const facebookPageUrl  = trimField(raw['Facebook Page URL']);

    const extractedMetaPageId = extractMetaPageIdFromUrl(metaAdLibraryUrl);

    let resolvedMetaPageId: string | null = null;
    if (isNumeric(metaPageIdRaw)) {
      resolvedMetaPageId = metaPageIdRaw;
    } else if (!metaPageIdRaw && extractedMetaPageId) {
      resolvedMetaPageId = extractedMetaPageId;
    }
    // Non-numeric metaPageIdRaw → resolvedMetaPageId stays null

    return {
      rowNumber: index + 1,
      clientName:      trimField(raw['Client Name']),
      industry:        trimField(raw['Industry']),
      whatTheySell:    trimField(raw['What They Sell']),
      competitorName:  trimField(raw['Competitor Name']),
      competitorWebsite: trimField(raw['Competitor Website']),
      facebookPageUrl,
      metaAdLibraryUrl,
      metaPageIdRaw,
      notes:           trimField(raw['Notes']),
      extractedMetaPageId,
      resolvedMetaPageId,
      facebookUrlQuality: classifyFacebookUrl(facebookPageUrl),
    };
  });

  // ── Pass 2: Build duplicate detection maps ────────────────────────────────────
  // Only rows with valid required fields participate in duplicate detection.

  // Hard duplicate signals → BLOCKED_DUPLICATE_WITHIN_CLIENT
  const byClientCompetitorName = new Map<string, number[]>();
  const byClientFacebookUrl    = new Map<string, number[]>();
  const byClientMetaPageId     = new Map<string, number[]>();

  // Soft duplicate signals → NEEDS_DUPLICATE_REVIEW
  const byClientWebsite = new Map<string, number[]>();

  for (const row of processed) {
    if (!row.clientName || !row.industry) continue;
    const clientKey = row.clientName.toLowerCase();

    if (row.competitorName) {
      addToMap(
        byClientCompetitorName,
        `${clientKey}::${row.competitorName.toLowerCase()}`,
        row.rowNumber,
      );
    }

    if (row.facebookPageUrl) {
      addToMap(
        byClientFacebookUrl,
        `${clientKey}::${normalizeUrl(row.facebookPageUrl)}`,
        row.rowNumber,
      );
    }

    if (row.resolvedMetaPageId) {
      addToMap(
        byClientMetaPageId,
        `${clientKey}::${row.resolvedMetaPageId}`,
        row.rowNumber,
      );
    }

    if (row.competitorWebsite) {
      addToMap(
        byClientWebsite,
        `${clientKey}::${normalizeUrl(row.competitorWebsite)}`,
        row.rowNumber,
      );
    }
  }

  const hardConflicts = buildConflictLookup([
    { map: byClientCompetitorName, label: 'same client + same competitor name' },
    { map: byClientFacebookUrl,    label: 'same client + same Facebook URL' },
    { map: byClientMetaPageId,     label: 'same client + same Meta Page ID' },
  ]);

  const softConflicts = buildConflictLookup([
    { map: byClientWebsite, label: 'same client + same competitor website' },
  ]);

  // ── Pass 3: Classify every row ────────────────────────────────────────────────

  // Helper: build a human-readable conflict row description
  function describeConflictRow(otherRowNumber: number): string {
    const other = processed.find((r) => r.rowNumber === otherRowNumber);
    const label = other?.competitorName
      ? `"${other.competitorName}"`
      : '(no competitor name)';
    return `Row ${otherRowNumber + 1} ${label}`;
  }

  const classified: ClassifiedRow[] = processed.map((row) => {
    const auditIssues: string[] = [];
    const conflictingRows: string[] = [];

    // ── Priority 1: BLOCKED_INVALID_REQUIRED_FIELDS ───────────────────────────
    if (!row.clientName) auditIssues.push('Client Name is blank');
    if (!row.industry)   auditIssues.push('Industry is blank');
    if (!row.clientName || !row.industry) {
      return { ...row, category: 'BLOCKED_INVALID_REQUIRED_FIELDS', auditIssues, conflictingRows };
    }

    // ── Priority 2: BLOCKED_DUPLICATE_WITHIN_CLIENT ───────────────────────────
    const hardList = hardConflicts.get(row.rowNumber);
    if (hardList && hardList.length > 0) {
      for (const conflict of hardList) {
        auditIssues.push(`Duplicate: ${conflict.signal}`);
        for (const other of conflict.otherRows) {
          conflictingRows.push(describeConflictRow(other));
        }
      }
      return { ...row, category: 'BLOCKED_DUPLICATE_WITHIN_CLIENT', auditIssues, conflictingRows };
    }

    // ── Priority 3: NEEDS_META_ID_REVIEW ──────────────────────────────────────
    // Triggered only when column value and URL-extracted value are both present and differ
    if (
      isNumeric(row.metaPageIdRaw) &&
      row.extractedMetaPageId &&
      row.metaPageIdRaw !== row.extractedMetaPageId
    ) {
      auditIssues.push(
        `Meta Page ID conflict — column: ${row.metaPageIdRaw}, URL: ${row.extractedMetaPageId}. Verify which is correct.`,
      );
      return { ...row, category: 'NEEDS_META_ID_REVIEW', auditIssues, conflictingRows };
    }

    // ── Priority 4: NEEDS_FACEBOOK_URL_REVIEW ─────────────────────────────────
    if (row.facebookUrlQuality !== 'blank' && row.facebookUrlQuality !== 'valid') {
      const msg = facebookUrlIssueText(row.facebookUrlQuality, row.facebookPageUrl);
      if (msg) auditIssues.push(msg);
      return { ...row, category: 'NEEDS_FACEBOOK_URL_REVIEW', auditIssues, conflictingRows };
    }

    // ── Priority 5: NEEDS_DUPLICATE_REVIEW ────────────────────────────────────
    const softList = softConflicts.get(row.rowNumber);
    if (softList && softList.length > 0) {
      for (const conflict of softList) {
        auditIssues.push(`Possible duplicate: ${conflict.signal}`);
        for (const other of conflict.otherRows) {
          conflictingRows.push(describeConflictRow(other));
        }
      }
      return { ...row, category: 'NEEDS_DUPLICATE_REVIEW', auditIssues, conflictingRows };
    }

    // ── Priority 6: READY_TO_IMPORT_NOT_SCAN_READY ────────────────────────────
    if (!row.resolvedMetaPageId) {
      if (row.metaPageIdRaw && !isNumeric(row.metaPageIdRaw)) {
        auditIssues.push(
          `Meta Page ID "${row.metaPageIdRaw}" is not numeric — must be digits only`,
        );
      }
      if (!row.competitorName) {
        auditIssues.push('Client-only row — no competitor name');
      }
      return { ...row, category: 'READY_TO_IMPORT_NOT_SCAN_READY', auditIssues, conflictingRows };
    }

    // ── Priority 7: READY_TO_IMPORT_AND_SCAN ──────────────────────────────────
    // Annotate Notes only when Meta Page ID was extracted (not already in column)
    if (!row.metaPageIdRaw && row.extractedMetaPageId) {
      auditIssues.push(
        `AUDIT: Meta Page ID auto-filled from URL: ${row.resolvedMetaPageId}`,
      );
    }
    return { ...row, category: 'READY_TO_IMPORT_AND_SCAN', auditIssues, conflictingRows };
  });

  // ── Group by category ────────────────────────────────────────────────────────
  const byCategory = new Map<AuditCategory, ClassifiedRow[]>(
    (Object.keys(OUTPUT_FILES) as AuditCategory[]).map((cat) => [cat, []]),
  );
  for (const row of classified) {
    byCategory.get(row.category)!.push(row);
  }

  // ── Ensure output directory exists ───────────────────────────────────────────
  const resolvedOutputDir = path.resolve(OUTPUT_DIR);
  if (!fs.existsSync(resolvedOutputDir)) {
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
  }

  // ── Write output files ────────────────────────────────────────────────────────
  const writtenFiles: string[] = [];
  for (const [category, filename] of Object.entries(OUTPUT_FILES) as [AuditCategory, string][]) {
    const rows = byCategory.get(category)!;
    const filePath = path.join(resolvedOutputDir, filename);
    if (IMPORT_READY_CATEGORIES.has(category)) {
      writeImportReadyFile(rows, filePath);
    } else {
      writeReviewFile(rows, filePath);
    }
    writtenFiles.push(filePath);
  }

  // ── Compute summary stats ─────────────────────────────────────────────────────
  const totalRows = processed.length;
  const withMetaIdColumn    = processed.filter((r) => isNumeric(r.metaPageIdRaw)).length;
  const withExtractedMetaId = processed.filter((r) => !r.metaPageIdRaw && !!r.extractedMetaPageId).length;
  const totalUsableMetaId   = processed.filter((r) => !!r.resolvedMetaPageId).length;
  const noMetaId            = totalRows - totalUsableMetaId;

  const fbBlank      = processed.filter((r) => r.facebookUrlQuality === 'blank').length;
  const fbValid      = processed.filter((r) => r.facebookUrlQuality === 'valid').length;
  const fbMobile     = processed.filter((r) => r.facebookUrlQuality === 'mobile').length;
  const fbHttpOnly   = processed.filter((r) => r.facebookUrlQuality === 'http_only').length;
  const fbAdLibrary  = processed.filter((r) => r.facebookUrlQuality === 'ad_library_url').length;
  const fbInvalid    = processed.filter((r) => r.facebookUrlQuality === 'invalid').length;

  const dupNameGroups  = countDupGroups(byClientCompetitorName);
  const dupMetaGroups  = countDupGroups(byClientMetaPageId);
  const dupFbGroups    = countDupGroups(byClientFacebookUrl);
  const dupSiteGroups  = countDupGroups(byClientWebsite);

  function pad(n: number, w = 6): string { return String(n).padStart(w); }
  function padl(s: string, w = 44): string { return s.padEnd(w); }

  // ── Print terminal summary ────────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log(`  CSV Audit — ${path.basename(inputPath)}`);
  console.log(LINE);
  console.log(`  ${padl('Total rows read:')}${pad(totalRows)}`);

  console.log(`\n  ${DIV}`);
  console.log('  Classification');
  console.log(`  ${DIV}`);
  for (const [cat, filename] of Object.entries(OUTPUT_FILES) as [AuditCategory, string][]) {
    const count = byCategory.get(cat)!.length;
    console.log(`  ${padl(cat)}${pad(count)}`);
  }

  console.log(`\n  ${DIV}`);
  console.log('  Meta Page ID coverage');
  console.log(`  ${DIV}`);
  console.log(`  ${padl('With Meta Page ID (column):')}${pad(withMetaIdColumn)}`);
  console.log(`  ${padl('With Meta Page ID (extracted from URL):')}${pad(withExtractedMetaId)}`);
  console.log(`  ${padl('Total usable Meta Page IDs:')}${pad(totalUsableMetaId)}`);
  console.log(`  ${padl('No usable Meta Page ID:')}${pad(noMetaId)}`);

  console.log(`\n  ${DIV}`);
  console.log('  Facebook URL coverage');
  console.log(`  ${DIV}`);
  console.log(`  ${padl('Blank:')}${pad(fbBlank)}`);
  console.log(`  ${padl('Valid:')}${pad(fbValid)}`);
  console.log(`  ${padl('Mobile (m.facebook.com):')}${pad(fbMobile)}`);
  console.log(`  ${padl('HTTP only (not HTTPS):')}${pad(fbHttpOnly)}`);
  console.log(`  ${padl('Ad Library URL (not a page URL):')}${pad(fbAdLibrary)}`);
  console.log(`  ${padl('Invalid:')}${pad(fbInvalid)}`);

  console.log(`\n  ${DIV}`);
  console.log('  Duplicate signals');
  console.log(`  ${DIV}`);
  console.log(`  ${padl('Same client + same competitor name:')}${pad(dupNameGroups)}  groups  [hard]`);
  console.log(`  ${padl('Same client + same Meta Page ID:')}${pad(dupMetaGroups)}  groups  [hard]`);
  console.log(`  ${padl('Same client + same Facebook URL:')}${pad(dupFbGroups)}  groups  [hard]`);
  console.log(`  ${padl('Same client + same website:')}${pad(dupSiteGroups)}  groups  [soft]`);

  console.log(`\n  ${DIV}`);
  console.log('  Output files written');
  console.log(`  ${DIV}`);
  for (const [cat, filename] of Object.entries(OUTPUT_FILES) as [AuditCategory, string][]) {
    const count = byCategory.get(cat)!.length;
    const rowLabel = count === 1 ? 'row ' : 'rows';
    console.log(`  ${filename.padEnd(50)} ${pad(count)} ${rowLabel}`);
  }
  console.log(LINE);
  console.log('');
}

main();
