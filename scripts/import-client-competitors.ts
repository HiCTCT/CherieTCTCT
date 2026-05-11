/**
 * Phase 6 Step 2.1 — Client and Competitor CSV Import with Enhanced Duplicate Detection
 *
 * Safely imports clients, industries, and competitors from a CSV file.
 * Dry-run is the default mode. Live writes require CLIENT_IMPORT_CONFIRM_WRITE=true.
 *
 * Detection signals:
 *   BLOCKED — same-client Meta Page ID or Facebook URL clash (different name). Row not created.
 *   WARN    — same-client normalised name match, or within-CSV website clash. Row created with warning.
 *   INFO    — cross-client matches (any signal). Informational only. No action taken.
 *
 * CSV format:
 *   Client Name,Industry,What They Sell,Competitor Name,Competitor Website,
 *   Facebook Page URL,Meta Ad Library URL,Meta Page ID,Notes
 *
 * Dry-run usage:
 *   CLIENT_IMPORT_FILE=<path> CLIENT_IMPORT_DRY_RUN=true npm run import:clients
 *
 * Live usage:
 *   CLIENT_IMPORT_FILE=<path> CLIENT_IMPORT_CONFIRM_WRITE=true npm run import:clients
 *
 * See docs/client-competitor-import-guide.md for full documentation.
 */

import { parse } from 'csv-parse/sync';
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

type RawCsvRow = {
  'Client Name': string;
  'Industry': string;
  'What They Sell': string;
  'Competitor Name': string;
  'Competitor Website': string;
  'Facebook Page URL': string;
  'Meta Ad Library URL': string;
  'Meta Page ID': string;
  'Notes': string;
};

type ParsedRow = {
  rowIndex: number;
  clientName: string;
  industry: string;
  industrySlug: string;
  whatTheySell: string | null;
  competitorName: string | null;
  competitorWebsite: string | null;
  facebookPageUrl: string | null;
  metaAdLibraryUrl: string | null;
  metaPageId: string | null;
  metaPageIdSource: 'column' | 'url' | null;
  notes: string | null;
};

type ValidationError = {
  rowIndex: number;
  message: string;
};

type ConflictReport = {
  competitorName: string;
  clientName: string;
  field: string;
  existing: string;
  incoming: string;
};

type SuspectedDuplicate = {
  incomingName: string;
  incomingClient: string;
  existingName: string;
  existingClient: string;
  matchType:
    | 'exact-name'
    | 'meta-page-id'
    | 'facebook-url'
    | 'normalized-name'
    | 'website-within-csv'
    | 'meta-page-id-within-csv'
    | 'facebook-url-within-csv';
  matchValue: string;
  scope: 'same-client' | 'cross-client';
  action: 'blocked' | 'warn' | 'info';
  metaPageIdReused: boolean;
  reusedMetaPageId: string | null;
};

