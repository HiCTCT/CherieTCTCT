/**
 * Phase 6 Step 1 — Client and Competitor CSV Import
 *
 * Safely imports clients, industries, and competitors from a CSV file.
 * Dry-run is the default mode. Live writes require CLIENT_IMPORT_CONFIRM_WRITE=true.
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

type CrossClientMatch = {
  competitorName: string;
  importingClient: string;
  existingClient: string;
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
  crossClientMatches: CrossClientMatch[];
  conflicts: ConflictReport[];
};

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
      errors.push({
        rowIndex,
        message: `Industry is required (Client: ${clientName}).`,
      });
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

  console.log(`\n${LINE}`);
  console.log(`  ${isDryRun ? 'CLIENT IMPORT DRY-RUN SUMMARY' : 'CLIENT IMPORT LIVE WRITE SUMMARY'}`);
  console.log(LINE);
  console.log(`  Total rows processed:   ${summary.totalRowsProcessed}`);
  console.log(`  Validation errors:      ${summary.validationErrors.length}`);
  console.log(`  Written to DB:          ${totalWritten}`);

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
    console.log(
      `  Rows with no competitor — client only (${summary.rowsWithNoCompetitor.length})`,
    );
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
    console.log(
      '  → After import, add Meta Page IDs via the app, then run: npm run meta:ready',
    );
  }

  if (summary.duplicatesSkipped.length > 0) {
    console.log(`\n${DIVIDER}`);
    console.log(`  Duplicate rows skipped (${summary.duplicatesSkipped.length})`);
    console.log(DIVIDER);
    for (const d of summary.duplicatesSkipped) {
      console.log(`  = ${d.name}  (client: ${d.client})  — ${d.reason}`);
    }
  }

  if (summary.crossClientMatches.length > 0) {
    console.log(`\n${DIVIDER}`);
    console.log(
      `  Competitors found under other clients (${summary.crossClientMatches.length})`,
    );
    console.log(DIVIDER);
    for (const m of summary.crossClientMatches) {
      console.log(
        `  ℹ ${m.competitorName}  also exists under client "${m.existingClient}"`,
      );
      if (m.metaPageIdReused) {
        console.log(
          `    → Meta Page ID ${m.reusedMetaPageId} reused from existing record (same advertiser confirmed by name match)`,
        );
      } else {
        console.log(`    → Verify this is the same advertiser before reusing Meta Page ID`);
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
    console.log(LINE);
  } else {
    if (summary.competitorsMissingMetaPageId.length > 0) {
      console.log(`\n  ${summary.competitorsMissingMetaPageId.length} competitor(s) need Meta Page IDs.`);
      console.log(`  Add them via the app, then check readiness: npm run meta:ready`);
      console.log(LINE);
    }
  }
}

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
    crossClientMatches: [],
    conflicts: [],
  };

  const seenIndustrySlugs = new Set<string>();
  const seenClientNames = new Set<string>();
  const seenCompetitorKeys = new Set<string>();

  for (const row of rows) {
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

    if (!row.competitorName) {
      summary.rowsWithNoCompetitor.push({
        client: row.clientName,
        industry: row.industry,
      });
      continue;
    }

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

    const competitorsWithSameName = await prisma.competitor.findMany({
      where: { name: row.competitorName },
      include: { client: true },
    });

    const otherClientMatches = competitorsWithSameName.filter(
      (c) => c.client.name !== row.clientName,
    );

    for (const match of otherClientMatches) {
      const alreadyReported = summary.crossClientMatches.some(
        (m) =>
          m.competitorName === row.competitorName &&
          m.existingClient === match.client.name,
      );

      if (!alreadyReported) {
        const canReuseMetaPageId = !row.metaPageId && !!match.metaPageId;
        summary.crossClientMatches.push({
          competitorName: row.competitorName,
          importingClient: row.clientName,
          existingClient: match.client.name,
          metaPageIdReused: canReuseMetaPageId,
          reusedMetaPageId: canReuseMetaPageId ? match.metaPageId : null,
        });
      }
    }

    let resolvedMetaPageId = row.metaPageId;
    if (!resolvedMetaPageId) {
      const suggestion = summary.crossClientMatches.find(
        (m) => m.competitorName === row.competitorName && m.metaPageIdReused,
      );
      if (suggestion?.reusedMetaPageId) {
        resolvedMetaPageId = suggestion.reusedMetaPageId;
      }
    }

    const existingCompetitor = competitorsWithSameName.find(
      (c) => c.client.name === row.clientName,
    );

    if (existingCompetitor) {
      const changes: string[] = [];
      const updateData: Record<string, string> = {};

      if (resolvedMetaPageId) {
        if (existingCompetitor.metaPageId) {
          if (existingCompetitor.metaPageId !== resolvedMetaPageId) {
            summary.conflicts.push({
              competitorName: row.competitorName,
              clientName: row.clientName,
              field: 'metaPageId',
              existing: existingCompetitor.metaPageId,
              incoming: resolvedMetaPageId,
            });
          }
        } else {
          updateData['metaPageId'] = resolvedMetaPageId;
          changes.push(`metaPageId: (none) → ${resolvedMetaPageId}`);
        }
      }

      if (row.facebookPageUrl) {
        if (existingCompetitor.facebookPageUrl) {
          if (existingCompetitor.facebookPageUrl !== row.facebookPageUrl) {
            summary.conflicts.push({
              competitorName: row.competitorName,
              clientName: row.clientName,
              field: 'facebookPageUrl',
              existing: existingCompetitor.facebookPageUrl,
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
            where: { id: existingCompetitor.id },
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

      const finalMetaPageId = resolvedMetaPageId ?? existingCompetitor.metaPageId;
      if (!finalMetaPageId) {
        summary.competitorsMissingMetaPageId.push({
          name: row.competitorName,
          client: row.clientName,
        });
      }
    } else {
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
  console.log('  Phase 6 Step 1 — Client and Competitor Import');
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
