/**
 * Phase 7 — Import Batch Selection Script
 *
 * Reads data/imports/audit-ready-to-import-and-scan.csv (or BATCH_SOURCE_FILE
 * override) and either:
 *
 *   (a) Prints a row-count-per-client summary when BATCH_CLIENTS is not set.
 *   (b) Filters to the specified clients and writes
 *       data/imports/audit-ready-batch-01.csv when BATCH_CLIENTS is set.
 *
 * Read-only when BATCH_CLIENTS is not set. Writes one output file when it is.
 * No database, no Prisma, no Meta API calls, no imports.
 *
 * Usage — summary mode (no output file written):
 *   npm run import:select-batch
 *
 * Usage — batch selection mode (Windows):
 *   set BATCH_CLIENTS=Client A,Client B,Client C&& npm run import:select-batch
 *
 * Optional overrides:
 *   BATCH_SOURCE_FILE   Path to source CSV (default: data/imports/audit-ready-to-import-and-scan.csv)
 *   BATCH_OUTPUT_FILE   Path to output CSV (default: data/imports/audit-ready-batch-01.csv)
 *   BATCH_MAX_ROWS      Warn threshold for batch size (default: 200)
 */

import { parse } from 'csv-parse/sync';
import * as fs from 'fs';
import * as path from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_SOURCE = 'data/imports/audit-ready-to-import-and-scan.csv';
const DEFAULT_OUTPUT = 'data/imports/audit-ready-batch-01.csv';
const DEFAULT_MAX_ROWS = 200;

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

// Mojibake patterns that indicate UTF-8 bytes decoded as Latin-1 / Windows-1252
const MOJIBAKE_PATTERNS: Array<{ pattern: RegExp; hint: string }> = [
  { pattern: /\xc3[\x80-\xbf]/,  hint: 'UTF-8 two-byte sequence (0xC3 + continuation) decoded as Latin-1 — likely mangled accented character' },
  { pattern: /\xe2\x80/,         hint: '0xE2 0x80 sequence — likely corrupted smart quote or dash (e.g. ’ or —)' },
  { pattern: /\xc2[\x80-\xbf]/,  hint: 'UTF-8 two-byte sequence (0xC2 + continuation) decoded as Latin-1 — likely corrupted symbol or non-breaking space' },
  { pattern: /\xef\xbf\xbd/,     hint: 'UTF-8 replacement character (U+FFFD) — data contained undecodable bytes' },
];

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

// ── Name normalisation (for variant detection only) ───────────────────────────