type ImportSummary = {
  totalRowsProcessed: number;
  validationErrors: ValidationError[];
  industriesCreated: string[];
  clientsCreated: string[];
  clientsUpdated: string[];
  competitorsCreated: Array<{ name: string; client: string; hasMetaPageId: boolean }>;
  competitorsUpdated: Array<{ name: string; client: string; changes: string[] }>;
  rowsWithNoCompetitor: Array<{ client: string; industry: string }>;
  competitorsMissingMetaPageId: Array<{ name: string; client: string }>;
  duplicatesSkipped: Array<{ name: string; client: string; reason: string }>;
  suspectedDuplicates: SuspectedDuplicate[];
  conflicts: ConflictReport[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function trimField(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractMetaPageIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/view_all_page_id=(\d+)/);
  return match?.[1] ?? null;
}

function isNumericString(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * Normalise a competitor name for fuzzy matching only.
 * The original stored name is never changed.
 * Strips legal suffixes, geographic qualifiers, and punctuation.
 *
 * Examples:
 *   "Castlery SG"        => "castlery"
 *   "Castlery Singapore" => "castlery"
 *   "Castlery Pte Ltd"   => "castlery"
 *   "Dr Jart+ Singapore" => "dr jart"
 *   "My First Skool"     => "my first skool"
 */
function normalizeCompetitorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(pte\.?\s*ltd\.?|sdn\.?\s*bhd\.?|ltd\.?|inc\.?|corp\.?|llc\.?|co\.?)\b/g, '')
    .replace(/\b(singapore|sg|asia|global|international|intl)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalise a Facebook Page URL for deduplication matching.
 * Strips protocol, www prefix, and trailing slash.
 */
function normalizeFacebookUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/**
 * Normalise a competitor website URL for within-CSV deduplication.
 * Strips protocol, www prefix, and trailing slash.
 */
function normalizeWebsite(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

// ── CSV parsing and validation ────────────────────────────────────────────────

function readAndParseCsv(filePath: string): { rows: ParsedRow[]; errors: ValidationError[] } {
  const resolved = path.resolve(filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Import file not found: ${resolved}`);
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  const rawRows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as RawCsvRow[];

  const rows: ParsedRow[] = [];
  const errors: ValidationError[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const raw = rawRows[i];
    const rowIndex = i + 2;

    const clientName = trimField(raw['Client Name']);
    const industry = trimField(raw['Industry']);

    if (!clientName) {
      errors.push({ rowIndex, message: 'Client Name is required.' });
      continue;
    }

    if (!industry) {
      errors.push({ rowIndex, message: `Industry is required (Client: ${clientName}).` });
      continue;
    }

    const competitorName = trimField(raw['Competitor Name']);
    const facebookPageUrl = trimField(raw['Facebook Page URL']);
    const metaAdLibraryUrl = trimField(raw['Meta Ad Library URL']);
    const metaPageIdRaw = trimField(raw['Meta Page ID']);

    if (metaPageIdRaw && !isNumericString(metaPageIdRaw)) {
      errors.push({
        rowIndex,
        message: `Meta Page ID "${metaPageIdRaw}" must contain digits only (Competitor: ${competitorName ?? 'N/A'}).`,
      });
      continue;
    }

    if (facebookPageUrl && !/^https?:\/\/(www\.)?facebook\.com\//i.test(facebookPageUrl)) {
      errors.push({
        rowIndex,
        message: `Facebook Page URL must start with https://facebook.com/ or https://www.facebook.com/ (got: ${facebookPageUrl}).`,
      });
      continue;
    }

    let metaPageId: string | null = null;
    let metaPageIdSource: 'column' | 'url' | null = null;

    if (metaPageIdRaw) {
      metaPageId = metaPageIdRaw;
      metaPageIdSource = 'column';
    } else {
      const extracted = extractMetaPageIdFromUrl(metaAdLibraryUrl);
      if (extracted) {
        metaPageId = extracted;
        metaPageIdSource = 'url';
      }
    }

    rows.push({
      rowIndex,
      clientName,
      industry,
      industrySlug: slugify(industry),
      whatTheySell: trimField(raw['What They Sell']),
      competitorName,
      competitorWebsite: trimField(raw['Competitor Website']),
      facebookPageUrl,
      metaAdLibraryUrl,
      metaPageId,
      metaPageIdSource,
      notes: trimField(raw['Notes']),
    });
  }

  return { rows, errors };
}

// ── Mode determination ────────────────────────────────────────────────────────

function determineImportMode(): { isDryRun: boolean } {
  const isDryRun = process.env.CLIENT_IMPORT_DRY_RUN === 'true';
  const isConfirmed = process.env.CLIENT_IMPORT_CONFIRM_WRITE === 'true';

  if (isDryRun) return { isDryRun: true };

  if (!isConfirmed) {
    throw new Error(
      'Live import writes are blocked unless CLIENT_IMPORT_CONFIRM_WRITE=true is set.\n\n' +
        'Choose one of:\n\n' +
        '  Dry-run:    CLIENT_IMPORT_FILE=<path> CLIENT_IMPORT_DRY_RUN=true npm run import:clients\n' +
        '  Live write: CLIENT_IMPORT_FILE=<path> CLIENT_IMPORT_CONFIRM_WRITE=true npm run import:clients',
    );
  }

  return { isDryRun: false };
}

// ── Match description helper ──────────────────────────────────────────────────

function describeMatch(d: SuspectedDuplicate): string {
  const location = d.scope === 'same-client' ? 'same client' : `client "${d.existingClient}"`;
  switch (d.matchType) {
    case 'exact-name':
      return `Exact name also exists under ${location}`;
    case 'meta-page-id':
      return `Meta Page ID ${d.matchValue} already on "${d.existingName}" (${location})`;
    case 'facebook-url':
      return `Facebook URL already on "${d.existingName}" (${location}): ${d.matchValue}`;
    case 'normalized-name':
      return `Normalised name "${d.matchValue}" matches "${d.existingName}" (${location})`;
    case 'website-within-csv':
      return `Website also on "${d.existingName}" (${location}) in this CSV: ${d.matchValue}`;
    case 'meta-page-id-within-csv':
      return `Meta Page ID ${d.matchValue} also on "${d.existingName}" (${location}) earlier in this CSV`;
    case 'facebook-url-within-csv':
      return `Facebook URL also on "${d.existingName}" (${location}) earlier in this CSV: ${d.matchValue}`;
  }
}

// ── Summary printing ──────────────────────────────────────────────────────────

