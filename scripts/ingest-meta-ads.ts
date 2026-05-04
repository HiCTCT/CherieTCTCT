/**
 * Phase 4 Step 2 — Meta Ad Ingestion: CLI Entry Point
 *
 * Fetches ads from the Meta Ad Library API for a specific Competitor and writes
 * them to the database as discovered activity (qualified=false, reviewStatus=PENDING).
 *
 * Usage:
 *   # Dry-run (no DB writes — proves fetch → analyse → plan chain):
 *   COMPETITOR_ID=<cuid> META_DRY_RUN=true npm run meta:ingest
 *
 *   # Live ingestion (simulation mode — no META_ADLIB_TOKEN required):
 *   COMPETITOR_ID=<cuid> npm run meta:ingest
 *
 *   # Live ingestion (real Meta API):
 *   COMPETITOR_ID=<cuid> META_ADLIB_TOKEN=<token> npm run meta:ingest
 *
 *   # Override format, search terms, country:
 *   COMPETITOR_ID=<cuid> META_AD_FORMAT=VIDEO META_SEARCH_TERMS=makeup META_COUNTRIES=SG npm run meta:ingest
 *
 * Environment variables:
 *   COMPETITOR_ID         — required — Prisma cuid of the target Competitor
 *   META_DRY_RUN          — 'true' skips all DB writes (Competitor read still runs)
 *   META_ADLIB_TOKEN      — access token (absent = simulation mode)
 *   META_SEARCH_TERMS     — keyword(s) for the Ad Library query (default: 'skincare')
 *   META_COUNTRIES        — comma-separated ISO codes (default: 'SG')
 *   META_FETCH_LIMIT      — number of ads per page (default: 5, max: 25)
 *   META_AD_FORMAT        — 'STATIC' or 'VIDEO' (default: 'STATIC')
 *   META_SIMULATION_MODE  — 'true' forces simulation even when token is set
 */

import { PrismaClient } from '@prisma/client';
import { buildConfigFromEnv } from '@/lib/providers/meta/fetch';
import { redactToken } from '@/lib/providers/meta/redact';
import { ingestMetaAds } from '@/lib/ingestion/metaIngestion';

async function main(): Promise<void> {
  const competitorId = process.env.COMPETITOR_ID;
  if (!competitorId || competitorId.trim() === '') {
    throw new Error(
      'COMPETITOR_ID env var is required.\n' +
        'Set it to a valid Competitor cuid from the database.\n' +
        'Example: COMPETITOR_ID=clxxxxxxxxxxxxxxxx npm run meta:ingest',
    );
  }

  const dryRun = process.env.META_DRY_RUN === 'true';
  const fetchConfig = buildConfigFromEnv();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Phase 4 Step 2 — Meta Ad Ingestion');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Mode:          ${dryRun ? 'DRY RUN (no DB writes)' : 'LIVE WRITE'}`);
  console.log(`  Competitor ID: ${competitorId}`);
  console.log(`  Format:        ${fetchConfig.format}`);
  console.log(`  Search terms:  ${fetchConfig.searchTerms}`);
  console.log(`  Countries:     ${fetchConfig.countries.join(', ')}`);
  console.log(`  Limit:         ${fetchConfig.limit}`);

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

    if (dryRun) {
      console.log(`  Written to DB:  0`);
      console.log('');
      console.log('  ⚠  DRY RUN — set META_DRY_RUN=false (or unset it) to write to DB.');
    } else {
      console.log(`  Ads inserted:   ${result.adsInserted}`);
      console.log(`  Ads skipped:    ${result.adsSkipped} (duplicates)`);
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
    // Redact any token that may have leaked into the error message
    console.error('\n❌ Ingestion failed:', redactToken(message));
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
