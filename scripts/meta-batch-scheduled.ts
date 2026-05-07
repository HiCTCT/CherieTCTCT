/**
 * Phase 5 Step 5 — Scheduled batch Meta ingestion wrapper
 *
 * Thin wrapper around the existing batch ingestion logic, intended for
 * scheduled / CI use (e.g. GitHub Actions workflow_dispatch or cron).
 *
 * All safety gates from the manual batch script remain in place:
 *   - META_ADLIB_TOKEN must be present
 *   - META_BATCH_CONFIRM_LIVE=true is required for live DB writes
 *   - Inserted ads remain reviewStatus=PENDING and qualified=false
 */

import { PrismaClient } from '@prisma/client';
import { ingestMetaAds } from '@/lib/ingestion/metaIngestion';
import { buildConfigFromEnv } from '@/lib/providers/meta/fetch';
import { redactToken } from '@/lib/providers/meta/redact';
import { getMetaReadyCompetitors, type MetaReadyCompetitor } from '@/lib/queries/competitors';

const DEFAULT_BATCH_DELAY_MS = 2000;

type BatchMode = {
  isDryRun: boolean;
};

type BatchItemResult = {
  competitorId: string;
  competitorName: string;
  status: 'DRY_RUN_OK' | 'LIVE_OK' | 'FAILED';
  adsProcessed: number;
  adsInserted: number;
  adsSkipped: number;
  adsErrored: number;
  durationMs: number;
  errorMessage?: string;
};

function parseBatchDelayMs(): number {
  const raw = process.env.META_BATCH_DELAY_MS;
  if (!raw) return DEFAULT_BATCH_DELAY_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_BATCH_DELAY_MS;
  return parsed;
}