function printSummary(summary: ImportSummary, isDryRun: boolean): void {
  const LINE = '═══════════════════════════════════════════════════════════════';
  const DIVIDER = '───────────────────────────────────────────────────────────────';

  const totalWritten = isDryRun
    ? 0
    : summary.industriesCreated.length +
      summary.clientsCreated.length +
      summary.clientsUpdated.length +
      summary.competitorsCreated.length +
      summary.competitorsUpdated.length;

  const blocked = summary.suspectedDuplicates.filter((d) => d.action === 'blocked').length;
  const warned = summary.suspectedDuplicates.filter((d) => d.action === 'warn').length;
  const info = summary.suspectedDuplicates.filter((d) => d.action === 'info').length;

  console.log(`\n${LINE}`);
  console.log(`  ${isDryRun ? 'CLIENT IMPORT DRY-RUN SUMMARY' : 'CLIENT IMPORT LIVE WRITE SUMMARY'}`);
  console.log(LINE);
  console.log(`  Total rows processed:   ${summary.totalRowsProcessed}`);
  console.log(`  Validation errors:      ${summary.validationErrors.length}`);
  console.log(`  Written to DB:          ${totalWritten}`);
  if (summary.suspectedDuplicates.length > 0) {
    console.log(
      `  Suspected duplicates:   ${summary.suspectedDuplicates.length}` +
        ` (${blocked} blocked, ${warned} warned, ${info} info)`,
    );
  }

  if (summary.validationErrors.length > 0) {
    console.log(`\n${DIVIDER}`);
    console.log(`  ⚠ VALIDATION ERRORS (${summary.validationErrors.length}) — rows skipped`);
    console.log(DIVIDER);
    for (const e of summary.validationErrors) {
      console.log(`  Row ${e.rowIndex}: ${e.message}`);
    }
  }

  if (summary.industriesCreated.length > 0) {
    console.log(`\n${DIVIDER}`);
    console.log(
      `  ${isDryRun ? 'Industries that would be created' : 'Industries created'} (${summary.industriesCreated.length})`,
    );
    console.log(DIVIDER);
    for (const name of summary.industriesCreated) {
      console.log(`  + ${name}`);
    }
  }

  if (summary.clientsCreated.length > 0) {
    console.log(`\n${DIVIDER}`);
    console.log(
      `  ${isDryRun ? 'Clients that would be created' : 'Clients created'} (${summary.clientsCreated.length})`,
    );
    console.log(DIVIDER);
    for (const name of summary.clientsCreated) {
      console.log(`  + ${name}`);
    }
  }

  if (summary.clientsUpdated.length > 0) {
    console.log(`\n${DIVIDER}`);
    console.log(
      `  ${isDryRun ? 'Clients that would be updated' : 'Clients updated'} (${summary.clientsUpdated.length})`,
    );
    console.log(DIVIDER);
    for (const name of summary.clientsUpdated) {
      console.log(`  ~ ${name}`);
    }
  }

  if (summary.competitorsCreated.length > 0) {
    console.log(`\n${DIVIDER}`);
    console.log(
      `  ${isDryRun ? 'Competitors that would be created' : 'Competitors created'} (${summary.competitorsCreated.length})`,
    );
    console.log(DIVIDER);
    for (const c of summary.competitorsCreated) {
      const metaNote = c.hasMetaPageId ? '' : '  ⚠ no Meta Page ID';
      console.log(`  + ${c.name}  (client: ${c.client})${metaNote}`);
    }
  }

  if (summary.competitorsUpdated.length > 0) {
    console.log(`\n${DIVIDER}`);
    console.log(
      `  ${isDryRun ? 'Competitors that would be updated' : 'Competitors updated'} (${summary.competitorsUpdated.length})`,
    );
    console.log(DIVIDER);
    for (const c of summary.competitorsUpdated) {
      console.log(`  ~ ${c.name}  (client: ${c.client})`);
      for (const change of c.changes) {
        console.log(`      ${change}`);
      }
    }
  }

  if (summary.rowsWithNoCompetitor.length > 0) {
    console.log(`\n${DIVIDER}`);
    console.log(`  Rows with no competitor — client only (${summary.rowsWithNoCompetitor.length})`);
    console.log(DIVIDER);
    for (const r of summary.rowsWithNoCompetitor) {
      console.log(`  ${r.client}  (industry: ${r.industry})  — needs competitor discovery`);
    }
  }

  if (summary.competitorsMissingMetaPageId.length > 0) {
    console.log(`\n${DIVIDER}`);
    console.log(
      `  Competitors missing Meta Page ID (${summary.competitorsMissingMetaPageId.length})`,
    );
    console.log(DIVIDER);
    for (const c of summary.competitorsMissingMetaPageId) {
      console.log(`  ⚠ ${c.name}  (client: ${c.client})`);
    }
    console.log('  → After import, add Meta Page IDs via the app, then run: npm run meta:ready');
  }

  if (summary.duplicatesSkipped.length > 0) {
    console.log(`\n${DIVIDER}`);
    console.log(`  Duplicate rows skipped (${summary.duplicatesSkipped.length})`);
    console.log(DIVIDER);
    for (const d of summary.duplicatesSkipped) {
      console.log(`  = ${d.name}  (client: ${d.client})  — ${d.reason}`);
    }
  }

  if (summary.suspectedDuplicates.length > 0) {
    console.log(`\n${DIVIDER}`);
    console.log(`  Suspected duplicates — review required (${summary.suspectedDuplicates.length})`);
    console.log(DIVIDER);

    const allBlocked = summary.suspectedDuplicates.filter((d) => d.action === 'blocked');
    const allWarned = summary.suspectedDuplicates.filter((d) => d.action === 'warn');
    const allInfo = summary.suspectedDuplicates.filter((d) => d.action === 'info');

    for (const d of allBlocked) {
      console.log(`\n  ⛔ [BLOCKED]  "${d.incomingName}"  (client: ${d.incomingClient})`);
      console.log(`     Match: ${describeMatch(d)}`);
      console.log(`     → Row not created. Correct the CSV or use the existing competitor name.`);
    }

    for (const d of allWarned) {
      console.log(`\n  ⚠  [WARN]    "${d.incomingName}"  (client: ${d.incomingClient})`);
      console.log(`     Match: ${describeMatch(d)}`);
      console.log(
        `     → Competitor ${isDryRun ? 'would be' : 'was'} created. Verify it is not the same advertiser.`,
      );
    }

    for (const d of allInfo) {
      console.log(`\n  ℹ  [INFO]    "${d.incomingName}"  (client: ${d.incomingClient})`);
      console.log(`     Match: ${describeMatch(d)}`);
      if (d.metaPageIdReused && d.reusedMetaPageId) {
        console.log(
          `     → Meta Page ID ${d.reusedMetaPageId} carried over from cross-client exact name match.`,
        );
        console.log(`        Confirm this is the same advertiser before scanning.`);
      } else if (d.matchType === 'meta-page-id' && d.scope === 'cross-client') {
        console.log(
          `     → Same Meta Page ID tracked under multiple clients. Expected if the same`,
        );
        console.log(`        advertiser competes across both client categories.`);
      } else {
        console.log(
          `     → Verify this is the same advertiser before reusing Meta Page ID manually.`,
        );
      }
    }
  }

  if (summary.conflicts.length > 0) {
    console.log(`\n${DIVIDER}`);
    console.log(`  ⚠ CONFLICTS — existing values kept (${summary.conflicts.length})`);
    console.log(DIVIDER);
    for (const c of summary.conflicts) {
      console.log(`  ${c.competitorName}  (client: ${c.clientName})  field: ${c.field}`);
      console.log(`    existing: ${c.existing}`);
      console.log(`    incoming: ${c.incoming}`);
      console.log(`    → Existing value kept. Update manually via the app if needed.`);
    }
  }

  console.log(`\n${LINE}`);

  if (isDryRun) {
    console.log(`\n  NEXT STEP — to write to the database:`);
    console.log(
      `  CLIENT_IMPORT_FILE=<path> CLIENT_IMPORT_CONFIRM_WRITE=true npm run import:clients`,
    );
    if (blocked > 0) {
      console.log(`\n  ⛔ ${blocked} row(s) are blocked. Fix the CSV before running live import.`);
    }
    console.log(LINE);
  } else {
    if (summary.competitorsMissingMetaPageId.length > 0) {
      console.log(
        `\n  ${summary.competitorsMissingMetaPageId.length} competitor(s) need Meta Page IDs.`,
      );
      console.log(`  Add them via the app, then check readiness: npm run meta:ready`);
    }
    if (summary.suspectedDuplicates.length > 0) {
      console.log(
        `\n  Review the ${summary.suspectedDuplicates.length} suspected duplicate(s) above`,
      );
      console.log(`  before running npm run meta:ready.`);
    }
    console.log(LINE);
  }
}

