import { redactToken } from '@/lib/providers/meta/redact';
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

function filterSimulatedRecords(records: MetaAdRecord[], config: MetaFetchConfig): MetaAdRecord[] {
  if (!config.searchPageIds || config.searchPageIds.length === 0) return records;

  const pageIdSet = new Set(config.searchPageIds);
  const filtered = records.filter((record) => record.page_id && pageIdSet.has(record.page_id));

  if (filtered.length === 0) {
    console.log(`  Simulation note: no mock ads found for page ID(s): ${config.searchPageIds.join(', ')}`);
  }

  return filtered;
}

function serialisePageIdsForGraphApi(pageIds: string[]): string {
  return `[${pageIds.join(',')}]`;
}

// ─── Live fetch ───────────────────────────────────────────────────────────────

async function fetchFromApi(config: MetaFetchConfig): Promise<MetaAdRecord[]> {
  const params = new URLSearchParams({
    search_terms: config.searchTerms,
    ad_reached_countries: `['${config.countries.join("','")}']`,
    ad_active_status: config.adActiveStatus,
    fields: FIELDS,
    limit: String(config.limit),
    access_token: config.token!,
  });

  if (config.searchPageIds && config.searchPageIds.length > 0) {
    params.set('search_page_ids', serialisePageIdsForGraphApi(config.searchPageIds));
  }

  const safeDisplayUrl = `${META_API_BASE}?search_terms=${encodeURIComponent(config.searchTerms)}&search_page_ids=${config.searchPageIds ? serialisePageIdsForGraphApi(config.searchPageIds) : ''}&ad_reached_countries=...&fields=...&limit=${config.limit}&access_token=REDACTED`;
  console.log('\n  Fetching from Meta Ad Library API...');
  console.log(`  Search terms:  ${config.searchTerms || '(empty)'}`);
  console.log(`  Page IDs:      ${config.searchPageIds?.join(', ') ?? '(not set)'}`);
  console.log(`  Countries:     ${config.countries.join(', ')}`);
  console.log(`  Active status: ${config.adActiveStatus}`);
  console.log(`  Limit:         ${config.limit}`);
  console.log(`  URL:           ${safeDisplayUrl}`);

  const fullUrl = `${META_API_BASE}?${params.toString()}`;
  const response = await fetch(fullUrl);
  const json = (await response.json()) as MetaApiResponse;

  if (json.error) {
    const safeMessage = redactToken(
      `Meta API error (code ${json.error.code}): ${json.error.message}`,
    );
    throw new Error(safeMessage);
  }

  if (!json.data || json.data.length === 0) {
    throw new Error('Meta API returned no ads for this page ID or search. Try a different Meta Page ID, search_terms, or country.');
  }

  console.log(`  ✓ Received ${json.data.length} ad(s)`);

  if (json.paging?.next) {
    console.log('  ℹ  Pagination available — not followed in this step (single page only)');
  }

  return json.data;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchMetaAds(config: MetaFetchConfig): Promise<MetaAdRecord[]> {
  const isSimulation = config.simulationMode || !config.token;

  if (isSimulation) {
    const records = filterSimulatedRecords(getSimulatedRecords(), config);
    console.log('\n  Mode: SIMULATION (META_ADLIB_TOKEN not set)');
    console.log(`  Page IDs: ${config.searchPageIds?.join(', ') ?? '(not set)'}`);
    console.log(`  Returning ${records.length} mock record(s)`);
    console.log('  ⚠  This proves normalise → analyse pipeline only.');
    console.log('     Set META_ADLIB_TOKEN to test real API fetch.');
    return records;
  }

  console.log('\n  Mode: LIVE API FETCH (META_ADLIB_TOKEN detected)');
  return fetchFromApi(config);
}

// ─── Config builder ───────────────────────────────────────────────────────────

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
  const searchPageIds = (process.env.META_PAGE_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  return {
    token,
    searchTerms,
    searchPageIds: searchPageIds.length > 0 ? searchPageIds : undefined,
    countries,
    adActiveStatus: 'ALL',
    limit,
    format,
    simulationMode,
  };
}
