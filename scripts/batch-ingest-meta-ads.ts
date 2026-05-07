/**
 * Phase 5 Step 2 — Batch Meta ingestion dry-run
 *
 * Safe batch wrapper around ingestMetaAds().
 * This step is dry-run only. Live batch writes are intentionally blocked until Phase 5 Step 3.
 *
 * Usage:
 *   META_ADLIB_TOKEN=<token> META_DRY_RUN=true npm run meta:batch
 *
 * Optional:
 *   COMPETITOR_IDS=id1,id2 META_ADLIB_TOKEN=<token> META_DRY_RUN=true npm run meta:batch
 *   META_BATCH_DELAY_MS=2000 META_ADLIB_TOKEN=<token> META_DRY_RUN=true npm run meta:batch
 */

import { PrismaClient } from '@prisma/client';
import { ingestMetaAds } from '@/lib/ingestion/metaIngestion';
import { buildConfigFromEnv } from '@/lib/providers/meta/fetch';
import { redactToken } from '@/lib/providers/meta/redact';
import { getMetaReadyCompetitors, type MetaReadyCompetitor } from '@/lib/queries/competitors';

const DEFAULT_BATCH_DELAY_MS = 2000;

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

function assertDryRunOnly(): void {
  if (process.env.META_DRY_RUN !== 'true') {
    throw new Error(
      'Phase 5 Step 2 batch ingestion is dry-run only.\n' +
        'Set META_DRY_RUN=true to run this command.\n' +
        'Live batch writes will be enabled in a later step after dry-run testing passes.',
    );
  }
}

function assertTokenPresent(): void {
  if (!process.env.META_ADLIB_TOKEN) {
    throw new Error(
      'META_ADLIB_TOKEN is required for batch dry-run.\n' +
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
  status: 'DRY_RUN_OK' | 'FAILED';
  adsProcessed: number;
  adsInserted: number;
  adsSkipped: number;
  adsErrored: number;
  durationMs: number;
  errorMessage?: string;
};

function printBatchSummary(results: BatchItemResult[]): void {
  const totalProcessed = results.reduce((sum, result) => sum + result.adsProcessed, 0);
  const totalInserted = results.reduce((sum, result) => sum + result.adsInserted, 0);
  const totalSkipped = results.reduce((sum, result) => sum + result.adsSkipped, 0);
  const totalErrored = results.reduce((sum, result) => sum + result.adsErrored, 0);
  const failed = results.filter((result) => result.status === 'FAILED');

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  BATCH DRY-RUN SUMMARY');
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
  console.log(`  Would insert:        ${totalInserted}`);
  console.log(`  Would mark seen:     ${totalSkipped}`);
  console.log(`  Would error:         ${totalErrored}`);
  console.log(`  Written to DB:       0`);
  console.log('═══════════════════════════════════════════════════════════════');
}

async function main(): Promise<void> {
  assertDryRunOnly();
  assertTokenPresent();

  const filter = parseCompetitorIdFilter();
  const delayMs = parseBatchDelayMs();
  const fetchConfig = buildConfigFromEnv();
  const prisma = new PrismaClient();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Phase 5 Step 2 — Batch Meta Ingestion Dry-Run');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Mode:          DRY RUN ONLY — no DB writes');
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
          { competitorId: competitor.id, fetchConfig: { ...fetchConfig }, dryRun: true },
          prisma,
        );

        results.push({
          competitorId: competitor.id,
          competitorName: competitor.name,
          status: 'DRY_RUN_OK',
          adsProcessed: result.adsProcessed,
          adsInserted: result.adsInserted,
          adsSkipped: result.adsSkipped,
          adsErrored: result.adsErrored,
          durationMs: Date.now() - startedAt,
        });
      } catch (error: unknown) {
        const message = redactToken(error instanceof Error ? error.message : String(error));
        console.error(`\n❌ Batch dry-run failed for ${competitor.name}: ${message}`);

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

    printBatchSummary(results);

    if (results.some((result) => result.status === 'FAILED')) {
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = redactToken(error instanceof Error ? error.message : String(error));
  console.error('\n❌ Batch dry-run failed:', message);
  process.exitCode = 1;
});
