/**
 * Create Browser-Collected CSV from a Meta Ad Library page  (Phase A)
 *
 * Front-of-pipeline automation: given ONE competitor's Meta Ad Library page
 * (URL or page ID), open it in Playwright, extract the active individual ad IDs,
 * attempt to extract ad copy / headline / landing, and write ONE browser-collected
 * CSV ready for the existing validate → capture → preview → ingest pipeline.
 *
 * It does NOT touch the DB, Prisma, schema, ingestion, scoring, preview, or UI.
 * It does NOT call Anthropic/Vision. It only reads the public Ad Library pages
 * and writes a CSV + a local extraction log. creative_asset_path is left out
 * (the capture script adds it later as the .with-assets.csv).
 *
 * Honesty rules: copy / headline / description / landing_page_url are never
 * invented. They are taken from the page text only; if not found they stay BLANK.
 * headline + landing_page_url are filtered against a Meta-owned / system / CDN
 * domain blocklist and a UI-label blocklist, so platform chrome (e.g.
 * "System status" → metastatus.com) is never captured as advertiser data.
 * media_type is best-effort; if uncertain it is UNKNOWN.
 *
 * collection_status = READY only when ALL of:
 *   - ad_id present
 *   - ad_library_url present
 *   - media_type known (IMAGE | VIDEO | CAROUSEL)
 *   - at least one of ad_copy / headline is non-empty
 * Otherwise collection_status = NEEDS_REVIEW (with a reason in notes + the log).
 *
 * Usage:
 *   set COMPETITOR_NAME=ORIGIN Exterminators
 *   set META_PAGE_ID=193665894008173        (or META_AD_LIBRARY_URL=...)
 *   set OUTPUT_FILE=data/imports/rentokil-origin-browser-collected-ads-pilot-01.csv
 *   set MAX_ADS=10
 *   set HEADLESS=false
 *   npm run browser:create-csv
 */

import * as fs from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

// ─── CSV schema (matches browser:validate / preview / ingest EXPECTED_HEADER) ──

const HEADER = [
  'collection_status', 'competitor_name', 'meta_page_id', 'ad_id', 'ad_library_url',
  'media_type', 'publisher_platforms', 'ad_delivery_start_time', 'ad_copy', 'headline',
  'description', 'landing_page_url', 'notes', 'visual_description', 'creative_notes',
] as const;

type Row = Record<(typeof HEADER)[number], string>;

