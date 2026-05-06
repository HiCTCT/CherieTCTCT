import { redactToken } from '@/lib/providers/meta/redact';
import type { MetaAdRecord, MetaApiResponse, MetaFetchConfig } from '@/lib/providers/meta/types';

const META_API_BASE = 'https://graph.facebook.com/v25.0/ads_archive';
const META_API_MAX_PAGE_SIZE = 25;
const PAGE_SAFETY_CAP = 10;

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

function getSimulatedImageRecords(): MetaAdRecord[] {
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
      page_id: '100001234567890',
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
  ];
}

function getSimulatedVideoRecords(): MetaAdRecord[] {
  return [
    {
      id: 'sim-003',
      page_name: 'The Ordinary SG',
      page_id: '100001234567890',
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

function getSimulatedRecords(config: MetaFetchConfig): MetaAdRecord[] {
  if (config.mediaType === 'IMAGE') return getSimulatedImageRecords();
  if (config.mediaType === 'VIDEO') return getSimulatedVideoRecords();
  return [...getSimulatedImageRecords(), ...getSimulatedVideoRecords()];
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

function buildBaseParams(config: MetaFetchConfig, pageSize: number): URLSearchParams {
  const params = new URLSearchParams({
    search_terms: config.searchTerms,
    ad_reached_countries: `['${config.countries.join("','")}']`,
    ad_active_status: config.adActiveStatus,
    fields: FIELDS,
    limit: String(pageSize),
    access_token: config.token!,
  });

  if (config.searchPageIds && config.searchPageIds.length > 0) {
    params.set('search_page_ids', serialisePageIdsForGraphApi(config.searchPageIds));
  }

  if (config.mediaType) {
    params.set('media_type', config.mediaType);
  }

  return params;
}

// ─── Live fetch ───────────────────────────────────────────────────────────────

async function fetchFromApi(config: MetaFetchConfig): Promise<MetaAdRecord[]> {
  const pageSize = Math.min(config.limit, META_API_MAX_PAGE_SIZE);
  const safeDisplayUrl = `${META_API_BASE}?search_terms=${encodeURIComponent(config.searchTerms)}&search_page_ids=${config.searchPageIds ? serialisePageIdsForGraphApi(config.searchPageIds) : ''}&media_type=${config.mediaType ?? ''}&ad_reached_countries=...&fields=...&limit=${pageSize}&access_token=REDACTED`;

  console.log('\n  Fetching from Meta Ad Library API...');
  console.log(`  Search terms:  ${config.searchTerms || '(empty)'}`);
  console.log(`  Page IDs:      ${config.searchPageIds?.join(', ') ?? '(not set)'}`);
  console.log(`  Media type:    ${config.mediaType ?? '(not set)'}`);
  console.log(`  Countries:     ${config.countries.join(', ')}`);
  console.log(`  Active status: ${config.adActiveStatus}`);
  console.log(`  Total limit:   ${config.limit}`);
  console.log(`  Page size:     ${pageSize}`);
  console.log(`  URL:           ${safeDisplayUrl}`);

  const collected: MetaAdRecord[] = [];
  let afterCursor: string | undefined;
  let pageNum = 0;
  let stopReason = 'no next page';

  while (pageNum < PAGE_SAFETY_CAP && collected.length < config.limit) {
    pageNum++;

    const params = buildBaseParams(config, pageSize);
    if (afterCursor) {
      params.set('after', afterCursor);
    }

    const fullUrl = `${META_API_BASE}?${params.toString()}`;
    const response = await fetch(fullUrl);
    const json = (await response.json()) as MetaApiResponse;

    if (json.error) {
      const safeMessage = redactToken(
        `Meta API error (code ${json.error.code}): ${json.error.message}`,
      );
      throw new Error(safeMessage);
    }

    const pageRecords = json.data ?? [];
    console.log(`  Page ${pageNum}: received ${pageRecords.length} ad(s)`);

    if (pageRecords.length === 0) {
      stopReason = 'page returned 0 ads';
      break;
    }

    collected.push(...pageRecords);

    if (collected.length >= config.limit) {
      stopReason = 'limit reached';
      break;
    }

    const hasNextPage = Boolean(json.paging?.next);
    const nextCursor = json.paging?.cursors?.after;

    if (!hasNextPage || !nextCursor) {
      stopReason = 'no next page';
      break;
    }

    afterCursor = nextCursor;
  }

  if (pageNum >= PAGE_SAFETY_CAP && collected.length < config.limit) {
    stopReason = `safety cap reached (${PAGE_SAFETY_CAP} pages)`;
  }

  const result = collected.slice(0, config.limit);

  if (result.length === 0) {
    console.log('  No ads returned for this media type and page ID.');
  }

  console.log(`  Pagination stopped: ${stopReason}`);
  console.log(`  Total collected: ${result.length} ad(s)`);

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchMetaAds(config: MetaFetchConfig): Promise<MetaAdRecord[]> {
  const isSimulation = config.simulationMode || !config.token;

  if (isSimulation) {
    const records = filterSimulatedRecords(getSimulatedRecords(config), config);
    console.log('\n  Mode: SIMULATION (META_ADLIB_TOKEN not set)');
    console.log(`  Page IDs: ${config.searchPageIds?.join(', ') ?? '(not set)'}`);
    console.log(`  Media type: ${config.mediaType ?? '(not set)'}`);
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
