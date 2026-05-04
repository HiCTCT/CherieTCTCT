import { redactToken, safeLog } from '@/lib/providers/meta/redact';
import type { MetaAdRecord, MetaApiResponse, MetaFetchConfig } from '@/lib/providers/meta/types';

const META_API_BASE = 'https://graph.facebook.com/v25.0/ads_archive';

const FIELDS = [
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
].join(',');

// ─── Simulation data ──────────────────────────────────────────────────────────

/**
 * Realistic mock records that prove the normalise → analyse pipeline
 * without a real Meta API call. One STATIC-shaped and one VIDEO-shaped
 * record included so the dry-run covers both analytical paths.
 *
 * These are NOT real ads. Field shapes mirror real Meta API responses.
 */
function getSimulatedRecords(): MetaAdRecord[] {
  return [
    {
      id: 'sim-001',
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
      id: 'sim-002',
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
      id: 'sim-003',
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

// ─── Live fetch ───────────────────────────────────────────────────────────────

async function fetchFromApi(config: MetaFetchConfig): Promise<MetaAdRecord[]> {
  const params = new URLSearchParams({
    search_terms: config.searchTerms,
    ad_reached_countries: `['${config.countries.join("','")}']`,
    ad_active_status: config.adActiveStatus,
    fields: FIELDS,
    limit: String(config.limit),
    access_token: config.token!, // present — checked before calling this function
  });

  // Log the request without the token in the URL
  const safeDisplayUrl = `${META_API_BASE}?search_terms=${encodeURIComponent(config.searchTerms)}&ad_reached_countries=...&fields=...&limit=${config.limit}&access_token=REDACTED`;
  console.log(`\n  Fetching from Meta Ad Library API...`);
  console.log(`  Search terms:  ${config.searchTerms}`);
  console.log(`  Countries:     ${config.countries.join(', ')}`);
  console.log(`  Active status: ${config.adActiveStatus}`);
  console.log(`  Limit:         ${config.limit}`);
  console.log(`  URL:           ${safeDisplayUrl}`);

  const fullUrl = `${META_API_BASE}?${params.toString()}`;
  const response = await fetch(fullUrl);
  const json = (await response.json()) as MetaApiResponse;

  if (json.error) {
    // Redact token from error messages before throwing
    const safeMessage = redactToken(
      `Meta API error (code ${json.error.code}): ${json.error.message}`,
    );
    throw new Error(safeMessage);
  }

  if (!json.data || json.data.length === 0) {
    throw new Error('Meta API returned no ads for this search. Try a different search_terms or country.');
  }

  console.log(`  ✓ Received ${json.data.length} ad(s)`);

  // paging.next is a token-bearing URL — log only whether pagination exists,
  // never the URL itself. Step 1 does not follow pagination.
  if (json.paging?.next) {
    console.log(`  ℹ  Pagination available — not followed in Step 1 (single page only)`);
  }

  return json.data;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetches ads from the Meta Ad Library API, or returns simulation data if
 * no token is configured or simulation mode is explicitly set.
 *
 * Token safety:
 *  - The token never appears in log output
 *  - Error messages are redacted before throwing
 *  - paging.next is consumed internally and never logged
 *  - ad_snapshot_url values are logged via safeLog() in the calling script
 */
export async function fetchMetaAds(config: MetaFetchConfig): Promise<MetaAdRecord[]> {
  const isSimulation = config.simulationMode || !config.token;

  if (isSimulation) {
    const records = getSimulatedRecords();
    console.log(`\n  Mode: SIMULATION (META_ADLIB_TOKEN not set)`);
    console.log(`  Returning ${records.length} mock record(s)`);
    console.log(`  ⚠  This proves normalise → analyse pipeline only.`);
    console.log(`     Set META_ADLIB_TOKEN to test real API fetch.`);
    return records;
  }

  console.log(`\n  Mode: LIVE API FETCH (META_ADLIB_TOKEN detected)`);
  return fetchFromApi(config);
}

// ─── Config builder ───────────────────────────────────────────────────────────

/**
 * Builds MetaFetchConfig from environment variables.
 * All values have safe defaults so the dry-run works with no env vars set.
 *
 * Environment variables:
 *   META_ADLIB_TOKEN    — access token (absent = simulation mode)
 *   META_SEARCH_TERMS   — keyword(s) passed to search_terms (default: 'skincare')
 *   META_COUNTRIES      — comma-separated ISO codes (default: 'SG')
 *   META_FETCH_LIMIT    — number of ads to fetch (default: 5, max: 25)
 *   META_AD_FORMAT      — 'STATIC' or 'VIDEO' (default: 'STATIC')
 *   META_SIMULATION_MODE — 'true' forces simulation even if token is set
 */
export function buildConfigFromEnv(): MetaFetchConfig {
  const token = process.env.META_ADLIB_TOKEN || undefined;
  const searchTerms = process.env.META_SEARCH_TERMS ?? 'skincare';
  const countries = (process.env.META_COUNTRIES ?? 'SG')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const limit = Math.min(
    parseInt(process.env.META_FETCH_LIMIT ?? '5', 10) || 5,
    25,
  );
  const rawFormat = (process.env.META_AD_FORMAT ?? 'STATIC').toUpperCase();
  const format = rawFormat === 'VIDEO' ? 'VIDEO' : 'STATIC';
  const simulationMode = process.env.META_SIMULATION_MODE === 'true';

  return {
    token,
    searchTerms,
    countries,
    adActiveStatus: 'ALL',
    limit,
    format,
    simulationMode,
  };
}
