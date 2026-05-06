/**
 * Phase 4 Step 8B — Meta Ad Ingestion with CLI safety guardrails: CLI Entry Point
 *
 * Fetches ads from the Meta Ad Library API for a specific Competitor and writes
 * them to the database as discovered activity (qualified=false, reviewStatus=PENDING).
 * The competitor must have a saved Meta Page ID before ingestion can run.
 *
 * Ingestion runs two internal passes:
 *   1. media_type=IMAGE -> adFormat=STATIC
 *   2. media_type=VIDEO -> adFormat=VIDEO
 *
 * The fetcher follows Meta pagination until the configured total per-pass limit,
 * no next page, or a hard safety page cap is reached.
 *
 * Usage:
 *   # Dry-run (no DB writes — proves fetch → analyse → plan chain):
 *   COMPETITOR_ID=<database_competitor_id> META_DRY_RUN=true npm run meta:ingest
 *
 *   # Live ingestion (simulation mode — no META_ADLIB_TOKEN required):
 *   COMPETITOR_ID=<database_competitor_id> npm run meta:ingest
 *
 *   # Live ingestion (real Meta API):
 *   COMPETITOR_ID=<database_competitor_id> META_ADLIB_TOKEN=<meta_token> npm run meta:ingest
 *
 *   # Override search terms, country, total per-pass limit:
 *   COMPETITOR_ID=<database_competitor_id> META_SEARCH_TERMS=makeup META_COUNTRIES=SG META_FETCH_LIMIT=25 npm run meta:ingest
 *
 * Environment variables:
 *   COMPETITOR_ID         — required — Prisma cuid of the target Competitor, e.g. cmos9wvfb016dvwmp40ww0ef1
 *   META_DRY_RUN          — 'true' skips all DB writes (Competitor read still runs)
 *   META_ADLIB_TOKEN      — access token (absent = simulation mode)
 *   META_PAGE_IDS         — optional comma-separated page IDs for dry-run/fetch tests; ingestion overrides this with Competitor.metaPageId
 *   META_SEARCH_TERMS     — keyword(s) for the Ad Library query (default: 'skincare')
 *   META_COUNTRIES        — comma-separated ISO codes (default: 'SG')
 *   META_FETCH_LIMIT      — total maximum ads per media-type pass (default: 5, max: 25)
 *   META_AD_FORMAT        — retained for meta:dry-run/backward compatibility; meta:ingest overrides format per media-type pass
 *   META_SIMULATION_MODE  — 'true' forces simulation even when token is set
 */

import { PrismaClient } from '@prisma/client';
import { buildConfigFromEnv } from '@/lib/providers/meta/fetch';
import { redactToken } from '@/lib/providers/meta/redact';
import { ingestMetaAds } from '@/lib/ingestion/metaIngestion';

const EXAMPLE_COMMAND =
  'COMPETITOR_ID=cmos9wvfb016dvwmp40ww0ef1 META_ADLIB_TOKEN=<meta_token> npm run meta:ingest';

function looksLikeMetaToken(value: string): boolean {
  if (/^EAA/i.test(value)) return true;
  if (value.length > 60) return true;
  return false;
}

function looksLikeCuid(value: string): boolean {
  return /^c[a-z0-9]{20,}$/i.test(value);
}

function validateCompetitorId(value: string | undefined): string {
  const competitorId = value?.trim();

  if (!competitorId) {
    throw new Error(
      'COMPETITOR_ID env var is required.\n' +
        'Use your database competitor ID, not the Meta Page ID and not the Meta token.\n' +
        `Example: ${EXAMPLE_COMMAND}`,
    );
  }

  if (looksLikeMetaToken(competitorId)) {
    throw new Error(
      'COMPETITOR_ID looks like a Meta access token — do not put your token there.\n' +
        'Put your token in META_ADLIB_TOKEN instead.\n' +
        `Correct format: ${EXAMPLE_COMMAND}`,
    );
  }

  if (!looksLikeCuid(competitorId)) {
    throw new Error(
      'COMPETITOR_ID does not look like a valid database competitor ID.\n' +
        "It must start with 'c' and contain only letters and digits (20+ characters total).\n" +
        'Use the id from your Competitor table, for example cmos9wvfb016dvwmp40ww0ef1.\n' +
        `Correct format: ${EXAMPLE_COMMAND}`,
    );
  }

  return competitorId;
}

async function main(): Promise<void> {
  const competitorId = validateCompetitorId(process.env.COMPETITOR_ID);

  const dryRun = process.env.META_DRY_RUN === 'true';
  const fetchConfig = buildConfigFromEnv();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Phase 4 Step 8B — Meta Ad Ingestion with CLI safety');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Mode:          ${dryRun ? 'DRY RUN (no DB writes)' : 'LIVE WRITE'}`);
  console.log(`  Competitor ID: ${competitorId}`);
  console.log(`  Search terms:  ${fetchConfig.searchTerms}`);
  console.log(`  Page IDs:      ${fetchConfig.searchPageIds?.join(', ') ?? '(loaded from competitor during ingestion)'}`);
  console.log(`  Countries:     ${fetchConfig.countries.join(', ')}`);
  console.log(`  Limit:         ${fetchConfig.limit} total ads per media-type pass`);
  console.log('  Passes:        IMAGE -> STATIC, VIDEO -> VIDEO');
  console.log('  Note:          META_AD_FORMAT is ignored by meta:ingest; format is set by media_type.');

  const prisma = new PrismaClient();

  try {
    const result = await ingestMetaAds(
      { competitorId, fetchConfig, dryRun },
      prisma,
    );

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`  ${dryRun ? 'DRY RUN SUMMARY' : 'INGESTION SUMMARY'}`);
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Ads fetched:    ${result.adsProcessed}`);

    for (const pass of result.byPass) {
      console.log(
        `  ${pass.mediaType} -> ${pass.format}: processed ${pass.adsProcessed}, inserted ${pass.adsInserted}, seen ${pass.adsSkipped}, errored ${pass.adsErrored}`,
      );
    }

    if (dryRun) {
      console.log(`  Written to DB:  0`);
      console.log('');
      console.log('  ⚠  DRY RUN — set META_DRY_RUN=false (or unset it) to write to DB.');
    } else {
      console.log(`  Ads inserted:   ${result.adsInserted}`);
      console.log(`  Ads skipped:    ${result.adsSkipped} (duplicates / SEEN)`);
      console.log(`  Ads errored:    ${result.adsErrored} (no metaAdId — skipped)`);
      console.log(`  ScanRun ID:     ${result.scanRunId}`);
      console.log(`  Written to DB:  ${result.adsInserted}`);

      if (!fetchConfig.token) {
        console.log('');
        console.log('  ⚠  SIMULATION MODE — set META_ADLIB_TOKEN to fetch real Meta ads.');
      }
    }

    console.log('═══════════════════════════════════════════════════════════════');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('\n❌ Ingestion failed:', redactToken(message));
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