function parseCompetitorIdFilter(): Set<string> | null {
  const raw = process.env.COMPETITOR_IDS;
  if (!raw || raw.trim() === '') return null;
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function determineBatchMode(): BatchMode {
  const isDryRun = process.env.META_DRY_RUN === 'true';
  const isLiveConfirmed = process.env.META_BATCH_CONFIRM_LIVE === 'true';

  if (isDryRun) {
    return { isDryRun: true };
  }

  if (!isLiveConfirmed) {
    throw new Error(
      'Live batch writes are blocked unless META_BATCH_CONFIRM_LIVE=true is set.\n\n' +
        'Choose one of:\n\n' +
        '  Dry-run:    META_ADLIB_TOKEN=<token> META_DRY_RUN=true SCHEDULED_MODE=true npm run meta:batch:scheduled\n' +
        '  Live write: META_ADLIB_TOKEN=<token> META_BATCH_CONFIRM_LIVE=true SCHEDULED_MODE=true npm run meta:batch:scheduled\n\n' +
        'Note: live writes require DATABASE_URL to point to a hosted network database, not a local SQLite file.',
    );
  }

  return { isDryRun: false };
}

function assertTokenPresent(): void {
  if (!process.env.META_ADLIB_TOKEN) {
    throw new Error(
      'META_ADLIB_TOKEN is required for batch ingestion.\n' +
        'Use the token only in the terminal or GitHub Secrets. Do not paste it into chat, code, or GitHub.',
    );
  }
}

function assertScheduledMode(): void {
  if (process.env.SCHEDULED_MODE !== 'true') {
    console.warn(
      '\n  ⚠ Warning: SCHEDULED_MODE is not set.\n' +
        '  This script is intended for scheduled/CI use.\n' +
        '  For manual batch ingestion, use: npm run meta:batch\n',
    );
  }
}

function selectCompetitors(
  competitors: MetaReadyCompetitor[],
  filter: Set<string> | null,
): MetaReadyCompetitor[] {
  if (!filter) return competitors;
  return competitors.filter((c) => filter.has(c.id));
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function printScheduledSummary(
  results: BatchItemResult[],
  isDryRun: boolean,
  totalDurationMs: number,
  startedAt: string,
): void {
  const totalInserted = results.reduce((sum, r) => sum + r.adsInserted, 0);
  const totalProcessed = results.reduce((sum, r) => sum + r.adsProcessed, 0);
  const totalSkipped = results.reduce((sum, r) => sum + r.adsSkipped, 0);
  const totalErrored = results.reduce((sum, r) => sum + r.adsErrored, 0);
  const failed = results.filter((r) => r.status === 'FAILED');

  const LINE =
    '═══════════════════════════════════════════════════════════════';
  const DIVIDER =
    '───────────────────────────────────────────────────────────────';

  console.log(`\n${LINE}`);
  console.log(`  ${isDryRun ? 'SCHEDULED DRY-RUN SUMMARY' : 'SCHEDULED LIVE WRITE SUMMARY'}`);
  if (!isDryRun) {
    console.log('  ⚠ LIVE WRITE MODE');
  }
  console.log(`  Started:       ${startedAt}`);
  console.log(`  Total time:    ${formatDuration(totalDurationMs)}`);
  console.log(`  Competitors:   ${results.length}  |  Failed: ${failed.length}`);
  console.log(LINE);

  for (const result of results) {
    const icon = result.status === 'FAILED' ? '✗' : '✓';
    console.log(`\n  ${icon}  ${result.competitorName}`);
    if (result.status === 'FAILED') {
      console.log(`     Status: FAILED  |  ${result.errorMessage ?? 'Unknown error'}`);
    } else {
      const insertLabel = isDryRun ? 'Would insert' : 'Inserted';
      console.log(
        `     Status: ${result.status}  |  Fetched: ${result.adsProcessed}  |  ${insertLabel}: ${result.adsInserted}  |  Skipped: ${result.adsSkipped}  |  Errored: ${result.adsErrored}  |  ${formatDuration(result.durationMs)}`,
      );
    }
  }

  console.log(`\n${LINE}`);
  console.log(`  Ads processed:    ${totalProcessed}`);
  console.log(`  ${isDryRun ? 'Would insert' : 'Inserted'}:         ${totalInserted}`);
  console.log(`  ${isDryRun ? 'Would mark seen' : 'Seen'}:          ${totalSkipped}`);
  console.log(`  ${isDryRun ? 'Would error' : 'Errored'}:           ${totalErrored}`);
  console.log(`  Written to DB:    ${isDryRun ? 0 : totalInserted}`);

  if (failed.length > 0) {
    console.log(`\n${DIVIDER}`);
    console.log(`  ⚠ FAILURES (${failed.length})`);
    console.log(DIVIDER);
    for (const result of failed) {
      console.log(`  ${result.competitorName.padEnd(30)} (${result.competitorId})`);
      console.log(`  → ${result.errorMessage ?? 'Unknown error'}`);
    }
  }

  if (!isDryRun) {
    console.log(`\n${DIVIDER}`);
    console.log('  All inserted ads: reviewStatus=PENDING, qualified=false');
    console.log('  Review and approve at: http://localhost:3000/ads');

    const withInserts = results.filter((r) => r.status === 'LIVE_OK' && r.adsInserted > 0);
    if (withInserts.length > 0) {
      console.log(`\n${DIVIDER}`);
      console.log('  NEXT STEPS — verify each ingest:');
      console.log('');
      for (const result of withInserts) {
        console.log(
          `  COMPETITOR_ID=${result.competitorId} npm run meta:verify   # ${result.competitorName}`,
        );
      }
      console.log('');
      console.log('  Review pending ads:');
      console.log('  http://localhost:3000/ads?reviewStatus=PENDING&adSource=meta_api');
    }
  }

  if (isDryRun) {
    console.log(`\n${DIVIDER}`);
    console.log('  NEXT STEP — when ready to write to the database:');
    console.log('');
    console.log('  Ensure DATABASE_URL points to a hosted network database, then:');
    console.log(
      '  META_ADLIB_TOKEN=<token> META_BATCH_CONFIRM_LIVE=true SCHEDULED_MODE=true npm run meta:batch:scheduled',
    );
  }

  console.log(LINE);

  console.log(
    `\n[SCHEDULED:DONE] mode=${isDryRun ? 'DRY_RUN' : 'LIVE'} competitors=${results.length} failed=${failed.length} inserted=${totalInserted} duration=${formatDuration(totalDurationMs)}`,
  );
}

async function main(): Promise<void> {
  const batchStartedAt = Date.now();
  const startedAtIso = new Date().toISOString();

  console.log(`\n[SCHEDULED] Phase 5 Step 5 — Batch Meta Ingestion — ${startedAtIso}`);

  assertScheduledMode();

  const { isDryRun } = determineBatchMode();
  assertTokenPresent();

  const filter = parseCompetitorIdFilter();
  const delayMs = parseBatchDelayMs();
  const fetchConfig = buildConfigFromEnv();
  const prisma = new PrismaClient();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Phase 5 Step 5 — Scheduled Meta Ingestion');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Mode:          ${isDryRun ? 'DRY RUN — no DB writes' : 'LIVE WRITE'}`);
  if (!isDryRun) {
    console.log('  ⚠ LIVE WRITE MODE: new ads will be inserted as PENDING review records.');
  }
  console.log(`  Search terms:  ${fetchConfig.searchTerms || '(empty)'}`);
  console.log(`  Countries:     ${fetchConfig.countries.join(', ')}`);
  console.log(`  Limit:         ${fetchConfig.limit} total ads per media-type pass`);
  console.log(`  Batch delay:   ${delayMs}ms between competitors`);
  console.log(`  Scope:         ${filter ? Array.from(filter).join(', ') : 'all Meta-ready competitors'}`);
  console.log('  Token:         detected, never logged');

  try {
    const readyCompetitors = await getMetaReadyCompetitors();
    const competitors = selectCompetitors(readyCompetitors, filter);

    if (competitors.length === 0) {
      console.log('\nNo Meta-ready competitors matched this batch scope.');
      console.log('Run npm run meta:ready to see available competitors.');
      process.exitCode = 1;
      return;
    }

    const results: BatchItemResult[] = [];

    for (let index = 0; index < competitors.length; index++) {
      const competitor = competitors[index];
      const startedAt = Date.now();

      console.log('\n───────────────────────────────────────────────────────────────');
      console.log(`  [${index + 1}/${competitors.length}] ${competitor.name}`);
      console.log(`  COMPETITOR_ID: ${competitor.id}`);
      console.log(`  Meta Page ID:  ${competitor.metaPageId}`);
      console.log('───────────────────────────────────────────────────────────────');

      try {
        const result = await ingestMetaAds(
          { competitorId: competitor.id, fetchConfig: { ...fetchConfig }, dryRun: isDryRun },
          prisma,
        );

        results.push({
          competitorId: competitor.id,
          competitorName: competitor.name,
          status: isDryRun ? 'DRY_RUN_OK' : 'LIVE_OK',
          adsProcessed: result.adsProcessed,
          adsInserted: result.adsInserted,
          adsSkipped: result.adsSkipped,
          adsErrored: result.adsErrored,
          durationMs: Date.now() - startedAt,
        });
      } catch (error: unknown) {
        const message = redactToken(error instanceof Error ? error.message : String(error));
        console.error(
          `\n❌ Scheduled ${isDryRun ? 'dry-run' : 'live write'} failed for ${competitor.name}: ${message}`,
        );

        results.push({
          competitorId: competitor.id,
          competitorName: competitor.name,
          status: 'FAILED',
          adsProcessed: 0,
          adsInserted: 0,
          adsSkipped: 0,
          adsErrored: 1,
          durationMs: Date.now() - startedAt,
          errorMessage: message,
        });
      }

      if (index < competitors.length - 1) {
        console.log(`\n  Waiting ${delayMs}ms before next competitor...`);
        await sleep(delayMs);
      }
    }

    printScheduledSummary(results, isDryRun, Date.now() - batchStartedAt, startedAtIso);

    if (results.some((r) => r.status === 'FAILED')) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = redactToken(error instanceof Error ? error.message : String(error));
  console.error('\n❌ Scheduled batch ingestion failed:', message);
  process.exitCode = 1;
});
