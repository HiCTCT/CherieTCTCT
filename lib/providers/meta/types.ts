import type { AdFormat } from '@/lib/analysis/types';

/**
 * Raw shape of a single ad record returned by the Meta Ad Library API.
 * Fields map to what `GET /v25.0/ads_archive` returns for the field list
 * used in this project.
 */
export type MetaAdRecord = {
  id?: string;
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

/**
 * Outer envelope returned by the Meta Ad Library API.
 */
export type MetaApiResponse = {
  data: MetaAdRecord[];
  paging?: {
    cursors?: {
      before?: string;
      after?: string;
    };
    next?: string; // token-bearing URL — never logged raw
  };
  error?: {
    message: string;
    type?: string;
    code: number;
    fbtrace_id?: string;
  };
};

/**
 * Runtime configuration for the Meta fetch client.
 * Built from environment variables — never hardcoded.
 */
export type MetaFetchConfig = {
  /** META_ADLIB_TOKEN — absent or empty triggers simulation mode */
  token: string | undefined;
  /** search_terms passed to the API */
  searchTerms: string;
  /** search_page_ids passed to the API, usually from Competitor.metaPageId */
  searchPageIds?: string[];
  /** ISO country codes, e.g. ['SG'] */
  countries: string[];
  /** ad_active_status — 'ALL' | 'ACTIVE' | 'INACTIVE' */
  adActiveStatus: 'ALL' | 'ACTIVE' | 'INACTIVE';
  /** Number of ads to fetch per request */
  limit: number;
  /** Format used for the whole run — known at query time, not per-record */
  format: AdFormat;
  /** When true or token is absent, returns mock data without a network call */
  simulationMode: boolean;
};