// ── Core import logic ─────────────────────────────────────────────────────────

async function processImport(
  rows: ParsedRow[],
  isDryRun: boolean,
  prisma: PrismaClient,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    totalRowsProcessed: rows.length,
    validationErrors: [],
    industriesCreated: [],
    clientsCreated: [],
    clientsUpdated: [],
    competitorsCreated: [],
    competitorsUpdated: [],
    rowsWithNoCompetitor: [],
    competitorsMissingMetaPageId: [],
    duplicatesSkipped: [],
    suspectedDuplicates: [],
    conflicts: [],
  };

  // ── Prefetch all existing competitors once ──────────────────────────────
  const allExistingCompetitors = await prisma.competitor.findMany({
    include: { client: true },
  });

  type ExistingComp = (typeof allExistingCompetitors)[number];

  const byNormalizedName = new Map<string, ExistingComp[]>();
  const byMetaPageId = new Map<string, ExistingComp[]>();
  const byFacebookUrl = new Map<string, ExistingComp[]>();

  for (const comp of allExistingCompetitors) {
    const norm = normalizeCompetitorName(comp.name);
    if (!byNormalizedName.has(norm)) byNormalizedName.set(norm, []);
    byNormalizedName.get(norm)!.push(comp);

    if (comp.metaPageId) {
      if (!byMetaPageId.has(comp.metaPageId)) byMetaPageId.set(comp.metaPageId, []);
      byMetaPageId.get(comp.metaPageId)!.push(comp);
    }

    if (comp.facebookPageUrl) {
      const normUrl = normalizeFacebookUrl(comp.facebookPageUrl);
      if (!byFacebookUrl.has(normUrl)) byFacebookUrl.set(normUrl, []);
      byFacebookUrl.get(normUrl)!.push(comp);
    }
  }

  // ── Within-CSV tracking ─────────────────────────────────────────────────

  const seenIndustrySlugs = new Set<string>();
  const seenClientNames = new Set<string>();
  const seenCompetitorKeys = new Set<string>();
  const seenMetaPageIds = new Map<string, Array<{ name: string; client: string }>>();
  const seenFacebookUrls = new Map<string, Array<{ name: string; client: string }>>();
  const seenWebsites = new Map<string, { name: string; client: string }>();

  // ── Row processing ──────────────────────────────────────────────────────

  for (const row of rows) {
    // ── Industry ────────────────────────────────────────────────────────────

    const existingIndustry = await prisma.industry.findUnique({
      where: { slug: row.industrySlug },
    });

    if (!existingIndustry && !seenIndustrySlugs.has(row.industrySlug)) {
      seenIndustrySlugs.add(row.industrySlug);
      summary.industriesCreated.push(row.industry);
      if (!isDryRun) {
        await prisma.industry.create({
          data: { name: row.industry, slug: row.industrySlug },
        });
      }
    }

    // ── Client ───────────────────────────────────────────────────────────────

    const existingClient = await prisma.client.findUnique({
      where: { name: row.clientName },
    });

    if (!existingClient) {
      if (!seenClientNames.has(row.clientName)) {
        seenClientNames.add(row.clientName);
        summary.clientsCreated.push(row.clientName);
        if (!isDryRun) {
          const industry = await prisma.industry.findUnique({
            where: { slug: row.industrySlug },
          });
          await prisma.client.create({
            data: {
              name: row.clientName,
              industryId: industry!.id,
              whatTheySell: row.whatTheySell ?? undefined,
            },
          });
        }
      }
    } else {
      if (row.whatTheySell && !existingClient.whatTheySell) {
        if (!summary.clientsUpdated.includes(row.clientName)) {
          summary.clientsUpdated.push(row.clientName);
        }
        if (!isDryRun) {
          await prisma.client.update({
            where: { id: existingClient.id },
            data: { whatTheySell: row.whatTheySell },
          });
        }
      }
    }

    // ── No competitor on this row ────────────────────────────────────────────

    if (!row.competitorName) {
      summary.rowsWithNoCompetitor.push({ client: row.clientName, industry: row.industry });
      continue;
    }

    // ── Within-CSV exact-name duplicate ─────────────────────────────────────

    const competitorKey = `${row.clientName}::${row.competitorName}`;
    if (seenCompetitorKeys.has(competitorKey)) {
      summary.duplicatesSkipped.push({
        name: row.competitorName,
        client: row.clientName,
        reason: 'duplicate row in CSV',
      });
      continue;
    }
    seenCompetitorKeys.add(competitorKey);

    // ── Within-CSV signal detection ──────────────────────────────────────────

    let isBlocked = false;

    // Within-CSV: Meta Page ID
    // Compare against ALL prior rows with the same Meta Page ID so that a same-client clash
    // is not missed just because an earlier cross-client row registered first.
    if (row.metaPageId) {
      const priors = seenMetaPageIds.get(row.metaPageId) ?? [];
      for (const prior of priors) {
        if (prior.name !== row.competitorName) {
          const scope: 'same-client' | 'cross-client' =
            prior.client === row.clientName ? 'same-client' : 'cross-client';
          const action = scope === 'same-client' ? 'blocked' : 'info';
          if (action === 'blocked') isBlocked = true;
          if (
            !summary.suspectedDuplicates.some(
              (d) =>
                d.matchType === 'meta-page-id-within-csv' &&
                d.incomingName === row.competitorName &&
                d.incomingClient === row.clientName &&
                d.existingName === prior.name &&
                d.existingClient === prior.client,
            )
          ) {
            summary.suspectedDuplicates.push({
              incomingName: row.competitorName,
              incomingClient: row.clientName,
              existingName: prior.name,
              existingClient: prior.client,
              matchType: 'meta-page-id-within-csv',
              matchValue: row.metaPageId,
              scope,
              action,
              metaPageIdReused: false,
              reusedMetaPageId: null,
            });
          }
        }
      }
    }

    // Within-CSV: Facebook URL
    // Compare against ALL prior rows with the same Facebook URL so that a same-client clash
    // is not missed just because an earlier cross-client row registered first.
    if (row.facebookPageUrl) {
      const normFb = normalizeFacebookUrl(row.facebookPageUrl);
      const priors = seenFacebookUrls.get(normFb) ?? [];
      for (const prior of priors) {
        if (prior.name !== row.competitorName) {
          const scope: 'same-client' | 'cross-client' =
            prior.client === row.clientName ? 'same-client' : 'cross-client';
          const action = scope === 'same-client' ? 'blocked' : 'info';
          if (action === 'blocked') isBlocked = true;
          if (
            !summary.suspectedDuplicates.some(
              (d) =>
                d.matchType === 'facebook-url-within-csv' &&
                d.incomingName === row.competitorName &&
                d.incomingClient === row.clientName &&
                d.existingName === prior.name &&
                d.existingClient === prior.client,
            )
          ) {
            summary.suspectedDuplicates.push({
              incomingName: row.competitorName,
              incomingClient: row.clientName,
              existingName: prior.name,
              existingClient: prior.client,
              matchType: 'facebook-url-within-csv',
              matchValue: row.facebookPageUrl,
              scope,
              action,
              metaPageIdReused: false,
              reusedMetaPageId: null,
            });
          }
        }
      }
    }

    // Within-CSV: Website (WARN only)
    if (row.competitorWebsite) {
      const normSite = normalizeWebsite(row.competitorWebsite);
      const prior = seenWebsites.get(normSite);
      if (prior && prior.name !== row.competitorName) {
        const scope: 'same-client' | 'cross-client' =
          prior.client === row.clientName ? 'same-client' : 'cross-client';
        if (
          !summary.suspectedDuplicates.some(
            (d) =>
              d.matchType === 'website-within-csv' &&
              d.incomingName === row.competitorName &&
              d.existingName === prior.name,
          )
        ) {
          summary.suspectedDuplicates.push({
            incomingName: row.competitorName,
            incomingClient: row.clientName,
            existingName: prior.name,
            existingClient: prior.client,
            matchType: 'website-within-csv',
            matchValue: row.competitorWebsite,
            scope,
            action: 'warn',
            metaPageIdReused: false,
            reusedMetaPageId: null,
          });
        }
      }
    }

    if (isBlocked) continue;

    // ── DB-level detection ───────────────────────────────────────────────────

    const exactNameMatches = allExistingCompetitors.filter((c) => c.name === row.competitorName);
    const sameClientExact = exactNameMatches.find((c) => c.client.name === row.clientName) ?? null;
    const crossClientExact = exactNameMatches.filter((c) => c.client.name !== row.clientName);

    // Resolve Meta Page ID — row value first, then cross-client exact-name suggestion only
    let resolvedMetaPageId = row.metaPageId;
    let metaPageIdReusedFromCrossClient = false;
    let reusedMetaPageIdValue: string | null = null;

    if (!resolvedMetaPageId && crossClientExact.length > 0) {
      const suggestion = crossClientExact.find((c) => !!c.metaPageId);
      if (suggestion?.metaPageId) {
        resolvedMetaPageId = suggestion.metaPageId;
        metaPageIdReusedFromCrossClient = true;
        reusedMetaPageIdValue = suggestion.metaPageId;
      }
    }

    // Cross-client exact-name: INFO
    for (const match of crossClientExact) {
      if (
        !summary.suspectedDuplicates.some(
          (d) =>
            d.matchType === 'exact-name' &&
            d.incomingName === row.competitorName &&
            d.existingClient === match.client.name,
        )
      ) {
        summary.suspectedDuplicates.push({
          incomingName: row.competitorName,
          incomingClient: row.clientName,
          existingName: match.name,
          existingClient: match.client.name,
          matchType: 'exact-name',
          matchValue: row.competitorName,
          scope: 'cross-client',
          action: 'info',
          metaPageIdReused:
            metaPageIdReusedFromCrossClient && match.metaPageId === reusedMetaPageIdValue,
          reusedMetaPageId: reusedMetaPageIdValue,
        });
      }
    }

    // DB: Meta Page ID clashes (non-exact-name)
    if (resolvedMetaPageId) {
      const metaMatches = (byMetaPageId.get(resolvedMetaPageId) ?? []).filter(
        (c) => c.name !== row.competitorName,
      );
      for (const match of metaMatches) {
        const scope: 'same-client' | 'cross-client' =
          match.client.name === row.clientName ? 'same-client' : 'cross-client';
        const action = scope === 'same-client' ? 'blocked' : 'info';
        if (action === 'blocked') isBlocked = true;
        if (
          !summary.suspectedDuplicates.some(
            (d) =>
              d.matchType === 'meta-page-id' &&
              d.incomingName === row.competitorName &&
              d.incomingClient === row.clientName &&
              d.existingName === match.name &&
              d.existingClient === match.client.name,
          )
        ) {
          summary.suspectedDuplicates.push({
            incomingName: row.competitorName,
            incomingClient: row.clientName,
            existingName: match.name,
            existingClient: match.client.name,
            matchType: 'meta-page-id',
            matchValue: resolvedMetaPageId,
            scope,
            action,
            metaPageIdReused: false,
            reusedMetaPageId: null,
          });
        }
      }
    }

    // DB: Facebook URL clashes (non-exact-name)
    if (row.facebookPageUrl) {
      const normFb = normalizeFacebookUrl(row.facebookPageUrl);
      const fbMatches = (byFacebookUrl.get(normFb) ?? []).filter(
        (c) => c.name !== row.competitorName,
      );
      for (const match of fbMatches) {
        const scope: 'same-client' | 'cross-client' =
          match.client.name === row.clientName ? 'same-client' : 'cross-client';
        const action = scope === 'same-client' ? 'blocked' : 'info';
        if (action === 'blocked') isBlocked = true;
        if (
          !summary.suspectedDuplicates.some(
            (d) =>
              d.matchType === 'facebook-url' &&
              d.incomingName === row.competitorName &&
              d.incomingClient === row.clientName &&
              d.existingName === match.name &&
              d.existingClient === match.client.name,
          )
        ) {
          summary.suspectedDuplicates.push({
            incomingName: row.competitorName,
            incomingClient: row.clientName,
            existingName: match.name,
            existingClient: match.client.name,
            matchType: 'facebook-url',
            matchValue: row.facebookPageUrl,
            scope,
            action,
            metaPageIdReused: false,
            reusedMetaPageId: null,
          });
        }
      }
    }

    // DB: Normalised name clashes (non-exact-name)
    {
      const normIncoming = normalizeCompetitorName(row.competitorName);
      if (normIncoming.length > 0) {
        const normMatches = (byNormalizedName.get(normIncoming) ?? []).filter(
          (c) => c.name !== row.competitorName,
        );
        for (const match of normMatches) {
          const scope: 'same-client' | 'cross-client' =
            match.client.name === row.clientName ? 'same-client' : 'cross-client';
          const action = scope === 'same-client' ? 'warn' : 'info';
          if (
            !summary.suspectedDuplicates.some(
              (d) =>
                d.matchType === 'normalized-name' &&
                d.incomingName === row.competitorName &&
                d.incomingClient === row.clientName &&
                d.existingName === match.name &&
                d.existingClient === match.client.name,
            )
          ) {
            summary.suspectedDuplicates.push({
              incomingName: row.competitorName,
              incomingClient: row.clientName,
              existingName: match.name,
              existingClient: match.client.name,
              matchType: 'normalized-name',
              matchValue: normIncoming,
              scope,
              action,
              metaPageIdReused: false,
              reusedMetaPageId: null,
            });
          }
        }
      }
    }

    if (isBlocked) continue;

    // ── Register surviving row in within-CSV tracking maps ───────────────────
    // Appended only after all blocking checks pass. Blocked rows are never
    // added to the seen maps, so they cannot generate false within-CSV signals
    // against later rows.

    if (row.metaPageId) {
      if (!seenMetaPageIds.has(row.metaPageId)) {
        seenMetaPageIds.set(row.metaPageId, []);
      }
      seenMetaPageIds.get(row.metaPageId)!.push({ name: row.competitorName, client: row.clientName });
    }

    if (row.facebookPageUrl) {
      const normFb = normalizeFacebookUrl(row.facebookPageUrl);
      if (!seenFacebookUrls.has(normFb)) {
        seenFacebookUrls.set(normFb, []);
      }
      seenFacebookUrls.get(normFb)!.push({ name: row.competitorName, client: row.clientName });
    }

    if (row.competitorWebsite) {
      const normSite = normalizeWebsite(row.competitorWebsite);
      if (!seenWebsites.has(normSite)) {
        seenWebsites.set(normSite, { name: row.competitorName, client: row.clientName });
      }
    }

    // ── Existing same-client exact-name competitor (update path) ─────────────

    if (sameClientExact) {
      const changes: string[] = [];
      const updateData: Record<string, string> = {};

      if (resolvedMetaPageId) {
        if (sameClientExact.metaPageId) {
          if (sameClientExact.metaPageId !== resolvedMetaPageId) {
            summary.conflicts.push({
              competitorName: row.competitorName,
              clientName: row.clientName,
              field: 'metaPageId',
              existing: sameClientExact.metaPageId,
              incoming: resolvedMetaPageId,
            });
          }
        } else {
          updateData['metaPageId'] = resolvedMetaPageId;
          changes.push(`metaPageId: (none) → ${resolvedMetaPageId}`);
        }
      }

      if (row.facebookPageUrl) {
        if (sameClientExact.facebookPageUrl) {
          if (sameClientExact.facebookPageUrl !== row.facebookPageUrl) {
            summary.conflicts.push({
              competitorName: row.competitorName,
              clientName: row.clientName,
              field: 'facebookPageUrl',
              existing: sameClientExact.facebookPageUrl,
              incoming: row.facebookPageUrl,
            });
          }
        } else {
          updateData['facebookPageUrl'] = row.facebookPageUrl;
          changes.push(`facebookPageUrl: (none) → ${row.facebookPageUrl}`);
        }
      }

      if (changes.length > 0) {
        summary.competitorsUpdated.push({
          name: row.competitorName,
          client: row.clientName,
          changes,
        });
        if (!isDryRun) {
          await prisma.competitor.update({
            where: { id: sameClientExact.id },
            data: updateData,
          });
        }
      } else {
        summary.duplicatesSkipped.push({
          name: row.competitorName,
          client: row.clientName,
          reason: 'already exists with same values',
        });
      }

      const finalMetaPageId = resolvedMetaPageId ?? sameClientExact.metaPageId;
      if (!finalMetaPageId) {
        summary.competitorsMissingMetaPageId.push({
          name: row.competitorName,
          client: row.clientName,
        });
      }
    } else {
      // ── New competitor ──────────────────────────────────────────────────────

      summary.competitorsCreated.push({
        name: row.competitorName,
        client: row.clientName,
        hasMetaPageId: !!resolvedMetaPageId,
      });

      if (!resolvedMetaPageId) {
        summary.competitorsMissingMetaPageId.push({
          name: row.competitorName,
          client: row.clientName,
        });
      }

      if (!isDryRun) {
        const industry = await prisma.industry.findUnique({
          where: { slug: row.industrySlug },
        });
        const client = await prisma.client.findUnique({
          where: { name: row.clientName },
        });

        if (industry && client) {
          await prisma.competitor.create({
            data: {
              name: row.competitorName,
              clientId: client.id,
              industryId: industry.id,
              status: 'APPROVED',
              discoverySource: 'manual',
              facebookPageUrl: row.facebookPageUrl ?? undefined,
              metaPageId: resolvedMetaPageId ?? undefined,
            },
          });
        }
      }
    }
  }

  return summary;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { isDryRun } = determineImportMode();

  const filePath = process.env.CLIENT_IMPORT_FILE;
  if (!filePath) {
    throw new Error(
      'CLIENT_IMPORT_FILE is required.\n\n' +
        'Usage:\n' +
        '  CLIENT_IMPORT_FILE=<path> CLIENT_IMPORT_DRY_RUN=true npm run import:clients\n' +
        '  CLIENT_IMPORT_FILE=<path> CLIENT_IMPORT_CONFIRM_WRITE=true npm run import:clients',
    );
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Phase 6 Step 2.1 — Client and Competitor Import');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Mode:  ${isDryRun ? 'DRY RUN — no DB writes' : 'LIVE WRITE'}`);
  console.log(`  File:  ${filePath}`);

  const { rows, errors } = readAndParseCsv(filePath);

  if (errors.length > 0) {
    console.log(`\n  ⚠ ${errors.length} validation error(s) found — fix before running live import:`);
    for (const e of errors) {
      console.log(`    Row ${e.rowIndex}: ${e.message}`);
    }
    console.log('');
    process.exitCode = 1;
    return;
  }

  console.log(`  Rows:  ${rows.length} valid`);

  const prisma = new PrismaClient();

  try {
    const summary = await processImport(rows, isDryRun, prisma);
    printSummary(summary, isDryRun);

    if (summary.validationErrors.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('\n❌ Import failed:', message);
  process.exitCode = 1;
});
