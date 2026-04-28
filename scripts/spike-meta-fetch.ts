/**
 * Phase 4 Feasibility Spike: Meta Ad Library Fetch → Normalise → Analyse
 *
 * This script proves whether real Meta ad data can be fetched, normalised into
 * our ExampleRow shape, and run through the existing analysis pipeline.
 *
 * Usage:
 *   # Real API fetch (requires META_ADLIB_TOKEN):
 *   META_ADLIB_TOKEN=<token> npx tsx scripts/spike-meta-fetch.ts
 *
 *   # JSON simulation fallback (no token needed):
 *   npx tsx scripts/spike-meta-fetch.ts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * META_ADLIB_TOKEN REQUIREMENTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * To use the real Meta Ad Library API you need:
 *
 * 1. A Meta developer account: https://developers.facebook.com/
 * 2. A Meta App configured with the Marketing API product
 * 3. An access token with the `ads_read` permission
 *
 * How to generate the token:
 *   a. Go to https://developers.facebook.com/tools/explorer/
 *   b. Select your app in the top-right
 *   c. Click "Generate Access Token"
 *   d. Grant the `ads_read` permission when prompted
 *   e. Copy the token and set it as META_ADLIB_TOKEN
 *
 * Token types:
 *   - Short-lived: lasts ~1–2 hours (fine for this spike)
 *   - Long-lived: lasts ~60 days (better for repeated testing)
 *     Convert via: GET /oauth/access_token?grant_type=fb_exchange_token
 *                  &client_id={app-id}&client_secret={app-secret}
 *                  &fb_exchange_token={short-lived-token}
 *
 * The exact API request this script will make:
 *
 *   GET https://graph.facebook.com/v25.0/ads_archive
 *     ?search_terms=<keyword>
 *     &ad_reached_countries=['SG']
 *     &ad_active_status=ALL
 *     &fields=ad_creation_time,ad_delivery_start_time,ad_delivery_stop_time,
 *             ad_snapshot_url,page_id,page_name,ad_creative_bodies,
 *             ad_creative_link_titles,ad_creative_link_descriptions,
 *             publisher_platforms
 *     &limit=5
 *     &access_token=<META_ADLIB_TOKEN>
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { analyseAdRow } from '@/lib/analysis';
import type { AdFormat, AnalysisOutput, ExampleRow } from '@/lib/analysis/types';

// ─── Types ────────────────────────────────────────────────────────────────────

type MetaAdRecord = {
  page_name?: string;
  page_id?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_creative_link_descriptions?: string[];
  ad_snapshot_url?: string;
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string | null;
  ad_creation_time?: string;
  publisher_platforms?: string[];
};

type MetaApiResponse = {
  data: MetaAdRecord[];
  paging?: {
    cursors?: { after?: string };
    next?: string;
  };
  error?: {
    message: string;
    code: number;
  };
};

type NormalisedResult = {
  source: 'meta-api' | 'json-simulation';
  advertiser: string;
  format: AdFormat;
  row: ExampleRow;
  analysis: AnalysisOutput;
  metaFields: {
    pageId: string | undefined;
    platforms: string[] | undefined;
    snapshotUrl: string | undefined;
    deliveryStartTime: string | undefined;
    deliveryStopTime: string | null | undefined;
    adStatus: 'ACTIVE' | 'INACTIVE';
  };
};

// ─── Token redaction ──────────────────────────────────────────────────────────

function redactToken(value: string): string {
  return value.replace(/access_token=[^&\s]+/g, 'access_token=REDACTED');
}

function safeUrlLabel(url: string | undefined): string {
  if (!url) return 'N/A';
  if (/access_token=/i.test(url)) return 'present (token redacted)';
  return url;
}

// ─── Meta API fetch ───────────────────────────────────────────────────────────

const META_API_BASE = 'https://graph.facebook.com/v25.0/ads_archive';
const SEARCH_TERM = 'skincare';
const COUNTRY = 'SG';
const FETCH_LIMIT = 5;

async function fetchFromMetaApi(token: string): Promise<MetaAdRecord[]> {
  const params = new URLSearchParams({
    search_terms: SEARCH_TERM,
    ad_reached_countries: `['${COUNTRY}']`,
    ad_active_status: 'ALL',
    fields: [
      'ad_creation_time',
      'ad_delivery_start_time',
      'ad_delivery_stop_time',
      'ad_snapshot_url',
      'page_id',
      'page_name',
      'ad_creative_bodies',
      'ad_creative_link_titles',
      'ad_creative_link_descriptions',
      'publisher_platforms',
    ].join(','),
    limit: String(FETCH_LIMIT),
    access_token: token,
  });

  const url = `${META_API_BASE}?${params.toString()}`;
  console.log(`\n📡 Fetching from Meta Ad Library API...`);
  console.log(`   Search term: "${SEARCH_TERM}"`);
  console.log(`   Country: ${COUNTRY}`);
  console.log(`   Limit: ${FETCH_LIMIT}`);
  console.log(`   URL: ${META_API_BASE}?search_terms=${SEARCH_TERM}&...`);

  const response = await fetch(url);
  const json = (await response.json()) as MetaApiResponse;

  if (json.error) {
    throw new Error(
      `Meta API error (code ${json.error.code}): ${redactToken(json.error.message)}`,
    );
  }

  if (!json.data || json.data.length === 0) {
    throw new Error('Meta API returned no ads for this search.');
  }

  console.log(`   ✓ Received ${json.data.length} ad(s)\n`);
  return json.data;
}

// ─── JSON simulation (fallback) ──────────────────────────────────────────────

function getSimulatedRecords(): MetaAdRecord[] {
  // These are realistic sample records matching the shape returned by the
  // Meta Ad Library API. They are NOT real ads — they are constructed to
  // prove the normalisation + analysis path works.
  return [
    {
      page_name: 'Glow Skincare SG',
      page_id: '100001234567890',
      ad_creative_bodies: [
        'Discover our new Vitamin C serum — clinically proven to brighten skin in 14 days. ' +
        'Get started with a free trial today. Trusted by over 50,000 customers in Singapore.',
      ],
      ad_creative_link_titles: ['Get Your Free Vitamin C Serum Trial'],
      ad_creative_link_descriptions: [
        'Start your skincare transformation. Limited time offer — free shipping on all orders.',
      ],
      ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=111222333',
      ad_delivery_start_time: '2026-03-15T00:00:00+0800',
      ad_delivery_stop_time: null,
      ad_creation_time: '2026-03-14T10:30:00+0800',
      publisher_platforms: ['facebook', 'instagram'],
    },
    {
      page_name: 'Dr Jart+ Singapore',
      page_id: '100009876543210',
      ad_creative_bodies: [
        'NEW Ceramidin Cream — your skin barrier\'s best friend. ' +
        'Book a consultation at our Orchard Road store. Results guaranteed or your money back.',
      ],
      ad_creative_link_titles: ['Shop Ceramidin Cream Now'],
      ad_creative_link_descriptions: [
        'Dermatologist-recommended skincare. Compare our range and find your perfect match.',
      ],
      ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=444555666',
      ad_delivery_start_time: '2026-02-01T00:00:00+0800',
      ad_delivery_stop_time: '2026-04-01T00:00:00+0800',
      ad_creation_time: '2026-01-28T14:00:00+0800',
      publisher_platforms: ['facebook'],
    },
    {
      page_name: 'The Ordinary SG',
      page_id: '100005555555555',
      ad_creative_bodies: [
        'Hyaluronic Acid 2% + B5. Simple, effective hydration for every skin type. ' +
        'Learn more about our science-first approach to skincare.',
      ],
      ad_creative_link_titles: ['Explore The Ordinary Range'],
      ad_creative_link_descriptions: undefined,
      ad_snapshot_url: 'https://www.facebook.com/ads/archive/render_ad/?id=777888999',
      ad_delivery_start_time: '2026-04-10T00:00:00+0800',
      ad_delivery_stop_time: null,
      ad_creation_time: '2026-04-09T08:00:00+0800',
      publisher_platforms: ['facebook', 'instagram', 'audience_network'],
    },
  ];
}

// ─── Normalisation: Meta record → ExampleRow ─────────────────────────────────

function firstOrEmpty(values: string[] | undefined): string {
  if (!values || values.length === 0) return '';
  return values[0];
}

function normaliseToExampleRow(record: MetaAdRecord): ExampleRow {
  return {
    Product: record.page_name ?? 'Unknown Advertiser',
    'Ad Link': record.ad_snapshot_url ?? '',
    Copy: firstOrEmpty(record.ad_creative_bodies),
    Headline: firstOrEmpty(record.ad_creative_link_titles),
    Description: firstOrEmpty(record.ad_creative_link_descriptions),
    'Active Since': record.ad_delivery_start_time ?? '',
    // These fields are human-written analysis that the Meta API does not provide.
    // The analysis pipeline handles their absence gracefully with fallback text.
    Analysis: undefined,
    Improvement: undefined,
    'Creative Analysis': undefined,
    'Creative Improvements': undefined,
  };
}

function inferFormat(_record: MetaAdRecord): AdFormat {
  // The Meta API does not directly indicate STATIC vs VIDEO in the fields we
  // request. In production we could use the `media_type` filter parameter or
  // inspect the snapshot. For this spike we default to STATIC.
  return 'STATIC';
}

function deriveAdStatus(record: MetaAdRecord): 'ACTIVE' | 'INACTIVE' {
  return record.ad_delivery_stop_time ? 'INACTIVE' : 'ACTIVE';
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const token = process.env.META_ADLIB_TOKEN;
  const useRealApi = Boolean(token);

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Phase 4 Feasibility Spike: Meta Ad Library → Analyse');
  console.log('═══════════════════════════════════════════════════════════════');

  if (useRealApi) {
    console.log('\n  Mode: REAL API FETCH (META_ADLIB_TOKEN detected)');
  } else {
    console.log('\n  Mode: JSON SIMULATION (no META_ADLIB_TOKEN)');
    console.log('  ⚠  This proves normalisation + analysis only.');
    console.log('     It does NOT prove real Meta API fetch access.');
    console.log('     Set META_ADLIB_TOKEN to test the real fetch path.');
  }

  // Step 1: Fetch records
  let records: MetaAdRecord[];
  const source: NormalisedResult['source'] = useRealApi ? 'meta-api' : 'json-simulation';

  if (useRealApi) {
    records = await fetchFromMetaApi(token!);
  } else {
    records = getSimulatedRecords();
    console.log(`\n📋 Using ${records.length} simulated ad record(s)\n`);
  }

  // Step 2: Normalise + Analyse each record
  const results: NormalisedResult[] = [];

  for (const record of records) {
    const row = normaliseToExampleRow(record);
    const format = inferFormat(record);
    const analysis = analyseAdRow(row, format);

    results.push({
      source,
      advertiser: record.page_name ?? 'Unknown',
      format,
      row,
      analysis,
      metaFields: {
        pageId: record.page_id,
        platforms: record.publisher_platforms,
        snapshotUrl: record.ad_snapshot_url,
        deliveryStartTime: record.ad_delivery_start_time,
        deliveryStopTime: record.ad_delivery_stop_time,
        adStatus: deriveAdStatus(record),
      },
    });
  }

  // Step 3: Print results
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    console.log(`\n─── Ad ${i + 1} of ${results.length} ────────────────────────────────`);
    console.log(`  Source:       ${r.source}`);
    console.log(`  Advertiser:   ${r.advertiser}`);
    console.log(`  Format:       ${r.format}`);
    console.log(`  Ad status:    ${r.metaFields.adStatus}`);
    console.log(`  Platforms:    ${r.metaFields.platforms?.join(', ') ?? 'N/A'}`);
    console.log(`  Start date:   ${r.metaFields.deliveryStartTime ?? 'N/A'}`);
    console.log(`  Stop date:    ${r.metaFields.deliveryStopTime ?? 'still running'}`);
    console.log(`  Snapshot URL: ${safeUrlLabel(r.metaFields.snapshotUrl)}`);
    console.log('');
    console.log('  Mapped ExampleRow fields:');
    console.log(`    Product:     ${r.row.Product}`);
    console.log(`    Headline:    ${r.row.Headline ?? '(empty)'}`);
    console.log(`    Copy:        ${(r.row.Copy ?? '').substring(0, 80)}${(r.row.Copy ?? '').length > 80 ? '...' : ''}`);
    console.log(`    Description: ${(r.row.Description ?? '').substring(0, 80)}${(r.row.Description ?? '').length > 80 ? '...' : ''}`);
    console.log(`    Ad Link:     ${safeUrlLabel(r.row['Ad Link'])}`);
    console.log(`    Active Since:${r.row['Active Since'] ?? '(empty)'}`);
    console.log('');
    console.log('  Analysis output:');
    console.log(`    Overall score:  ${r.analysis.overallScore.toFixed(1)} / 10`);
    console.log(`    Qualified:      ${r.analysis.qualified ? 'YES' : 'NO'} (threshold: 7.0)`);
    console.log(`    Funnel stage:   ${r.analysis.funnelStage}`);
    console.log(`    RACE stage:     ${r.analysis.raceStage}`);
    console.log('');
    console.log('    Sub-scores:');
    for (const [key, value] of Object.entries(r.analysis.subScores)) {
      if (value !== undefined) {
        console.log(`      ${key.padEnd(24)} ${(value as number).toFixed(1)}`);
      }
    }
    console.log('');
    console.log('    AIDA:');
    console.log(`      Attention: ${r.analysis.aida.attention}`);
    console.log(`      Interest:  ${r.analysis.aida.interest}`);
    console.log(`      Desire:    ${r.analysis.aida.desire}`);
    console.log(`      Action:    ${r.analysis.aida.action}`);
    console.log('');
    console.log(`    Strengths:    ${r.analysis.strengths.join(' | ')}`);
    console.log(`    Weaknesses:   ${r.analysis.weaknesses.length > 0 ? r.analysis.weaknesses.join(' | ') : '(none detected)'}`);
    console.log(`    Improvements: ${r.analysis.improvements[0]}`);
  }

  // Step 4: Summary
  const qualifiedCount = results.filter((r) => r.analysis.qualified).length;
  const avgScore =
    results.reduce((sum, r) => sum + r.analysis.overallScore, 0) / results.length;

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SPIKE SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Source:              ${source}`);
  console.log(`  Ads processed:       ${results.length}`);
  console.log(`  Qualified (≥7.0):    ${qualifiedCount} of ${results.length}`);
  console.log(`  Average score:       ${avgScore.toFixed(1)} / 10`);
  console.log(`  Format used:         STATIC (default — see notes)`);
  console.log('');

  if (source === 'json-simulation') {
    console.log('  ⚠  PARTIAL FEASIBILITY ONLY');
    console.log('     This run used simulated JSON data, not real Meta API data.');
    console.log('     It proves: normalisation + analysis pipeline works.');
    console.log('     It does NOT prove: real Meta API fetch access.');
    console.log('     To prove real fetch: set META_ADLIB_TOKEN and re-run.');
  } else {
    console.log('  ✓  FULL FEASIBILITY PROVEN');
    console.log('     Real ads fetched from Meta Ad Library API.');
    console.log('     Normalisation and analysis pipeline works end-to-end.');
  }

  // Step 5: Field mapping report
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  FIELD MAPPING REPORT');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  Fields reliably available from Meta API:');
  console.log('    ✓ page_name          → ExampleRow.Product → Ad.productOrService');
  console.log('    ✓ ad_creative_bodies → ExampleRow.Copy    → Ad.primaryCopy');
  console.log('    ✓ ad_creative_link_titles → ExampleRow.Headline → Ad.headline');
  console.log('    ✓ ad_creative_link_descriptions → ExampleRow.Description → Ad.description');
  console.log('    ✓ ad_snapshot_url    → ExampleRow["Ad Link"] → Ad.adLink');
  console.log('    ✓ ad_delivery_start_time → ExampleRow["Active Since"] → Ad.activeSince / Ad.firstSeenAt');
  console.log('    ✓ ad_delivery_stop_time → Ad.lastSeenAt / Ad.adStatus');
  console.log('    ✓ publisher_platforms (available but not mapped to current schema)');
  console.log('    ✓ page_id (available — useful for search_page_ids competitor tracking)');
  console.log('');
  console.log('  Fields NOT available from Meta API (human-written):');
  console.log('    ✗ Analysis           — pipeline uses fallback text');
  console.log('    ✗ Improvement        — pipeline uses fallback text');
  console.log('    ✗ Creative Analysis  — pipeline uses fallback text');
  console.log('    ✗ Creative Improvements — pipeline uses fallback text');
  console.log('');
  console.log('  Impact of missing fields:');
  console.log('    - Sub-scores that rely on analysisReference (firstThreeSeconds,');
  console.log('      soundOffDesign, etc.) will score lower because the reference');
  console.log('      analysis text is absent. This affects VIDEO format scores more');
  console.log('      than STATIC.');
  console.log('    - Core sub-scores (hookStopScroll, valueClarity, ctaClarity,');
  console.log('      trustProofStrength, audienceRelevance) work well because they');
  console.log('      score against Copy + Headline + Description text, which the');
  console.log('      Meta API does provide.');
  console.log('    - Strengths/weaknesses/improvements use generic fallback text');
  console.log('      instead of ad-specific human analysis.');
  console.log('');
  console.log('  Format detection:');
  console.log('    - The Meta API does not return media_type in response fields.');
  console.log('    - You can filter by media_type=IMAGE or media_type=VIDEO in the');
  console.log('      request params. This means format is known at query time, not');
  console.log('      per-record. Two queries (one IMAGE, one VIDEO) would give us');
  console.log('      reliable format separation.');
  console.log('');
  console.log('  Blockers for production:');
  console.log('    1. META_ADLIB_TOKEN required — needs Meta developer app + ads_read');
  console.log('    2. Token expiry — short-lived tokens last ~1–2 hours');
  console.log('    3. Rate limits — 200 calls/hour for standard access');
  console.log('    4. No media_type per record — need separate IMAGE/VIDEO queries');
  console.log('    5. page_name is advertiser name, not product name — may need');
  console.log('       manual mapping or heuristic to extract product from Copy');
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('\n❌ Spike failed:', redactToken(message));
  process.exit(1);
});
