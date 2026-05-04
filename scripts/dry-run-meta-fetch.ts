/**
 * Phase 4 Step 1 — Meta Fetch Foundation: Dry Run
 *
 * Proves the full chain: fetch (or simulate) → normalise → analyse
 * with ZERO database writes.
 *
 * Usage:
 *   # Simulation mode (no token required):
 *   npm run meta:dry-run
 *
 *   # Live API mode:
 *   META_ADLIB_TOKEN=<token> npm run meta:dry-run
 *
 *   # Override format, search, country:
 *   META_AD_FORMAT=VIDEO META_SEARCH_TERMS=makeup META_COUNTRIES=SG npm run meta:dry-run
 *
 * No Prisma. No database. No schema changes. No UI changes.
 */

import { analyseAdRow } from '@/lib/analysis';
import type { AdFormat, AnalysisOutput, ExampleRow } from '@/lib/analysis/types';
import { buildConfigFromEnv, fetchMetaAds } from '@/lib/providers/meta/fetch';
import { redactToken, safeLog, safeUrlLabel } from '@/lib/providers/meta/redact';
import type { MetaAdRecord } from '@/lib/providers/meta/types';

// ─── Normalisation ────────────────────────────────────────────────────────────

function firstOrEmpty(values: string[] | undefined): string {
  if (!values || values.length === 0) return '';
  return values[0];
}

/**
 * Maps a raw MetaAdRecord to the ExampleRow shape that analyseAdRow() consumes.
 *
 * Fields the Meta API provides → mapped:
 *   ad_creative_bodies[0]            → Copy
 *   ad_creative_link_titles[0]       → Headline
 *   ad_creative_link_descriptions[0] → Description
 *   ad_delivery_start_time           → Active Since
 *   ad_snapshot_url                  → Ad Link (printed only via safeUrlLabel)
 *   page_name                        → Product
 *
 * Fields the Meta API does NOT provide (human-written analysis) → undefined:
 *   Analysis, Improvement, Creative Analysis, Creative Improvements
 *   The analysis pipeline handles their absence with signal-based fallback scoring.
 */
function normaliseToExampleRow(record: MetaAdRecord): ExampleRow {
  return {
    Product: record.page_name ?? 'Unknown Advertiser',
    'Ad Link': record.ad_snapshot_url ?? '',
    Copy: firstOrEmpty(record.ad_creative_bodies),
    Headline: firstOrEmpty(record.ad_creative_link_titles),
    Description: firstOrEmpty(record.ad_creative_link_descriptions),
    'Active Since': record.ad_delivery_start_time ?? '',
    Analysis: undefined,
    Improvement: undefined,
    'Creative Analysis': undefined,
    'Creative Improvements': undefined,
    'Other Feedbacks': undefined,
  };
}

function deriveAdStatus(record: MetaAdRecord): 'ACTIVE' | 'INACTIVE' {
  return record.ad_delivery_stop_time ? 'INACTIVE' : 'ACTIVE';
}