function csvEscape(v: string): string {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function serializeCsv(rows: Row[]): string {
  const lines = [HEADER.join(',')];
  for (const r of rows) lines.push(HEADER.map((h) => csvEscape(r[h] ?? '')).join(','));
  return lines.join('\n') + '\n';
}

// ─── Config ─────────────────────────────────────────────────────────────────

const COMPETITOR_NAME = (process.env.COMPETITOR_NAME ?? '').trim();
const META_AD_LIBRARY_URL = (process.env.META_AD_LIBRARY_URL ?? '').trim();
const META_PAGE_ID_ENV = (process.env.META_PAGE_ID ?? '').trim();
const OUTPUT_FILE = (process.env.OUTPUT_FILE ?? '').trim();
const MAX_ADS = Math.max(1, parseInt(process.env.MAX_ADS ?? '10', 10) || 10);
const META_COUNTRY = (process.env.META_COUNTRY ?? 'SG').trim();
const HEADLESS = process.env.HEADLESS === 'true';
// DIAGNOSTIC ONLY, opt-in. When true, the run log additionally records the VALUES of five
// specific Meta-UI query parameters (see probeMetaUiParams). It does NOT change scope
// classification — it is a one-time Phase 0 measurement aid to inform a future explicit
// allowlist by parameter name AND exact value. OFF by default.
const PHASE0_SCOPE_PROBE = process.env.PHASE0_SCOPE_PROBE === 'true';

const NAV_TIMEOUT = 45_000;
const SETTLE = 2_500;
const SCROLL_PAUSE = 1_800;
const MAX_SCROLLS = 30;
const NO_GROWTH_LIMIT = 4;
const DETAIL_SETTLE = 2_000;
const ZERO_CARD_WAIT = 6_000;          // extra lazy-load wait before the 0-card reload
const ZERO_CARD_SIGNAL_TIMEOUT = 15_000; // wait for ad cards / no-active-ads state after reload

// ─── Phase 0 instrumentation (LOCAL ONLY) ────────────────────────────────────
//
// Phase 0 is hand-run, dry-run-only measurement. It writes a local discovery-run
// log next to the output CSV so we can judge whether the browser discovery
// workflow is reliable BEFORE any Phase 1 automation. It performs NO DB / Prisma
// writes, NO ingestion, NO Vision/API spend, and NEVER bypasses, solves, rotates
// proxies for, or otherwise evades a challenge / block. Bump the version whenever
// the discovery algorithm (scroll / stop / extraction logic) changes so logs from
// different runs stay comparable.
const DISCOVERY_ALGO_VERSION = 'phase0-2026-06-26.3';

// Exactly five discovery statuses. These describe how the DISCOVERY run went —
// they are NOT a count of a competitor's ads, and a non-successful status must
// NEVER be read as "this advertiser has zero ads" or used to mark prior ads
// inactive. Classification PRIORITY ORDER (a blocker ALWAYS wins over a generic
// failure), applied in classifyDiscovery:
//   1. BLOCKED_DISCOVERY     a challenge / login wall / CAPTCHA / rate-limit /
//                            security-check / unexpected interstitial was detected
//                            (matched signal recorded). Found IDs are preserved; the
//                            run is NOT treated as complete. Always wins.
//   2. FAILED_DISCOVERY      the listing never loaded OR an unexpected error threw,
//                            and zero Library IDs were collected.
//   3. PARTIAL_DISCOVERY     reaching the MAX_ADS cap (ALWAYS partial — a deliberate
//                            cap is never a complete count), OR some IDs found but the
//                            run did not finish cleanly (error after IDs, MAX_SCROLLS
//                            budget exhausted while still growing, no clean stop).
//   4. SUCCESSFUL_DISCOVERY  (a) non-empty: expected Meta Page ID + country/scope
//                            confirmed, no blocker, no error, NOT capped, stable
//                            no-growth completion via stop condition no_growth_limit; OR
//                            (b) confirmed no-active-ads: Meta's own explicit no-results
//                            text detected, zero IDs, scope confirmed, no blocker, no
//                            error, ended via stop condition confirmed_no_active_ads.
//   5. INCOMPLETE_DISCOVERY  zero IDs without the explicit no-active-ads evidence above
//                            (ambiguous — no clear ad-card or no-results signal).
type DiscoveryStatus =
  | 'SUCCESSFUL_DISCOVERY'
  | 'PARTIAL_DISCOVERY'
  | 'BLOCKED_DISCOVERY'
  | 'FAILED_DISCOVERY'
  | 'INCOMPLETE_DISCOVERY';

// Which stop condition ended the scroll loop. 'none' means the loop never ran or
// exited abnormally; 'max_scrolls_exhausted' means the budget ran out while the
// page may still have had more to load (not a clean stop).
type StopCondition =
  | 'no_growth_limit'
  | 'max_ads_cap'
  | 'max_scrolls_exhausted'
  | 'zero_cards'
  | 'confirmed_no_active_ads'
  | 'none';

type AdInfo = { mediaType: string; startDate: string; copy: string; headline: string; landing: string };

function parsePageIdFromUrl(url: string): string {
  const m = url.match(/[?&]view_all_page_id=([0-9]+)/);
  return m ? m[1]! : '';
}

const EXPECTED_ACTIVE_STATUS = 'active';   // canonical Phase 0 browser scope
const EXPECTED_AD_TYPE = 'all';            // canonical Phase 0 browser scope
// Required canonical params + the explicit narrowing denylist. There is NO name-only
// "harmless" allowlist — anything not required and not a value-matched UI default (below) is
// unexpected and fails closed.
const SCOPE_EXPECTED_PARAMS = ['active_status', 'ad_type', 'country', 'view_all_page_id'];
const SCOPE_NARROWING_PARAMS = ['q', 'search_terms', 'start_date', 'end_date', 'publisher_platforms'];
// Optional Meta Ad Library UI-default parameters: allowed ONLY when present EXACTLY ONCE and
// equal to the ONE approved value below (observed in a controlled HipVan scope probe). No other
// value of these names is permitted; absent is fine. This is an exact-value allowlist, never a
// name-only whitelist.
const SCOPE_UI_DEFAULTS: { [k: string]: string } = {
  'media_type': 'all',
  'search_type': 'page',
  'is_targeted_country': 'false',
  'sort_data[mode]': 'total_impressions',
  'sort_data[direction]': 'desc',
};

// Parse the FINAL resolved Ad Library URL for fail-closed FULL-scope proof. Returns whether
// the URL is on the /ads/library surface, its resolved page id / country / active_status /
// ad_type, and the NAMES (never values) of any narrowing or unknown query parameters.
function parseUrlScope(rawUrl: string): {
  onLibrary: boolean; pageId: string; country: string; activeStatus: string; adType: string;
  missingParams: string[]; duplicateParams: string[];
  allowedUiDefaults: string[]; noncanonicalUiParams: string[]; duplicateUiParams: string[];
  narrowingParams: string[]; unexpectedParams: string[];
} {
  let onLibrary = false; let pageId = ''; let country = ''; let activeStatus = ''; let adType = '';
  const missingParams: string[] = []; const duplicateParams: string[] = [];
  const allowedUiDefaults: string[] = []; const noncanonicalUiParams: string[] = []; const duplicateUiParams: string[] = [];
  const narrowingParams: string[] = []; const unexpectedParams: string[] = [];
  try {
    const u = new URL(rawUrl);
    // Pathname must be EXACTLY the Ad Library path — never a regex/substring/contains test,
    // so nested or extended paths that merely contain "/ads/library" are rejected.
    const exactLibraryPath =
      u.pathname === '/ads/library' ||
      u.pathname === '/ads/library/';
    onLibrary = /(^|\.)facebook\.com$/i.test(u.hostname) && exactLibraryPath === true;
    // Each REQUIRED canonical param must appear EXACTLY ONCE. getAll() detects duplicates;
    // a missing OR duplicated required param fails scope proof. Only NAMES are recorded.
    const REQUIRED = ['view_all_page_id', 'country', 'active_status', 'ad_type'];
    for (const k of REQUIRED) {
      const vals = u.searchParams.getAll(k);
      if (vals.length === 0) missingParams.push(k);
      else if (vals.length > 1) duplicateParams.push(k);
    }
    pageId = u.searchParams.get('view_all_page_id') || '';
    country = u.searchParams.get('country') || '';
    activeStatus = (u.searchParams.get('active_status') || '').toLowerCase();
    adType = (u.searchParams.get('ad_type') || '').toLowerCase();
    // Optional UI-default params: present → must appear EXACTLY ONCE and equal the ONE approved
    // value. Duplicate → fail; wrong/malformed value → fail; absent → fine.
    for (const name of Object.keys(SCOPE_UI_DEFAULTS)) {
      const vals = u.searchParams.getAll(name);
      if (vals.length === 0) continue;
      if (vals.length > 1) { duplicateUiParams.push(name); continue; }
      if (vals[0] === SCOPE_UI_DEFAULTS[name]) allowedUiDefaults.push(name);
      else noncanonicalUiParams.push(name);
    }
    // Classify every other key. Required params handled above; approved UI-default names are
    // value-checked above; a known narrowing param fails; ANYTHING else is unexpected.
    for (const k of Array.from(u.searchParams.keys())) {
      if (SCOPE_EXPECTED_PARAMS.indexOf(k) >= 0) continue;
      if (Object.prototype.hasOwnProperty.call(SCOPE_UI_DEFAULTS, k)) continue;
      if (SCOPE_NARROWING_PARAMS.indexOf(k) >= 0) { if (narrowingParams.indexOf(k) < 0) narrowingParams.push(k); }
      else if (unexpectedParams.indexOf(k) < 0) unexpectedParams.push(k);
    }
  } catch { /* malformed URL → fail closed */ }
  return { onLibrary, pageId, country, activeStatus, adType, missingParams, duplicateParams, allowedUiDefaults, noncanonicalUiParams, duplicateUiParams, narrowingParams, unexpectedParams };
}

// DIAGNOSTIC ONLY (opt-in via PHASE0_SCOPE_PROBE=true). For the FIVE specific Meta-UI
// parameter names ONLY, record each PRESENT param's name, occurrence count, and value(s) —
// but a value is kept ONLY when it matches ^[A-Za-z0-9_-]{1,80}$, otherwise it is recorded as
// "[redacted]". It never inspects or returns any other parameter, the full URL, tokens,
// redirects, or any free-text URL. This is a one-time measurement aid used to establish a
// future explicit allowlist by parameter name AND exact value; it does NOT change
// scope_confirmed, unexpected_scope_params, or any discovery status.
const SCOPE_PROBE_PARAM_NAMES = ['media_type', 'search_type', 'is_targeted_country', 'sort_data[mode]', 'sort_data[direction]'];
function probeMetaUiParams(rawUrl: string): { name: string; count: number; values: string[] }[] {
  const out: { name: string; count: number; values: string[] }[] = [];
  const SAFE_VALUE = /^[A-Za-z0-9_-]{1,80}$/;
  try {
    const u = new URL(rawUrl);
    for (const name of SCOPE_PROBE_PARAM_NAMES) {
      const vals = u.searchParams.getAll(name);
      if (vals.length === 0) continue;
      out.push({ name, count: vals.length, values: vals.map((v) => (SAFE_VALUE.test(v) ? v : '[redacted]')) });
    }
  } catch { /* malformed URL → record nothing */ }
  return out;
}

// One shared URL sanitiser. Returns origin + /pathname + ONLY the safe scope params. Used for
// every URL-bearing log field so token-like or redirect parameters can never be stored.
const SAFE_SCOPE_PARAMS = ['active_status', 'ad_type', 'country', 'view_all_page_id'];
function sanitizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const safe = new URLSearchParams();
    for (const k of SAFE_SCOPE_PARAMS) { const v = u.searchParams.get(k); if (v !== null) safe.set(k, v); }
    const qs = safe.toString();
    return u.origin + u.pathname + (qs ? `?${qs}` : '');
  } catch { return '(unparseable url removed)'; }
}
// Replace every http(s) URL inside arbitrary text with its sanitised form (drops query
// secrets / redirect params). Use for error summaries and any free-text log field.
function scrubUrls(text: string): string {
  // Aggressively strip URL-like fragments from FREE TEXT so query strings / token or
  // redirect parameters can never be retained. Each match becomes "[URL removed]".
  // sanitizeUrl() remains the single canonical formatter for STRUCTURED fields (input_url).
  return (text || '')
    .replace(/https?:\/\/[^\s'"`]+/gi, '[URL removed]')                                   // absolute http(s) URLs
    .replace(/\bwww\.[^\s'"`]+/gi, '[URL removed]')                                        // scheme-less www. URLs
    .replace(/\/[^\s'"`]*\?[^\s'"`]+/g, '[URL removed]')                                   // relative path with a query string
    .replace(/[^\s'"`]*[?&](?:access_token|token|fbclid|u|next|redirect|__tn__)=[^\s'"`]*/gi, '[URL removed]'); // redirect/token-bearing fragment
}

// ─── Phase 0: conservative challenge / block detector ─────────────────────────
//
// Reads the page's visible text and the URL and looks for clear signals that Meta
// is showing a login wall, CAPTCHA, security check, rate-limit / throttle notice,
// or an unexpected interstitial instead of the Ad Library listing. It is
// deliberately conservative (text-signal only) and NEVER attempts to bypass,
// solve, dismiss-by-force, rotate proxies, or evade — it only reports the first
// matched signal so the run can be classified BLOCKED / PARTIAL and the operator
// can decide what to do. Returns { blocked, signal } where signal is '' when none.
async function detectChallengeSignal(page: Page): Promise<{ blocked: boolean; signal: string }> {
  let bodyText = '';
  let currentUrl = '';
  try {
    bodyText = await page.evaluate(() => (document.body ? document.body.innerText : ''));
    currentUrl = page.url();
  } catch {
    return { blocked: false, signal: '' };
  }
  const t = (bodyText || '').slice(0, 20_000); // cap — only need leading text
  // URL-level signals: redirected to a login / checkpoint / challenge surface.
  const urlSignals: [RegExp, string][] = [
    [/\/login\b|\/login\.php|login\/\?/i, 'redirected to a login URL'],
    [/\/checkpoint\//i, 'redirected to a Meta checkpoint URL'],
    [/\/challenge\//i, 'redirected to a challenge URL'],
  ];
  for (const [re, label] of urlSignals) {
    if (re.test(currentUrl)) return { blocked: true, signal: label };  // label only — never the raw redirected URL
  }
  // Text-level signals. Each entry is [regex, human label].
  const textSignals: [RegExp, string][] = [
    [/log in to continue|you must log in|please log ?in to continue/i, 'login wall text'],
    [/enter your (email|phone)[^.]{0,40}\bpassword/i, 'login form prompt'],
    [/confirm (it'?s )?you'?re (a human|not a robot)|i'?m not a robot|are you a robot/i, 'CAPTCHA / human-check text'],
    [/complete (a )?security check|security check required|let'?s confirm/i, 'security check text'],
    [/captcha/i, 'CAPTCHA keyword'],
    [/you'?re temporarily blocked|temporarily blocked|you'?ve been blocked/i, 'temporary-block text'],
    [/too many requests|you'?re doing that too (much|often)|try again later|rate ?limit/i, 'rate-limit / throttle text'],
    [/unusual (traffic|activity)|suspicious activity|automated behaviou?r/i, 'unusual-activity text'],
    [/this content (isn'?t|is not) available right now|something went wrong/i, 'unexpected interstitial text'],
  ];
  for (const [re, label] of textSignals) {
    if (re.test(t)) return { blocked: true, signal: label };
  }
  return { blocked: false, signal: '' };
}

// ─── Phase 0: confirmed no-active-ads detector ────────────────────────────────
//
// Reads the page's visible text for Meta's OWN explicit "no active ads / no results"
// statement for this advertiser. This explicit page state is the ONLY evidence that lets
// a zero-ID run be classified SUCCESSFUL_DISCOVERY (via stop condition
// confirmed_no_active_ads); without it, zero IDs stay INCOMPLETE_DISCOVERY. Read-only and
// never bypasses anything.
async function detectNoActiveAds(page: Page): Promise<{ proven: boolean; phrase: string; tag: string; bbox: { x: number; y: number; width: number; height: number } | null; signal: string }> {
  try {
    return await page.evaluate(() => {
      // NARROW + AUDITABLE: require a VISIBLE element whose own direct text specifically
      // states that THIS PAGE / ADVERTISER is not running ads. Generic "no ads match",
      // "no ads found", "no ads to show", "no results found for this search", bare
      // "0 results" / "no results" are deliberately EXCLUDED.
      const phrases = [
        "this page isn't running ads", 'this page is not running ads',
        "this advertiser isn't running ads", 'this advertiser is not running ads',
      ];
      for (const el of Array.from(document.querySelectorAll('div, span'))) {
        let direct = '';
        for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) direct += n.textContent || '';
        direct = direct.replace(/\s+/g, ' ').trim();
        if (!direct || direct.length > 200) continue;
        const low = direct.toLowerCase().replace(/[‘’]/g, "'");   // normalise curly apostrophes
        let matched = '';
        for (const p of phrases) if (low.indexOf(p) >= 0) { matched = p; break; }
        if (!matched) continue;
        // non-zero box required
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        // visibility walk: the element AND every ancestor to the document root must be visible
        let node: Element | null = el;
        let hidden = false;
        while (node) {
          if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') { hidden = true; break; }
          const cs = window.getComputedStyle(node);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.opacity || '1') === 0)) { hidden = true; break; }
          node = node.parentElement;
        }
        if (hidden) continue;
        // Store ONLY the matched approved phrase + tag + box — never arbitrary page text.
        return { proven: true, phrase: matched, tag: el.tagName.toLowerCase(), bbox: { x: r.x, y: r.y, width: r.width, height: r.height }, signal: 'visible explicit Meta page/advertiser no-active-ads statement: "' + matched + '"' };
      }
      return { proven: false, phrase: '', tag: '', bbox: null, signal: 'no visible explicit page/advertiser no-active-ads statement found' };
    });
  } catch {
    return { proven: false, phrase: '', tag: '', bbox: null, signal: 'no-active-ads detector error' };
  }
}

// ─── Phase 0: discovery-run-log shape + classifier + writer ───────────────────

type DiscoveryRunLog = {
  schema: 'browser-discovery-run-log/phase0';
  algo_version: string;
  // identity / inputs
  competitor_name: string;
  meta_page_id: string;
  meta_country: string;
  input_url: string;
  output_csv_path: string;
  configured_max_ads: number;
  // timing (ISO + ms)
  started_at: string;
  completed_at: string;
  total_duration_ms: number;
  nav_duration_ms: number | null;
  time_to_first_id_ms: number | null;
  // scroll / stop evidence
  scroll_cycles_attempted: number;
  no_growth_cycles_reached: number;
  no_growth_limit: number;
  ids_per_scroll_cycle: number[];
  stop_condition: StopCondition;
  stop_condition_reached: boolean;
  stop_condition_note: string;
  // results (NOT an inventory count — discovery only)
  discovered_library_id_count: number;
  output_row_count: number;
  collection_status_counts: { READY: number; NEEDS_REVIEW: number };
  ready_count: number;
  needs_review_count: number;
  source_csv_bytes: number | null;
  // health
  discovery_status: DiscoveryStatus;
  capped: boolean;                      // MAX_ADS cap hit — always implies PARTIAL, never complete
  no_active_ads_proven: boolean;        // a VISIBLE explicit Meta no-active-ads statement was detected
  no_active_ads_signal: string;         // short audit signal (matched phrase / element) for that proof
  scope_confirmed: boolean;             // proven from the FINAL resolved Ad Library URL (not env/input)
  expected_page_id: string;             // the requested META_PAGE_ID
  observed_page_id: string;             // view_all_page_id parsed from the final resolved URL
  expected_country: string;             // the requested META_COUNTRY
  observed_country: string;             // country parsed from the final resolved URL
  expected_active_status: string;       // canonical Phase 0 active_status ('active')
  observed_active_status: string;       // active_status parsed from the final resolved URL
  expected_ad_type: string;             // canonical Phase 0 ad_type ('all')
  observed_ad_type: string;             // ad_type parsed from the final resolved URL
  unexpected_scope_params: string[];    // NAMES of narrowing/unknown params (never values)
  duplicate_scope_params: string[];     // NAMES of required params appearing >1 time (never values)
  allowed_meta_ui_defaults_present: string[]; // NAMES of approved UI-default params present (value-matched; never values)
  noncanonical_meta_ui_params: string[];      // NAMES of UI-default params present with a non-approved value (never values)
  duplicate_meta_ui_params: string[];         // NAMES of UI-default params present >1 time (never values)
  observed_meta_ui_param_values?: { name: string; count: number; values: string[] }[]; // diagnostic only (PHASE0_SCOPE_PROBE); omitted otherwise
  scope_confirmation_reason: string;    // human-readable scope-proof reason (no token-bearing URL)
  challenge_detected: boolean;
  challenge_signal: string;
  error_summary: string;
  // honesty guard
  notes: string;
};

// Classify the discovery run from collected evidence. Priority order matters; see
// the DiscoveryStatus comment for the rules. Returns the status only.
function classifyDiscovery(ev: {
  pageLoaded: boolean;
  scopeConfirmed: boolean;
  discoveredCount: number;
  challengeDetected: boolean;
  errorOccurred: boolean;
  capped: boolean;
  noActiveAdsProven: boolean;
  stopCondition: StopCondition;
  stopConditionReached: boolean;
}): DiscoveryStatus {
  // Priority order: 1 BLOCKED, 2 FAILED, 3 PARTIAL, 4 SUCCESSFUL, 5 INCOMPLETE.
  // A blocker/challenge ALWAYS wins over a generic failure.

  // 1. Blocker / challenge detected anywhere — preserve IDs, never call complete.
  if (ev.challengeDetected) return 'BLOCKED_DISCOVERY';
  // 2. Hard failure: the listing never loaded OR an unexpected error threw, with zero IDs.
  if ((!ev.pageLoaded || ev.errorOccurred) && ev.discoveredCount === 0) return 'FAILED_DISCOVERY';
  // 3a. MAX_ADS cap is ALWAYS partial — a deliberate cap is never a complete enumeration.
  if (ev.capped || ev.stopCondition === 'max_ads_cap') return 'PARTIAL_DISCOVERY';
  // 3b. Some IDs but the run did not finish cleanly (error after IDs, scroll budget
  //     exhausted while still growing, or no defined stop condition reached).
  if (ev.discoveredCount > 0 && (ev.errorOccurred || ev.stopCondition === 'max_scrolls_exhausted' || !ev.stopConditionReached)) {
    return 'PARTIAL_DISCOVERY';
  }
  // 4a. Successful NON-EMPTY: scope confirmed, no blocker/error, NOT capped, stable
  //     no-growth completion via stop condition no_growth_limit.
  if (ev.discoveredCount > 0 && ev.pageLoaded && ev.scopeConfirmed && !ev.challengeDetected &&
      !ev.errorOccurred && !ev.capped && ev.stopConditionReached && ev.stopCondition === 'no_growth_limit') {
    return 'SUCCESSFUL_DISCOVERY';
  }
  // 4b. Successful CONFIRMED NO-ACTIVE-ADS: explicit Meta no-results text, zero IDs, scope
  //     confirmed, no blocker/error, ended via confirmed_no_active_ads (no no-growth wait
  //     required after the explicit Meta result).
  if (ev.discoveredCount === 0 && ev.noActiveAdsProven && ev.pageLoaded && ev.scopeConfirmed &&
      !ev.challengeDetected && !ev.errorOccurred && ev.stopConditionReached &&
      ev.stopCondition === 'confirmed_no_active_ads') {
    return 'SUCCESSFUL_DISCOVERY';
  }
  // 5. Zero IDs without sufficient evidence → ambiguous / incomplete.
  if (ev.discoveredCount === 0) return 'INCOMPLETE_DISCOVERY';
  // Fallback: had IDs but no clean stop condition → partial, never "successful".
  return 'PARTIAL_DISCOVERY';
}

/**
 * Normalise a raw headline scraped from a Meta ad-preview link. Meta renders the
 * display URL, the headline, and the CTA button as ONE link, so the scraped text
 * comes back merged, e.g.:
 *   "WWW.WATELIER.COMExperience Refined Comfort in PersonBook now"
 * This strips a leading display-URL / domain and a trailing CTA-button label,
 * leaving only the real headline. Description is returned trimmed, never invented.
 */
function cleanMetaHeadlineText(rawHeadline: string, rawDescription?: string): { headline: string; description: string } {
  let h = (rawHeadline ?? '').replace(/\s+/g, ' ').trim();

  // 1. Strip a leading display URL / domain glued to the headline start.
  //    Handles "WWW.WATELIER.COM…", "https://www.x.com…", "X.COM.SG…", and the
  //    case where the real headline starts with a digit/symbol ("…COM30% Off…").
  //    The domain is matched case-insensitively, but we only strip when the char
  //    AFTER the TLD is NOT a lowercase letter — so a true TLD boundary (digit,
  //    symbol, uppercase, space, or end) is cut, while a longer word such as
  //    ".community" is left intact. The case-sensitive boundary check is done in
  //    code because `(?![a-z])` under the /i flag would also exclude uppercase.
  const domainMatch = h.match(/^\s*(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]*?\.(?:com\.sg|com|sg|org|net)/i);
  if (domainMatch) {
    const after = h.slice(domainMatch[0].length);
    if (after === '' || !/^[a-z]/.test(after)) {
      h = after.trim();
    }
  }

  // 2. Strip a trailing CTA-button label (multi-word labels checked first).
  const CTAS = [
    'Send message', 'Learn More', 'See details', 'Contact us', 'Get Quote',
    'Apply Now', 'Sign Up', 'Shop Now', 'Book now', 'Subscribe', 'Download', 'WhatsApp',
  ];
  for (const cta of CTAS) {
    const re = new RegExp('\\s*' + cta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i');
    if (re.test(h)) { h = h.replace(re, '').trim(); break; }
  }

  return { headline: h.replace(/\s+/g, ' ').trim(), description: (rawDescription ?? '').trim() };
}

async function dismissOverlays(page: Page): Promise<void> {
  const tryClick = async (selectors: string[]) => {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el && (await el.isVisible())) { await el.click(); await page.waitForTimeout(500); return; }
      } catch { /* ignore */ }
    }
  };
  await tryClick([
    '[data-testid="cookie-policy-manage-dialog-accept-button"]',
    'button:has-text("Allow all cookies")', 'button:has-text("Accept all")',
    'button:has-text("Accept All")', '[aria-label="Allow all cookies"]',
  ]);
  await tryClick(['[aria-label="Close"]', '[data-testid="dialog-close-button"]', 'div[role="dialog"] [aria-label="Close"]']);
}

/**
 * Harvest ad copy / headline / landing from the ad-card element that contains the
 * given Library ID. Used on both the listing page and the individual ad detail
 * page. Inline-only evaluate body (no named helpers) to avoid tsx/esbuild __name.
 * Returns blanks when nothing trustworthy is found — never invents text. Also
 * returns `rejected[]` describing any link/headline candidates filtered out, so
 * the caller can log them.
 */
async function harvestText(page: Page, id: string): Promise<{ copy: string; headline: string; landing: string; rejected: string[] }> {
  return await page.evaluate((adId) => {
    // Meta-owned / system / tracking / CDN domains — never advertiser landing pages.
    const blocked = [
      'facebook.com', 'fb.com', 'fb.me', 'meta.com', 'metastatus.com',
      'developers.facebook.com', 'business.facebook.com', 'm.facebook.com',
      'instagram.com', 'cdninstagram.com', 'cdninstagram', 'whatsapp.com',
      'messenger.com', 'fbcdn.net', 'fbcdn', 'oculus.com', 'threads.net',
    ];
    // UI-label link text that is platform chrome, not an ad headline.
    const uiLabels = [
      'system status', 'privacy policy', 'privacy', 'terms', 'cookies', 'cookie',
      'help', 'log in', 'login', 'sign up', 'signup', 'meta', 'facebook',
      'instagram', 'about', 'careers', 'ad choices', 'settings', 'more',
      'see more', 'learn more about', 'report ad',
    ];

    // Locate the card: smallest div containing exactly one "Library ID" and this id.
    let card: HTMLElement | null = null;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('div'))) {
      const tc = el.textContent || '';
      if (!tc.includes('Library ID') || !tc.includes(adId)) continue;
      if ((tc.match(/Library ID/g) || []).length !== 1) continue;
      card = el; // document order → outermost single-card container first
      break;
    }
    if (!card) return { copy: '', headline: '', landing: '', rejected: [] };

    const rejected: string[] = [];

    // Body copy = longest non-boilerplate own-text block in the card.
    let copy = '';
    for (const t of Array.from(card.querySelectorAll<HTMLElement>('div, span, p'))) {
      let direct = '';
      for (const n of Array.from(t.childNodes)) if (n.nodeType === 3) direct += n.textContent || '';
      direct = direct.replace(/\s+/g, ' ').trim();
      if (direct.length < 15) continue;
      const low = direct.toLowerCase();
      if (low.startsWith('library id')) continue;
      if (low.includes('started running on')) continue;
      if (low.includes('this ad has')) continue;
      if (low.includes('why am i seeing')) continue;
      if (low.includes('see ad details') || low.includes('see summary') || low.includes('drop-down')) continue;
      if (low.includes('open drop') || low.includes('ad library')) continue;
      if (low === 'sponsored' || low === 'active' || low === 'inactive') continue;
      if (/^\d+ (ad|result)/.test(low)) continue;
      if (direct.length > copy.length) copy = direct;
    }

    // Headline + landing = first CLEAN external link (non-Meta domain, non-UI text).
    let headline = '';
    let landing = '';
    for (const a of Array.from(card.querySelectorAll<HTMLAnchorElement>('a'))) {
      const href = a.getAttribute('href') || '';
      if (!href || href.startsWith('#')) continue;
      let target = href;
      const um = href.match(/[?&]u=([^&]+)/);
      if (um) { try { target = decodeURIComponent(um[1]!); } catch { /* keep raw */ } }
      if (!/^https?:\/\//.test(target)) continue;
      const tl = target.toLowerCase();
      let isBlocked = false;
      for (const d of blocked) if (tl.includes(d)) { isBlocked = true; break; }
      if (isBlocked) { rejected.push(`rejected landing candidate: ${target}, internal Meta/system domain`); continue; }
      const at = (a.textContent || '').replace(/\s+/g, ' ').trim();
      const atLow = at.toLowerCase();
      let isUi = false;
      for (const u of uiLabels) if (atLow === u || atLow.includes(u)) { isUi = true; break; }
      if (!landing) landing = target; // first clean advertiser-domain link
      if (isUi) {
        rejected.push(`rejected headline candidate: ${at || '(empty)'}, UI label`);
      } else if (!headline && at && at.length >= 3 && at.length <= 120 && atLow !== copy.toLowerCase() && !/^\d+$/.test(at)) {
        headline = at; // skip numeric-only anchor text (post/video IDs) — keep looking for the real title
      }
      if (landing && headline) break;
    }

    return { copy, headline, landing, rejected };
  }, id);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const LINE = '═'.repeat(64);
  console.log(`\n${LINE}`);
  console.log('  create-browser-ads-csv-from-meta-page (Phase A)');
  console.log(LINE);

  const errors: string[] = [];
  if (!COMPETITOR_NAME) errors.push('COMPETITOR_NAME is required.');
  if (!OUTPUT_FILE) errors.push('OUTPUT_FILE is required.');
  if (!META_AD_LIBRARY_URL && !META_PAGE_ID_ENV) errors.push('Provide META_AD_LIBRARY_URL or META_PAGE_ID.');
  if (errors.length) { console.error('\n❌ ' + errors.join('\n   ')); process.exit(1); }

  const pageId = META_PAGE_ID_ENV || parsePageIdFromUrl(META_AD_LIBRARY_URL);
  const url =
    META_AD_LIBRARY_URL ||
    `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${encodeURIComponent(META_COUNTRY)}&view_all_page_id=${pageId}`;

  const outPath = path.resolve(OUTPUT_FILE);
  const logPath = `${outPath.replace(/\.csv$/i, '')}.extraction-log.txt`;
  const log: string[] = [];
  const note = (m: string) => { log.push(m); console.log('  ' + m); };

  note(`Competitor:   ${COMPETITOR_NAME}`);
  note(`Page ID:      ${pageId || '(not found in URL — set META_PAGE_ID)'}`);
  note(`Source URL:   ${url}`);
  note(`Output CSV:   ${outPath}`);
  note(`Max ads:      ${MAX_ADS}`);
  note(`Mode:         ${HEADLESS ? 'headless' : 'headful'}`);
  console.log(LINE);

  const browser: Browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  const ads = new Map<string, AdInfo>();

  // ── Phase 0 measurement trackers (local only) ──
  const startedAt = new Date();
  const startedAtMs = Date.now();
  let navDurationMs: number | null = null;
  let firstIdAtMs: number | null = null;       // ms from start to first Library ID
  let scrollCyclesAttempted = 0;
  let noGrowthFinal = 0;
  const idsPerCycle: number[] = [];
  let stopCondition: StopCondition = 'none';
  let stopConditionReached = false;
  let stopConditionNote = '';
  let pageLoaded = false;
  let challengeDetected = false;
  let challengeSignal = '';
  let errorSummary = '';
  let capped = false;                 // true once the MAX_ADS cap is hit (always → PARTIAL)
  let noActiveAdsProven = false;      // true only when Meta's explicit no-active-results text is detected
  let scopeConfirmed = false;         // true ONLY when the final resolved Ad Library URL proves the exact scope
  let observedPageId = '';            // view_all_page_id parsed from the final resolved URL
  let observedCountry = '';           // country parsed from the final resolved URL
  let observedActiveStatus = '';      // active_status parsed from the final resolved URL
  let observedAdType = '';            // ad_type parsed from the final resolved URL
  let unexpectedScopeParams: string[] = []; // NAMES of narrowing/unknown params on the final URL
  let duplicateScopeParams: string[] = []; // NAMES of required params that appeared more than once
  let allowedMetaUiDefaultsPresent: string[] = []; // NAMES of approved UI-default params present (value-matched)
  let noncanonicalMetaUiParams: string[] = [];     // NAMES of UI-default params present with a non-approved value
  let duplicateMetaUiParams: string[] = [];        // NAMES of UI-default params present more than once
  let observedMetaUiParamValues: { name: string; count: number; values: string[] }[] | undefined = undefined; // diagnostic only (PHASE0_SCOPE_PROBE)
  let scopeReason = 'scope not evaluated';
  let noActiveAdsSignal = '';         // short audit signal for the confirmed-no-active-ads check
  const noteChallenge = (where: string, res: { blocked: boolean; signal: string }) => {
    if (res.blocked && !challengeDetected) {
      challengeDetected = true;
      challengeSignal = `${where}: ${res.signal}`;
      note(`⚠ challenge/block signal (${where}): ${res.signal} — not bypassing; run will be classified BLOCKED/PARTIAL`);
    }
  };

  try {
    note('navigating to Ad Library listing…');
    const navStart = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    navDurationMs = Date.now() - navStart;
    pageLoaded = true;
    // Real scope proof is computed AFTER navigation + any retry/reload from the FINAL
    // resolved Ad Library URL (see "Real scope proof" below) — never from env/input here.
    await page.waitForTimeout(SETTLE);
    await dismissOverlays(page);
    await page.waitForTimeout(SETTLE);
    noteChallenge('after-initial-nav', await detectChallengeSignal(page));

    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 2) {
        // ── 0-card retry: first pass found nothing. Treat as a Meta lazy-load /
        //    no-active-card condition, not a crash: wait longer, reload once, then
        //    wait for ad cards / a "Library ID" / a clear no-active-ads state. ──
        note('0 cards found, waiting for Meta lazy load');
        await page.waitForTimeout(ZERO_CARD_WAIT);
        note('0 cards found, reloading once');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await page.waitForTimeout(SETTLE);
        await dismissOverlays(page);
        try {
          await page.waitForFunction(() => {
            const t = document.body ? document.body.innerText : '';
            if (/Library ID/i.test(t)) return true;
            if (/no ads?\b[^.]{0,40}\b(match|results|found)|isn'?t running ads|not (currently )?running ads|0 results|no results/i.test(t)) return true;
            return false;
          }, { timeout: ZERO_CARD_SIGNAL_TIMEOUT });
        } catch {
          note('retry: no clear ad-card or no-active-ads signal within timeout — scanning anyway');
        }
        await page.waitForTimeout(SETTLE);
        noteChallenge('after-zero-card-reload', await detectChallengeSignal(page));
      }

      let noGrowth = 0;
      stopCondition = 'none';   // reset per attempt; reflects the last scroll loop run
      for (let scroll = 0; scroll <= MAX_SCROLLS; scroll++) {
        scrollCyclesAttempted++;
      const batch = await page.evaluate(() => {
        // Meta-owned / system / tracking / CDN domains — never advertiser landing pages.
        const blocked = [
          'facebook.com', 'fb.com', 'fb.me', 'meta.com', 'metastatus.com',
          'developers.facebook.com', 'business.facebook.com', 'm.facebook.com',
          'instagram.com', 'cdninstagram.com', 'cdninstagram', 'whatsapp.com',
          'messenger.com', 'fbcdn.net', 'fbcdn', 'oculus.com', 'threads.net',
        ];
        const uiLabels = [
          'system status', 'privacy policy', 'privacy', 'terms', 'cookies', 'cookie',
          'help', 'log in', 'login', 'sign up', 'signup', 'meta', 'facebook',
          'instagram', 'about', 'careers', 'ad choices', 'settings', 'more',
          'see more', 'learn more about', 'report ad',
        ];

        const libRe = /Library ID:?\s*([0-9]{5,})/;
        const found: { id: string; mediaType: string; startDate: string; copy: string; headline: string; landing: string; rejected: string[] }[] = [];
        const seen = new Set<string>();
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('div'))) {
          const tc = el.textContent || '';
          const m = tc.match(libRe);
          if (!m) continue;
          if ((tc.match(/Library ID/g) || []).length !== 1) continue;
          const id = m[1]!;
          if (seen.has(id)) continue;
          seen.add(id);

          // media type — best effort
          let mediaType = 'UNKNOWN';
          const hasVideo = !!el.querySelector('video');
          const bigImgs = Array.from(el.querySelectorAll('img')).filter((im) => {
            const b = im.getBoundingClientRect();
            return b.width >= 120 && b.height >= 120;
          });
          const hasNext = !!el.querySelector('[aria-label*="next" i],[aria-label*="forward" i],[data-testid*="next" i]');
          if (hasVideo) mediaType = 'VIDEO';
          else if (hasNext || bigImgs.length >= 2) mediaType = 'CAROUSEL';
          else if (bigImgs.length === 1) mediaType = 'IMAGE';
          else mediaType = 'UNKNOWN';

          const dm = tc.match(/Started running on\s+([A-Za-z]+ \d{1,2}, \d{4})/);
          const startDate = dm ? dm[1]!.trim() : '';

          // copy — best effort (inline, never invented)
          let copy = '';
          for (const t of Array.from(el.querySelectorAll<HTMLElement>('div, span, p'))) {
            let direct = '';
            for (const n of Array.from(t.childNodes)) if (n.nodeType === 3) direct += n.textContent || '';
            direct = direct.replace(/\s+/g, ' ').trim();
            if (direct.length < 15) continue;
            const low = direct.toLowerCase();
            if (low.startsWith('library id')) continue;
            if (low.includes('started running on')) continue;
            if (low.includes('this ad has')) continue;
            if (low.includes('why am i seeing')) continue;
            if (low.includes('see ad details') || low.includes('see summary') || low.includes('drop-down')) continue;
            if (low.includes('open drop') || low.includes('ad library')) continue;
            if (low === 'sponsored' || low === 'active' || low === 'inactive') continue;
            if (/^\d+ (ad|result)/.test(low)) continue;
            if (direct.length > copy.length) copy = direct;
          }

          // headline + landing = first CLEAN external link (non-Meta, non-UI)
          let headline = '';
          let landing = '';
          const rejected: string[] = [];
          for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>('a'))) {
            const href = a.getAttribute('href') || '';
            if (!href || href.startsWith('#')) continue;
            let target = href;
            const um = href.match(/[?&]u=([^&]+)/);
            if (um) { try { target = decodeURIComponent(um[1]!); } catch { /* keep raw */ } }
            if (!/^https?:\/\//.test(target)) continue;
            const tl = target.toLowerCase();
            let isBlocked = false;
            for (const d of blocked) if (tl.includes(d)) { isBlocked = true; break; }
            if (isBlocked) { rejected.push(`rejected landing candidate: ${target}, internal Meta/system domain`); continue; }
            const at = (a.textContent || '').replace(/\s+/g, ' ').trim();
            const atLow = at.toLowerCase();
            let isUi = false;
            for (const u of uiLabels) if (atLow === u || atLow.includes(u)) { isUi = true; break; }
            if (!landing) landing = target; // first clean advertiser link
            if (isUi) {
              rejected.push(`rejected headline candidate: ${at || '(empty)'}, UI label`);
            } else if (!headline && at && at.length >= 3 && at.length <= 120 && atLow !== copy.toLowerCase() && !/^\d+$/.test(at)) {
              headline = at; // skip numeric-only anchor text (post/video IDs) — keep looking
            }
            if (landing && headline) break;
          }

          found.push({ id, mediaType, startDate, copy, headline, landing, rejected });
        }
        return found;
      });

      let added = 0;
      for (const a of batch) {
        if (!ads.has(a.id)) {
          ads.set(a.id, { mediaType: a.mediaType, startDate: a.startDate, copy: a.copy, headline: a.headline, landing: a.landing });
          added++;
          if (firstIdAtMs === null) firstIdAtMs = Date.now() - startedAtMs; // time-to-first-ID
          for (const r of a.rejected) note(`ad ${a.id}: ${r}`);
        }
        if (ads.size >= MAX_ADS) break;
      }
      idsPerCycle.push(added);   // new IDs added this scroll cycle (simple per-cycle yield)
      note(`scroll ${scroll}: page shows ${batch.length} card(s); +${added} new; total unique = ${ads.size}`);

      if (ads.size >= MAX_ADS) {
        note(`reached MAX_ADS (${MAX_ADS}) — stopping (capped → PARTIAL, never a complete count)`);
        capped = true;
        stopCondition = 'max_ads_cap'; stopConditionReached = true;
        stopConditionNote = `MAX_ADS cap (${MAX_ADS}) reached — discovery deliberately capped; classified PARTIAL_DISCOVERY (capped=true), NOT a full inventory`;
        break;
      }
      noGrowth = added === 0 ? noGrowth + 1 : 0;
      noGrowthFinal = noGrowth;
      if (noGrowth >= NO_GROWTH_LIMIT) {
        note(`no new ads for ${NO_GROWTH_LIMIT} scrolls — stopping`);
        stopCondition = 'no_growth_limit'; stopConditionReached = true;
        stopConditionNote = `no new Library IDs for ${NO_GROWTH_LIMIT} consecutive scroll cycles`;
        break;
      }

      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
      await page.waitForTimeout(SCROLL_PAUSE);
      }

      // If the scroll loop ended without hitting a defined stop condition, the
      // MAX_SCROLLS budget ran out — the page may still have had more to load, so
      // this is NOT a clean stop and must not be read as a complete list.
      if (stopCondition === 'none' && ads.size > 0) {
        stopCondition = 'max_scrolls_exhausted'; stopConditionReached = false;
        stopConditionNote = `MAX_SCROLLS (${MAX_SCROLLS}) budget exhausted while still scrolling — stop condition not reached`;
      }

      noteChallenge('after-scroll-loop', await detectChallengeSignal(page));

      if (ads.size > 0) break;            // found ads — no retry needed
      if (attempt === 2) note('still 0 cards after retry');
    }

    // ── Real, FULL-SCOPE proof (fail-closed). Trust ONLY the browser's FINAL resolved Ad
    //    Library URL after navigation + any retry/reload — never the input URL or env vars.
    //    Scope is confirmed ONLY when the final URL proves the canonical Phase 0 scope: on
    //    /ads/library, view_all_page_id = META_PAGE_ID, country = META_COUNTRY,
    //    active_status = 'active', ad_type = 'all', and NO narrowing/unknown query params.
    //    Unknown / scope-changing params fail closed; only their NAMES are recorded.
    {
      const sc = parseUrlScope(page.url());
      observedPageId = sc.pageId;
      observedCountry = sc.country;
      observedActiveStatus = sc.activeStatus;
      observedAdType = sc.adType;
      unexpectedScopeParams = sc.narrowingParams.concat(sc.unexpectedParams);
      duplicateScopeParams = sc.duplicateParams;
      allowedMetaUiDefaultsPresent = sc.allowedUiDefaults;
      noncanonicalMetaUiParams = sc.noncanonicalUiParams;
      duplicateMetaUiParams = sc.duplicateUiParams;
      // Opt-in diagnostic ONLY — never affects the fail-closed classification below.
      if (PHASE0_SCOPE_PROBE) observedMetaUiParamValues = probeMetaUiParams(page.url());
      const reasons: string[] = [];
      if (!sc.onLibrary) reasons.push('final URL not on the Meta Ad Library /ads/library surface');
      if (sc.missingParams.length) reasons.push(`missing required scope params: ${sc.missingParams.join(',')}`);
      if (sc.duplicateParams.length) reasons.push(`duplicate required scope params: ${sc.duplicateParams.join(',')}`);
      if (!pageId) reasons.push('no expected META_PAGE_ID');
      else if (sc.duplicateParams.indexOf('view_all_page_id') < 0 && sc.pageId !== pageId) reasons.push('view_all_page_id mismatch (observed != expected)');
      if (!META_COUNTRY) reasons.push('no expected META_COUNTRY');
      else if (sc.duplicateParams.indexOf('country') < 0 && sc.country.toUpperCase() !== META_COUNTRY.toUpperCase()) reasons.push('country mismatch (observed != expected)');
      if (sc.duplicateParams.indexOf('active_status') < 0 && sc.activeStatus !== EXPECTED_ACTIVE_STATUS) reasons.push(`active_status not "${EXPECTED_ACTIVE_STATUS}"`);
      if (sc.duplicateParams.indexOf('ad_type') < 0 && sc.adType !== EXPECTED_AD_TYPE) reasons.push(`ad_type not "${EXPECTED_AD_TYPE}"`);
      if (sc.narrowingParams.length) reasons.push(`narrowing params present: ${sc.narrowingParams.join(',')}`);
      if (sc.unexpectedParams.length) reasons.push(`unexpected params present: ${sc.unexpectedParams.join(',')}`);
      if (sc.duplicateUiParams.length) reasons.push(`duplicate UI-default params: ${sc.duplicateUiParams.join(',')}`);
      if (sc.noncanonicalUiParams.length) reasons.push(`non-canonical UI-default param value(s): ${sc.noncanonicalUiParams.join(',')}`);
      scopeConfirmed = reasons.length === 0;
      scopeReason = scopeConfirmed
        ? `canonical scope confirmed (/ads/library, exact page+country, active_status=${EXPECTED_ACTIVE_STATUS}, ad_type=${EXPECTED_AD_TYPE}; UI-defaults present: ${sc.allowedUiDefaults.length ? sc.allowedUiDefaults.join(',') : 'none'}; no narrowing/unknown/duplicate params)`
        : reasons.join('; ');
      note(`scope proof: ${scopeConfirmed ? 'CONFIRMED' : 'NOT confirmed'} — ${scopeReason}`);
    }

    // Zero IDs across all attempts. A zero-ID run is a CLEAN success ONLY when (a) real scope
    // proof passed, (b) no challenge/error, and (c) Meta's OWN explicit, VISIBLE advertiser
    // "no active ads" statement is detected — recorded as confirmed_no_active_ads. Anything
    // else (no scope proof, or no explicit visible statement) is zero_cards → INCOMPLETE. This
    // overrides any no_growth_limit the scroll loop set, since "no growth" over an empty page
    // is not, on its own, proof that the advertiser has no active ads.
    if (ads.size === 0 && !challengeDetected) {
      if (scopeConfirmed) {
        const na = await detectNoActiveAds(page);
        noActiveAdsProven = na.proven;
        noActiveAdsSignal = na.signal;
        if (na.proven) {
          stopCondition = 'confirmed_no_active_ads'; stopConditionReached = true;
          stopConditionNote = `confirmed no active ads — ${na.signal}` + (na.bbox ? ` [<${na.tag}> ${Math.round(na.bbox.width)}x${Math.round(na.bbox.height)}@(${Math.round(na.bbox.x)},${Math.round(na.bbox.y)})]` : '');
        } else {
          stopCondition = 'zero_cards'; stopConditionReached = false;
          stopConditionNote = `zero Library IDs and ${na.signal} — ambiguous (INCOMPLETE)`;
        }
      } else {
        noActiveAdsSignal = 'scope not confirmed — no-active-ads not evaluated';
        stopCondition = 'zero_cards'; stopConditionReached = false;
        stopConditionNote = 'zero Library IDs and scope NOT confirmed — ambiguous (INCOMPLETE)';
      }
    }

    // ── Detail fallback: for ads with no copy AND no headline, open the ad page ──
    for (const [id, info] of Array.from(ads.entries()).slice(0, MAX_ADS)) {
      if ((info.copy && info.copy.trim()) || (info.headline && info.headline.trim())) continue;
      const adUrl = `https://www.facebook.com/ads/library/?id=${id}`;
      try {
        note(`ad ${id}: no copy/headline on listing — opening detail ${adUrl}`);
        await page.goto(adUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await page.waitForTimeout(DETAIL_SETTLE);
        await dismissOverlays(page);
        await page.waitForTimeout(DETAIL_SETTLE);
        const h = await harvestText(page, id);
        for (const r of h.rejected) note(`ad ${id}: ${r}`);
        if (h.copy) info.copy = h.copy;
        if (h.headline) info.headline = h.headline;
        if (h.landing && !info.landing) info.landing = h.landing;
        note(`ad ${id}: detail harvest → copy=${h.copy ? 'found' : 'none'}, headline=${h.headline ? 'found' : 'none'}`);
      } catch (err: unknown) {
        note(`ad ${id}: detail harvest failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err: unknown) {
    errorSummary = scrubUrls(err instanceof Error ? err.message : String(err));
    note(`⚠ navigation/extraction error: ${errorSummary}`);
  } finally {
    await browser.close();
  }

  // ─── Build rows (capped, deduped, one competitor) ───
  const rows: Row[] = [];
  let readyCount = 0;
  let needsReviewCount = 0;
  for (const [id, info] of Array.from(ads.entries()).slice(0, MAX_ADS)) {
    // Normalise headline: strip glued display-URL prefix + CTA-button suffix.
    const cleaned = cleanMetaHeadlineText(info.headline || '');
    if (cleaned.headline !== (info.headline || '').trim()) {
      note('headline cleaned:');
      note(`  before: ${info.headline}`);
      note(`  after: ${cleaned.headline}`);
      info.headline = cleaned.headline;
    }

    // Reject a numeric-only headline or one equal to the ad id — those are scraped
    // post/video IDs (e.g. "1820807492631733"), never a real headline. Drop it so
    // the row never stores an ID as a headline (falls back to copy / NEEDS_REVIEW).
    if (info.headline && (/^\d+$/.test(info.headline.trim()) || info.headline.trim() === id)) {
      note(`ad ${id}: rejected numeric/id headline "${info.headline.trim()}" — dropped`);
      info.headline = '';
    }

    const known = info.mediaType === 'IMAGE' || info.mediaType === 'VIDEO' || info.mediaType === 'CAROUSEL';
    // SAFETY: listing-stage headline is NOT proven scoped metadata for the main Ad
    // record (Meta merges display URL / handle / title / price / CTA into one anchor),
    // so it is NEVER written to the CSV below. READY depends on ad copy only.
    const hasCopy = Boolean(info.copy && info.copy.trim());
    const ready = Boolean(id) && known && hasCopy;
    const status = ready ? 'READY' : 'NEEDS_REVIEW';
    if (ready) readyCount++; else needsReviewCount++;

    const reasons: string[] = [];
    if (!id) reasons.push('no ad_id');
    if (!known) reasons.push(`media_type=${info.mediaType || 'UNKNOWN'}`);
    if (!hasCopy) reasons.push('no ad copy');

    note(`ad ${id}: media=${info.mediaType}, copy=${info.copy ? 'found' : 'none'}, headline=${info.headline ? 'found' : 'none'}, landing=${info.landing ? 'found' : 'none'} → ${status}${reasons.length ? ` (${reasons.join('; ')})` : ''}`);

    rows.push({
      collection_status: status,
      competitor_name: COMPETITOR_NAME,
      meta_page_id: pageId,
      ad_id: id,
      ad_library_url: `https://www.facebook.com/ads/library/?id=${id}`,
      media_type: info.mediaType || 'UNKNOWN',
      publisher_platforms: '',
      ad_delivery_start_time: info.startDate || '',
      ad_copy: info.copy || '',
      headline: '',   // ALWAYS blank — unscoped listing headline excluded from the main Ad workflow
      description: '',
      landing_page_url: info.landing || '',
      notes: ready
        ? 'auto-extracted from Meta Ad Library (Phase A)'
        : `auto-extracted (Phase A) — needs review: ${reasons.join('; ')}`,
      visual_description: '',
      creative_notes: '',
    });
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, serializeCsv(rows), 'utf-8');

  note('');
  note(`Wrote ${rows.length} row(s): READY ${readyCount}, NEEDS_REVIEW ${needsReviewCount}`);
  note(`CSV:  ${outPath}`);
  if (rows.length === 0) note('⚠ No ad IDs extracted. Check the URL is an active Ad Library page for one advertiser, or run headful to inspect.');

  // ─── Local extraction log (do NOT commit) ───
  const summary = [
    '# Meta Ad Library extraction log (Phase A) — LOCAL ONLY, do not commit',
    `timestamp: ${new Date().toISOString()}`,
    `competitor_name: ${COMPETITOR_NAME}`,
    `meta_page_id: ${pageId}`,
    `source_url: ${url}`,
    `max_ads: ${MAX_ADS}`,
    `unique ad ids extracted: ${ads.size}`,
    `rows written: ${rows.length} (READY ${readyCount}, NEEDS_REVIEW ${needsReviewCount})`,
    '',
    '── per-row ──',
    ...rows.map((r) => `${r.collection_status}  ${r.ad_id}  ${r.media_type}  copy=${r.ad_copy ? 'Y' : 'N'} headline=${r.headline ? 'Y' : 'N'} landing=${r.landing_page_url ? 'Y' : 'N'}  ${r.ad_delivery_start_time || '(no date)'}`),
    '',
    '── run log ──',
    ...log,
  ].join('\n') + '\n';
  fs.writeFileSync(logPath, summary, 'utf-8');

  // ─── Phase 0: structured discovery-run log (JSON, LOCAL ONLY, no DB) ─────────
  const completedAt = new Date();
  const discoveryStatus = classifyDiscovery({
    pageLoaded,
    scopeConfirmed,
    discoveredCount: ads.size,
    challengeDetected,
    errorOccurred: errorSummary !== '',
    capped,
    noActiveAdsProven,
    stopCondition,
    stopConditionReached,
  });
  let sourceCsvBytes: number | null = null;
  try { sourceCsvBytes = fs.statSync(outPath).size; } catch { sourceCsvBytes = null; }

  const runLog: DiscoveryRunLog = {
    schema: 'browser-discovery-run-log/phase0',
    algo_version: DISCOVERY_ALGO_VERSION,
    competitor_name: COMPETITOR_NAME,
    meta_page_id: pageId,
    meta_country: META_COUNTRY,
    input_url: sanitizeUrl(url),
    output_csv_path: outPath,
    configured_max_ads: MAX_ADS,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    total_duration_ms: completedAt.getTime() - startedAtMs,
    nav_duration_ms: navDurationMs,
    time_to_first_id_ms: firstIdAtMs,
    scroll_cycles_attempted: scrollCyclesAttempted,
    no_growth_cycles_reached: noGrowthFinal,
    no_growth_limit: NO_GROWTH_LIMIT,
    ids_per_scroll_cycle: idsPerCycle,
    stop_condition: stopCondition,
    stop_condition_reached: stopConditionReached,
    stop_condition_note: stopConditionNote,
    discovered_library_id_count: ads.size,
    output_row_count: rows.length,
    collection_status_counts: { READY: readyCount, NEEDS_REVIEW: needsReviewCount },
    ready_count: readyCount,
    needs_review_count: needsReviewCount,
    source_csv_bytes: sourceCsvBytes,
    discovery_status: discoveryStatus,
    capped,
    no_active_ads_proven: noActiveAdsProven,
    no_active_ads_signal: noActiveAdsSignal,
    scope_confirmed: scopeConfirmed,
    expected_page_id: pageId,
    observed_page_id: observedPageId,
    expected_country: META_COUNTRY,
    observed_country: observedCountry,
    expected_active_status: EXPECTED_ACTIVE_STATUS,
    observed_active_status: observedActiveStatus,
    expected_ad_type: EXPECTED_AD_TYPE,
    observed_ad_type: observedAdType,
    unexpected_scope_params: unexpectedScopeParams,
    duplicate_scope_params: duplicateScopeParams,
    allowed_meta_ui_defaults_present: allowedMetaUiDefaultsPresent,
    noncanonical_meta_ui_params: noncanonicalMetaUiParams,
    duplicate_meta_ui_params: duplicateMetaUiParams,
    observed_meta_ui_param_values: PHASE0_SCOPE_PROBE ? observedMetaUiParamValues : undefined,
    scope_confirmation_reason: scrubUrls(scopeReason),
    challenge_detected: challengeDetected,
    challenge_signal: scrubUrls(challengeSignal),
    error_summary: scrubUrls(errorSummary),
    notes:
      'Phase 0 local discovery measurement. discovery_status describes THIS RUN only; ' +
      'a non-SUCCESSFUL_DISCOVERY status does NOT mean the advertiser has zero ads and must ' +
      'never be used to mark prior ads inactive. No DB / Prisma writes, no ingestion.',
  };
  const runLogPath = `${outPath.replace(/\.csv$/i, '')}.discovery-run-log.json`;
  fs.writeFileSync(runLogPath, JSON.stringify(runLog, null, 2) + '\n', 'utf-8');

  console.log(`${LINE}`);
  console.log(`  Extraction log: ${logPath}  (local only — do not commit)`);
  console.log(`  Discovery run log: ${runLogPath}  (local only — do not commit)`);
  console.log(`  Discovery status: ${discoveryStatus}` +
    (challengeDetected ? `  (challenge/block: ${challengeSignal})` : '') +
    `  — stop_condition=${stopCondition} reached=${stopConditionReached}`);
  console.log('  Reminder: a non-SUCCESSFUL_DISCOVERY status never implies zero ads or marks ads inactive.');
  console.log('  No DB writes. No ingestion. One competitor per CSV.');
  console.log(`${LINE}\n`);
}

main().catch((err: unknown) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
