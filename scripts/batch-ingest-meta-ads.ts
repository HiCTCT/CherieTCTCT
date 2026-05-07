/**
 * Phase 5 Step 3 — Controlled live batch Meta ingestion
 *
 * Safe batch wrapper around ingestMetaAds().
 * Dry-run remains the default recommended mode. Live writes require an explicit
 * META_BATCH_CONFIRM_LIVE=true guardrail.
 *
 * Dry-run usage:
 *   META_ADLIB_TOKEN=<token> META_DRY_RUN=true npm run meta:batch
 *
 * Live usage:
 *   META_ADLIB_TOKEN=<token> META_BATCH_CONFIRM_LIVE=true npm run meta:batch
 *
 * Optional:
 *   COMPETITOR_IDS=id1,id2 META_ADLIB_TOKEN=<token> META_DRY_RUN=true npm run meta:batch
 *   META_BATCH_DELAY_MS=2000 META_ADLIB_TOKEN=<token> META_BATCH_CONFIRM_LIVE=true npm run meta:batch
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
        '  Dry-run:    META_ADLIB_TOKEN=<token> META_DRY_RUN=true npm run meta:batch\n' +
        '  Live write: META_ADLIB_TOKEN=<token> META_BATCH_CONFIRM_LIVE=true npm run meta:batch',
    );
  }

  return { isDryRun: false };
}

function assertTokenPresent(): void {
  if (!process.env.META_ADLIB_TOKEN) {
    throw new Error(
      'META_ADLIB_TOKEN is required for batch ingestion.\n' +
        'Use the token only in the terminal. Do not paste it into chat, code, or GitHub.',
    );
  }
}

function selectCompetitors(
  competitors: MetaReadyCompetitor[],
  filter: Set<string> | null,
): MetaReadyCompetitor[] {
  if (!filter) return competitors;
  return competitors.filter((competitor) => filter.has(competitor.id));
}

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

function printBatchSummary(results: BatchItemResult[], isDryRun: boolean): void {
  const totalProcessed = results.reduce((sum, result) => sum + result.adsProcessed, 0);
  const totalInserted = results.reduce((sum, result) => sum + result.adsInserted, 0);
  const totalSkipped = results.reduce((sum, result) => sum + result.adsSkipped, 0);
  const totalErrored = results.reduce((sum, result) => sum + result.adsErrored, 0);
  const failed = results.filter((result) => result.status === 'FAILED');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  ${isDryRun ? 'BATCH DRY-RUN SUMMARY' : 'BATCH LIVE WRITE SUMMARY'}`);
  console.log('═══════════════════════════════════════════════════════════════');

  for (const result of results) {
    console.log(
      `  ${result.status.padEnd(10)} ${result.competitorName} (${result.competitorId}) — processed ${result.adsProcessed}, inserted ${result.adsInserted}, seen ${result.adsSkipped}, errored ${result.adsErrored}, duration ${result.durationMs}ms`,
    );

    if (result.errorMessage) {
      console.log(`    Error: ${result.errorMessage}`);
    }
  }

  console.log('');
  console.log(`  Competitors checked: ${results.length}`);
  console.log(`  Failed:              ${failed.length}`);
  console.log(`  Ads processed:       ${totalProcessed}`);
  console.log(`  ${isDryRun ? 'Would insert' : 'Ads inserted'}:        ${totalInserted}`);
  console.log(`  ${isDryRun ? 'Would mark seen' : 'Ads seen'}:        ${totalSkipped}`);
  console.log(`  ${isDryRun ? 'Would error' : 'Ads errored'}:         ${totalErrored}`);
  console.log(`  Written to DB:       ${isDryRun ? 0 : totalInserted}`);
  console.log('═══════════════════════════════════════════════════════════════');
}

async function main(): Promise<void> {
  const { isDryRun } = determineBatchMode();
  assertTokenPresent();

  const filter = parseCompetitorIdFilter();
  const delayMs = parseBatchDelayMs();
  const fetchConfig = buildConfigFromEnv();
  const prisma = new PrismaClient();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Phase 5 Step 3 — Batch Meta Ingestion');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Mode:          ${isDryRun ? 'DRY RUN — no DB writes' : 'LIVE WRITE'}`);
  if (!isDryRun) {
    console.log('  ⚠ LIVE WRITE MODE: new ads can be inserted as PENDING review records.');
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
        console.error(`\n❌ Batch ${isDryRun ? 'dry-run' : 'live write'} failed for ${competitor.name}: ${message}`);

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

    printBatchSummary(results, isDryRun);

    if (results.some((result) => result.status === 'FAILED')) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = redactToken(error instanceof Error ? error.message : String(error));
  console.error('\n❌ Batch ingestion failed:', message);
  process.exitCode = 1;
});