function normaliseClientName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(pte\.?\s*ltd\.?|sdn\.?\s*bhd\.?|ltd\.?|inc\.?|corp\.?|llc\.?|co\.?)\b/g, '')
    .replace(/\b(singapore|sg|asia|global|international|intl)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Mojibake detection ────────────────────────────────────────────────────────

type MojibakeWarning = {
  rowNumber: number;
  field: string;
  value: string;
  hint: string;
};

function detectMojibake(value: string, rowNumber: number, field: string): MojibakeWarning[] {
  const warnings: MojibakeWarning[] = [];
  for (const { pattern, hint } of MOJIBAKE_PATTERNS) {
    if (pattern.test(value)) {
      warnings.push({ rowNumber, field, value, hint });
      break; // one warning per field per row is enough
    }
  }
  return warnings;
}

function scanRowForMojibake(
  row: Record<string, string>,
  rowNumber: number,
): MojibakeWarning[] {
  const warnings: MojibakeWarning[] = [];
  for (const col of IMPORT_COLUMNS) {
    const val = row[col] ?? '';
    if (val) {
      warnings.push(...detectMojibake(val, rowNumber, col));
    }
  }
  return warnings;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const LINE = '═'.repeat(63);
  const DIV  = '─'.repeat(63);

  // ── Resolve paths and config ─────────────────────────────────────────────────
  const sourcePath      = path.resolve(process.env.BATCH_SOURCE_FILE ?? DEFAULT_SOURCE);
  const outputPath      = path.resolve(process.env.BATCH_OUTPUT_FILE ?? DEFAULT_OUTPUT);
  const maxRows         = parseInt(process.env.BATCH_MAX_ROWS ?? String(DEFAULT_MAX_ROWS), 10);
  const batchClientsRaw = process.env.BATCH_CLIENTS?.trim() ?? '';

  const isBatchMode = batchClientsRaw.length > 0;

  const requestedClients: string[] = isBatchMode
    ? batchClientsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  // ── Check source file ─────────────────────────────────────────────────────────
  if (!fs.existsSync(sourcePath)) {
    console.error(`\n❌ Source file not found: ${sourcePath}`);
    console.error('   Run the audit first: npm run import:audit');
    console.error('   Or override: set BATCH_SOURCE_FILE=data/imports/your-file.csv');
    process.exit(1);
  }

  console.log(`\n${LINE}`);
  console.log('  Phase 7 — Import Batch Selection');
  console.log(LINE);
  console.log(`  Source:   ${sourcePath}`);
  console.log(`  Mode:     ${isBatchMode ? 'BATCH SELECTION' : 'SUMMARY (no output file)'}`);
  if (isBatchMode) {
    console.log(`  Output:   ${outputPath}`);
    console.log(`  Clients:  ${requestedClients.join(', ')}`);
  }
  console.log(`  Max rows: ${maxRows} (warn if exceeded)`);
  console.log('  DB:       none — no database, no imports, no Meta API calls');

  // ── Parse source CSV ──────────────────────────────────────────────────────────
  const content = fs.readFileSync(sourcePath, 'utf-8');
  const rawRows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  if (rawRows.length === 0) {
    console.error('\n❌ Source file has no data rows.');
    process.exit(1);
  }

  // ── Validate header ───────────────────────────────────────────────────────────
  const actualCols  = Object.keys(rawRows[0]!);
  const missingCols = IMPORT_COLUMNS.filter((c) => !actualCols.includes(c));
  if (missingCols.length > 0) {
    console.error(`\n❌ Source file is missing required columns: ${missingCols.join(', ')}`);
    process.exit(1);
  }

  console.log(`  Rows:     ${rawRows.length} in source file`);

  // ── Build per-client index ────────────────────────────────────────────────────
  const clientIndex = new Map<string, Array<Record<string, string>>>();
  for (const row of rawRows) {
    const client = (row['Client Name'] ?? '').trim();
    if (!client) continue;
    if (!clientIndex.has(client)) clientIndex.set(client, []);
    clientIndex.get(client)!.push(row);
  }

  const allClients = Array.from(clientIndex.keys()).sort((a, b) => a.localeCompare(b));

  // ── Summary mode ──────────────────────────────────────────────────────────────
  if (!isBatchMode) {
    console.log(`\n${LINE}`);
    console.log(`  Client Summary — ${allClients.length} clients in source file`);
    console.log(LINE);

    const colW = 48;
    console.log(`  ${'Client Name'.padEnd(colW)}  Rows`);
    console.log(`  ${DIV}`);

    let totalRows = 0;
    for (const client of allClients) {
      const rows = clientIndex.get(client)!;
      totalRows += rows.length;
      console.log(`  ${client.padEnd(colW)}  ${String(rows.length).padStart(4)}`);
    }

    console.log(`  ${DIV}`);
    console.log(`  ${'TOTAL'.padEnd(colW)}  ${String(totalRows).padStart(4)}`);
    console.log(LINE);
    console.log('');
    console.log('  To create a batch, set BATCH_CLIENTS with a comma-separated list:');
    console.log('');
    console.log('  set BATCH_CLIENTS=Client Name One,Client Name Two&& npm run import:select-batch');
    console.log('');
    console.log('  Client names must match exactly — same case, same spacing.');
    console.log(LINE);
    return;
  }

  // ── Batch selection mode ──────────────────────────────────────────────────────

  // Verify all requested clients exist in source
  const notFound: string[] = [];
  for (const client of requestedClients) {
    if (!clientIndex.has(client)) notFound.push(client);
  }

  if (notFound.length > 0) {
    console.error('\n❌ These clients were not found in the source file:');
    for (const c of notFound) console.error(`   "${c}"`);
    console.error('');
    console.error('   Client names must match exactly. Run without BATCH_CLIENTS to see all available names.');
    process.exit(1);
  }

  // Collect selected rows (preserve source order)
  const selectedRows: Array<{ row: Record<string, string>; rowNumber: number }> = [];
  const perClientCounts = new Map<string, number>();

  let globalIndex = 0;
  for (const row of rawRows) {
    globalIndex++;
    const client = (row['Client Name'] ?? '').trim();
    if (requestedClients.includes(client)) {
      selectedRows.push({ row, rowNumber: globalIndex });
      perClientCounts.set(client, (perClientCounts.get(client) ?? 0) + 1);
    }
  }

  // ── Checks ────────────────────────────────────────────────────────────────────

  const warnings: string[] = [];

  // Check 1: Batch size
  if (selectedRows.length > maxRows) {
    warnings.push(
      `Batch has ${selectedRows.length} rows — exceeds the ${maxRows}-row recommended maximum. Consider reducing the number of clients.`,
    );
  }

  // Check 2: Mojibake detection
  const allMojibakeWarnings: MojibakeWarning[] = [];
  for (const { row, rowNumber } of selectedRows) {
    allMojibakeWarnings.push(...scanRowForMojibake(row, rowNumber));
  }
  if (allMojibakeWarnings.length > 0) {
    warnings.push(
      `${allMojibakeWarnings.length} field(s) contain suspicious encoding patterns (possible mojibake). See details below.`,
    );
  }

  // Check 3: Client name variant detection within the requested list
  type VariantGroup = { normalised: string; names: string[] };
  const normToNames = new Map<string, string[]>();
  for (const client of requestedClients) {
    const norm = normaliseClientName(client);
    if (!norm) continue;
    if (!normToNames.has(norm)) normToNames.set(norm, []);
    normToNames.get(norm)!.push(client);
  }

  const variantGroups: VariantGroup[] = [];
  for (const [normalised, names] of normToNames.entries()) {
    if (names.length > 1) variantGroups.push({ normalised, names });
  }

  if (variantGroups.length > 0) {
    for (const group of variantGroups) {
      warnings.push(
        `Likely client name variants (normalise to "${group.normalised}"): ` +
        `${group.names.map((n) => `"${n}"`).join(', ')}. ` +
        `Verify which name matches the database before live import.`,
      );
    }
  }

  // ── Write output file ─────────────────────────────────────────────────────────
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const lines: string[] = [toCsvLine([...IMPORT_COLUMNS])];
  for (const { row } of selectedRows) {
    lines.push(toCsvLine(IMPORT_COLUMNS.map((col) => row[col] ?? '')));
  }
  fs.writeFileSync(outputPath, lines.join('\n') + '\n', 'utf-8');

  // ── Print batch summary ───────────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  Batch Selection Summary');
  console.log(LINE);

  const colW = 48;
  console.log(`  ${'Client Name'.padEnd(colW)}  Rows`);
  console.log(`  ${DIV}`);
  for (const client of requestedClients) {
    const count = perClientCounts.get(client) ?? 0;
    console.log(`  ${client.padEnd(colW)}  ${String(count).padStart(4)}`);
  }
  console.log(`  ${DIV}`);
  console.log(`  ${'TOTAL'.padEnd(colW)}  ${String(selectedRows.length).padStart(4)}`);

  console.log(`\n${DIV}`);
  console.log('  Output file');
  console.log(DIV);
  console.log(`  ${outputPath}`);
  console.log(`  ${selectedRows.length} rows written (UTF-8)`);

  // ── Warnings ──────────────────────────────────────────────────────────────────
  if (warnings.length > 0) {
    console.log(`\n${DIV}`);
    console.log(`  ⚠ Warnings (${warnings.length})`);
    console.log(DIV);
    for (let i = 0; i < warnings.length; i++) {
      console.log(`  ${i + 1}. ${warnings[i]}`);
    }
  }

  if (allMojibakeWarnings.length > 0) {
    console.log(`\n${DIV}`);
    console.log(`  ⚠ Encoding issues — review before import (${allMojibakeWarnings.length})`);
    console.log(DIV);
    const shown = allMojibakeWarnings.slice(0, 20);
    for (const w of shown) {
      const truncated = w.value.length > 60 ? w.value.slice(0, 60) + '…' : w.value;
      console.log(`  Row ${w.rowNumber + 1}  [${w.field}]  "${truncated}"`);
      console.log(`        Hint: ${w.hint}`);
    }
    if (allMojibakeWarnings.length > 20) {
      console.log(`  … and ${allMojibakeWarnings.length - 20} more (first 20 shown)`);
    }
  }

  // ── Next steps ────────────────────────────────────────────────────────────────
  const batchOutputRef = process.env.BATCH_OUTPUT_FILE ?? DEFAULT_OUTPUT;
  console.log(`\n${DIV}`);
  console.log('  Next steps');
  console.log(DIV);
  if (warnings.length === 0) console.log('  ✓ No warnings. Batch looks clean.');
  console.log('');
  console.log('  1. Run npm run import:check — compare DB client names against this batch.');
  console.log('  2. Run dry-run:');
  console.log('');
  console.log(`     set CLIENT_IMPORT_FILE=${batchOutputRef}&& set CLIENT_IMPORT_DRY_RUN=true&& npm run import:clients`);
  console.log('');
  console.log('  3. Review dry-run output: BLOCKED rows, WARN rows, "would be created" clients.');
  console.log('  4. Back up prisma/dev.db before live import.');
  console.log('  5. Run live import only after dry-run is clean and all checks pass.');
  console.log(LINE);
  console.log('');
}

main();