function truncate(str: string, max = 80): string {
  return str.length > max ? `${str.substring(0, max)}...` : str;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = buildConfigFromEnv();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Phase 4 Step 1 — Meta Fetch Foundation: Dry Run');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Format:        ${config.format}`);
  console.log(`  Search terms:  ${config.searchTerms}`);
  console.log(`  Countries:     ${config.countries.join(', ')}`);
  console.log(`  Limit:         ${config.limit}`);

  // ── Step 1: Fetch ──────────────────────────────────────────────────────────
  const records = await fetchMetaAds(config);

  // ── Step 2: Normalise + Analyse ────────────────────────────────────────────
  type RunResult = {
    record: MetaAdRecord;
    row: ExampleRow;
    analysis: AnalysisOutput;
  };

  const results: RunResult[] = [];

  for (const record of records) {
    const row = normaliseToExampleRow(record);
    const analysis = analyseAdRow(row, config.format as AdFormat);
    results.push({ record, row, analysis });
  }

  // ── Step 3: Print results (all URL fields go through safeUrlLabel) ─────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');

  for (let i = 0; i < results.length; i++) {
    const { record, row, analysis } = results[i];

    console.log(`\n─── Ad ${i + 1} of ${results.length} ────────────────────────────────`);
    console.log(`  Advertiser:   ${record.page_name ?? 'Unknown'}`);
    console.log(`  Ad status:    ${deriveAdStatus(record)}`);
    console.log(`  Platforms:    ${record.publisher_platforms?.join(', ') ?? 'N/A'}`);
    console.log(`  Start date:   ${record.ad_delivery_start_time ?? 'N/A'}`);
    console.log(`  Stop date:    ${record.ad_delivery_stop_time ?? 'still running'}`);
    // ad_snapshot_url goes through safeUrlLabel — never printed raw if token present
    safeLog('  Snapshot URL: ', record.ad_snapshot_url);

    console.log('');
    console.log('  Normalised ExampleRow:');
    console.log(`    Product:     ${row.Product}`);
    console.log(`    Headline:    ${truncate(row.Headline ?? '(empty)')}`);
    console.log(`    Copy:        ${truncate(row.Copy ?? '(empty)')}`);
    console.log(`    Description: ${truncate(row.Description ?? '(empty)')}`);
    // Ad Link also goes through safeUrlLabel
    console.log(`    Ad Link:     ${safeUrlLabel(row['Ad Link'])}`);
    console.log(`    Active Since:${row['Active Since'] ?? '(empty)'}`);

    console.log('');
    console.log('  Analysis output:');
    console.log(`    Overall score:  ${analysis.overallScore.toFixed(1)} / 10`);
    console.log(`    Qualified:      ${analysis.qualified ? 'YES ✓' : 'NO'} (threshold: 7.0)`);
    console.log(`    Final verdict:  ${analysis.finalVerdict}`);
    console.log(`    Funnel stage:   ${analysis.funnelStage}`);
    console.log(`    RACE stage:     ${analysis.raceStage}`);
    console.log(`    Trust funnel:   ${analysis.trustFunnelStage}`);
    console.log('');
    console.log('    Phase 3.5 component scores:');
    console.log(`      Copy:        ${analysis.copyScore.toFixed(1)}`);
    console.log(`      Headline:    ${analysis.headlineScore !== null ? analysis.headlineScore.toFixed(1) : 'N/A (not provided)'}`);
    console.log(`      Description: ${analysis.descriptionScore !== null ? analysis.descriptionScore.toFixed(1) : 'N/A (not provided)'}`);
    console.log(`      Creative:    ${analysis.creativeScore.toFixed(1)}`);
    console.log(`      Clarity:     ${analysis.clarityScore.toFixed(1)}`);
    console.log(`      Connection:  ${analysis.connectionScore.toFixed(1)}`);
    console.log(`      Conviction:  ${analysis.convictionScore.toFixed(1)}`);
    console.log('');
    console.log('    AIDA scores:');
    console.log(`      Attention:   ${analysis.aidaScores.attention.toFixed(1)}`);
    console.log(`      Interest:    ${analysis.aidaScores.interest.toFixed(1)}`);
    console.log(`      Desire:      ${analysis.aidaScores.desire.toFixed(1)}`);
    console.log(`      Action:      ${analysis.aidaScores.action.toFixed(1)}`);
    console.log('');

    const activeTriggers = analysis.behaviouralTriggers.filter((t) => t.strength !== 'MISSING');
    if (activeTriggers.length > 0) {
      console.log(`    Behavioural triggers: ${activeTriggers.map((t) => `${t.name} (${t.strength})`).join(', ')}`);
    } else {
      console.log('    Behavioural triggers: none detected');
    }

    console.log(`    Strengths:    ${analysis.strengths.join(' | ')}`);
  }

  // ── Step 4: Summary ────────────────────────────────────────────────────────
  const qualifiedCount = results.filter((r) => r.analysis.qualified).length;
  const avgScore = results.length > 0
    ? results.reduce((sum, r) => sum + r.analysis.overallScore, 0) / results.length
    : 0;

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  DRY RUN SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Format used:        ${config.format}`);
  console.log(`  Ads fetched:        ${records.length}`);
  console.log(`  Ads normalised:     ${results.length}`);
  console.log(`  Ads analysed:       ${results.length}`);
  console.log(`  Qualified (≥7.0):   ${qualifiedCount} of ${results.length}`);
  console.log(`  Average score:      ${avgScore.toFixed(1)} / 10`);
  console.log(`  Written to DB:      0`);
  console.log('');

  if (!config.token && !config.simulationMode) {
    console.log('  ⚠  SIMULATION MODE — set META_ADLIB_TOKEN to test live API fetch.');
  } else if (config.token) {
    console.log('  ✓  LIVE API MODE — real Meta Ad Library data fetched.');
  } else {
    console.log('  ⚠  SIMULATION MODE — META_SIMULATION_MODE=true forced simulation.');
  }

  console.log('');
  console.log('  Chain proven:');
  console.log('    fetchMetaAds() → normaliseToExampleRow() → analyseAdRow()');
  console.log('    No Prisma client instantiated. No DB writes. No schema changes.');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // Redact token from error messages before printing
  console.error('\n❌ Dry run failed:', redactToken(message));
  process.exit(1);
});
