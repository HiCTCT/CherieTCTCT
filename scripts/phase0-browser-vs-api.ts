/**
 * Phase 0: Read-only browser-vs-API count diagnostic  (no DB, no ingestion)
 *
 * For a FIXED list of competitors, compares:
 *   - the count of ads the BROWSER discovery workflow observed (from local
 *     discovery-run logs, falling back to distinct ad_id counts in the browser
 *     CSVs already on disk), against
 *   - the count of ads the Meta Ad Library API returns for the same page ID.
 *
 * It is strictly a DIAGNOSTIC. It does NOT write to Prisma / SQLite, does NOT run
 * ingestion, does NOT run the scheduled batch, and does NOT modify any CSV. It
 * only reads local files and makes read-only Graph API GET calls. NEITHER the
 * browser count NOR the API count is a "complete inventory" — both are filtered,
 * capped, and time-sensitive views, and the difference is reported only to flag
 * where the two views diverge, never to declare one correct.
 *
 * This is NOT scripts/meta-batch-scheduled.ts and shares none of its DB path.
 *
 * Usage:
 *   set META_ADLIB_TOKEN=...                         (required for a real API count)
 *   set COMPETITORS=castlery=123456,boconcept=789    (name=metaPageId pairs)
 *   set META_COUNTRY=SG                              (optional; default SG)
 *   set API_ACTIVE_STATUS=ACTIVE                     (optional; default ACTIVE)
 *   set API_COUNT_LIMIT=250                          (optional; API paging cap)
 *   npm run phase0:browser-vs-api
 *
 * Without META_ADLIB_TOKEN the Meta client runs in SIMULATION mode; this script
 * detects that and marks every comparison SIMULATION_NO_TOKEN rather than
 * pretending the mock count is real.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { fetchMetaAds } from '@/lib/providers/meta/fetch';
import type { MetaFetchConfig } from '@/lib/providers/meta/types';

const IMPORTS_DIR = path.resolve((process.env.IMPORTS_DIR ?? 'data/imports').trim());
const META_COUNTRY = (process.env.META_COUNTRY ?? 'SG').trim();
const API_ACTIVE_STATUS = ((process.env.API_ACTIVE_STATUS ?? 'ACTIVE').trim().toUpperCase()) as 'ALL' | 'ACTIVE' | 'INACTIVE';
const API_AD_TYPE = (process.env.META_AD_TYPE ?? 'ALL').trim().toUpperCase();
const MAX_PHASE0_COMPETITORS = 5;   // deliberate Phase 0 guard — NOT a production-scale workflow
const API_COUNT_LIMIT = Math.max(1, parseInt(process.env.API_COUNT_LIMIT ?? '250', 10) || 250);
const HAS_TOKEN = Boolean((process.env.META_ADLIB_TOKEN ?? '').trim());

type CompetitorInput = { name: string; pageId: string };

type BrowserObservation = {
  count: number | null;
  status: string;           // discovery_status, or 'CSV_DISTINCT_AD_IDS', or 'NO_BROWSER_OBSERVATION'
  source: string;           // which file the count came from
  kind: 'discovery-log' | 'csv' | 'none';
  metaPageId: string;       // the observation's OWN Meta Page ID (for exact-identity + scope checks)
  metaCountry: string;      // the observation's OWN country (discovery-log only; '' for CSV)
  stopCondition: string;    // discovery-log stop_condition ('' for CSV)
  capped: boolean;          // discovery-log capped flag (false for CSV)
  scopeConfirmed: boolean;  // discovery-log scope_confirmed (always false for CSV / none)
  metaActiveStatus: string; // discovery-log observed_active_status ('' for CSV / none)
  metaAdType: string;       // discovery-log observed_ad_type ('' for CSV / none)
  metaObservedCountry: string; // discovery-log observed_country — the final-URL country used for eligibility
};

function parseCompetitors(): CompetitorInput[] {
  const raw = (process.env.COMPETITORS ?? '').trim();
  if (!raw) return [];
  const out: CompetitorInput[] = [];
  for (const pair of raw.split(',')) {
    const [name, pageId] = pair.split('=').map((s) => (s ?? '').trim());
    if (name && pageId) out.push({ name, pageId });
  }
  return out;
}

function listImportFiles(): string[] {
  try { return fs.readdirSync(IMPORTS_DIR); } catch { return []; }
}

// Newest discovery-run-log JSON whose OWN meta_page_id EXACTLY equals pageId. Identity is
// the Meta Page ID only — never the competitor name or filename. Newest by completed_at,
// falling back to file mtime.
function findDiscoveryLog(pageId: string): BrowserObservation | null {
  const candidates = listImportFiles()
    .filter((f) => /\.discovery-run-log\.json$/i.test(f))
    .map((f) => path.join(IMPORTS_DIR, f));
  let best: { key: number; obs: BrowserObservation } | null = null;
  for (const full of candidates) {
    let log: Record<string, unknown>;
    try { log = JSON.parse(fs.readFileSync(full, 'utf-8')) as Record<string, unknown>; } catch { continue; }
    if (String(log.meta_page_id ?? '') !== pageId) continue;          // EXACT Meta Page ID match only
    const count = typeof log.discovered_library_id_count === 'number' ? log.discovered_library_id_count : null;
    const status = String(log.discovery_status ?? 'UNKNOWN_DISCOVERY');
    const metaCountry = String(log.meta_country ?? '');
    const stopCondition = String(log.stop_condition ?? '');
    const capped = log.capped === true || stopCondition === 'max_ads_cap';
    const scopeConfirmed = log.scope_confirmed === true;
    const metaActiveStatus = String(log.observed_active_status ?? '');
    const metaAdType = String(log.observed_ad_type ?? '');
    const metaObservedCountry = String(log.observed_country ?? '');
    let key = 0;
    const ca = Date.parse(String(log.completed_at ?? ''));
    if (!Number.isNaN(ca)) key = ca;
    else { try { key = fs.statSync(full).mtimeMs; } catch { key = 0; } }
    if (!best || key > best.key) {
      best = { key, obs: { count, status, source: path.basename(full), kind: 'discovery-log', metaPageId: pageId, metaCountry, stopCondition, capped, scopeConfirmed, metaActiveStatus, metaAdType, metaObservedCountry } };
    }
  }
  return best ? best.obs : null;
}

// Fallback: distinct ad_id count from a browser-collected / with-assets CSV, where the
// observation's identity is the CSV meta_page_id COLUMN equal to pageId — NOT the filename.
// A CSV observation has no discovery status, so it is always comparison-ineligible.
function findCsvDistinctCount(pageId: string): BrowserObservation | null {
  const csvs = listImportFiles().filter((f) =>
    /\.csv$/i.test(f) &&
    !/\.verified-meta\.csv$/i.test(f) &&
    (/browser-collected/i.test(f) || /\.with-assets\.csv$/i.test(f)));
  // Inspect EVERY matching CSV and keep the NEWEST valid one by file mtime. Filename shape
  // (e.g. .with-assets.csv) is NOT a priority signal. A CSV observation has no discovery
  // status and no scope proof, so it is always comparison-ineligible.
  let best: { mtime: number; obs: BrowserObservation } | null = null;
  for (const f of csvs) {
    const full = path.join(IMPORTS_DIR, f);
    let records: Record<string, string>[];
    try { records = parse(fs.readFileSync(full, 'utf-8'), { columns: true, skip_empty_lines: true }) as Record<string, string>[]; }
    catch { continue; }
    const matching = records.filter((r) => (r.meta_page_id ?? '').trim() === pageId);   // identity = page-id column
    if (matching.length === 0) continue;
    let mtime = 0; try { mtime = fs.statSync(full).mtimeMs; } catch { mtime = 0; }
    if (best && mtime <= best.mtime) continue;   // keep the newest valid matching CSV
    const ids = new Set(matching.map((r) => (r.ad_id ?? '').trim()).filter(Boolean));
    best = { mtime, obs: { count: ids.size, status: 'CSV_DISTINCT_AD_IDS', source: f, kind: 'csv', metaPageId: pageId, metaCountry: '', stopCondition: '', capped: false, scopeConfirmed: false, metaActiveStatus: '', metaAdType: '', metaObservedCountry: '' } };
  }
  return best ? best.obs : null;
}

function getBrowserObservation(pageId: string): BrowserObservation {
  return findDiscoveryLog(pageId)
    ?? findCsvDistinctCount(pageId)
    ?? { count: null, status: 'NO_BROWSER_OBSERVATION', source: '(none found)', kind: 'none', metaPageId: '', metaCountry: '', stopCondition: '', capped: false, scopeConfirmed: false, metaActiveStatus: '', metaAdType: '', metaObservedCountry: '' };
}

// Decide whether a browser observation is eligible for an OFFICIAL count comparison.
// Eligible ONLY when it is a clean SUCCESSFUL_DISCOVERY from a discovery-run log, not
// capped, with an EXACT Meta Page ID match, a matching country/scope, and ended via
// no_growth_limit or confirmed_no_active_ads. Everything else is ineligible and yields a
// specific INELIGIBLE_* status (raw counts kept as reference only; no official verdict).
function eligibility(b: BrowserObservation, pageId: string, country: string): string {
  if (b.kind === 'none') return 'INELIGIBLE_NO_BROWSER_OBSERVATION';
  if (b.metaPageId !== pageId) return 'INELIGIBLE_SCOPE_MISMATCH';
  if (b.capped) return 'INELIGIBLE_BROWSER_CAPPED';
  if (b.status === 'BLOCKED_DISCOVERY') return 'INELIGIBLE_BROWSER_BLOCKED';
  if (b.status === 'FAILED_DISCOVERY') return 'INELIGIBLE_BROWSER_FAILED';
  if (b.status === 'PARTIAL_DISCOVERY') return 'INELIGIBLE_BROWSER_PARTIAL';
  if (b.status === 'INCOMPLETE_DISCOVERY') return 'INELIGIBLE_BROWSER_INCOMPLETE';
  if (b.status !== 'SUCCESSFUL_DISCOVERY') return 'INELIGIBLE_BROWSER_INCOMPLETE';   // CSV-only / unknown
  // Require EXPLICIT recorded scope proof + a non-empty country that exactly matches the
  // requested one — never inferred from SUCCESSFUL_DISCOVERY alone.
  if (!b.scopeConfirmed) return 'INELIGIBLE_SCOPE_MISMATCH';
  // Country eligibility uses the browser's OBSERVED final-URL country (configured meta_country
  // is only an audit label). It must be non-empty and exactly equal the requested META_COUNTRY.
  if (!b.metaObservedCountry) return 'INELIGIBLE_SCOPE_MISMATCH';
  if (!country || b.metaObservedCountry.toUpperCase() !== country.toUpperCase()) return 'INELIGIBLE_SCOPE_MISMATCH';
  // Browser log must record the canonical active/all scope, AND the API query must also be
  // the canonical active/all scope — otherwise the two views are not the same ad set.
  if (b.metaActiveStatus.toLowerCase() !== 'active' || b.metaAdType.toLowerCase() !== 'all') return 'INELIGIBLE_SCOPE_MISMATCH';
  if (API_ACTIVE_STATUS !== 'ACTIVE' || API_AD_TYPE !== 'ALL') return 'INELIGIBLE_SCOPE_MISMATCH';
  if (b.stopCondition !== 'no_growth_limit' && b.stopCondition !== 'confirmed_no_active_ads') return 'INELIGIBLE_BROWSER_INCOMPLETE';
  return 'COMPARED';
}

async function getApiCount(pageId: string): Promise<{ count: number | null; capped: boolean; error: string; simulation: boolean }> {
  if (!HAS_TOKEN) {
    return { count: null, capped: false, error: '', simulation: true };
  }
  const config: MetaFetchConfig = {
    token: process.env.META_ADLIB_TOKEN,
    searchTerms: '',                         // page-scoped count, no keyword filter
    searchPageIds: [pageId],
    countries: [META_COUNTRY],
    adActiveStatus: API_ACTIVE_STATUS,
    adType: API_AD_TYPE,
    limit: API_COUNT_LIMIT,
    format: 'STATIC' as MetaFetchConfig['format'],
    simulationMode: false,
  };
  try {
    const records = await fetchMetaAds(config);
    const count = records.length;
    // If we hit the configured limit the API view is truncated, so the count is a
    // lower bound, not a total — flag it.
    const capped = count >= API_COUNT_LIMIT;
    return { count, capped, error: '', simulation: false };
  } catch (err: unknown) {
    return { count: null, capped: false, error: err instanceof Error ? err.message : String(err), simulation: false };
  }
}

async function main(): Promise<void> {
  const LINE = '═'.repeat(72);
  console.log(`\n${LINE}`);
  console.log('  phase0-browser-vs-api  (READ-ONLY count diagnostic — no DB, no ingestion)');
  console.log(LINE);

  const competitors = parseCompetitors();
  if (competitors.length === 0) {
    console.error('\n❌ Set COMPETITORS="name=metaPageId,name=metaPageId" (the fixed list to compare).');
    process.exit(1);
  }
  // Deliberate Phase 0 cohort guard (NOT a production-scale workflow): reject more than five
  // competitors BEFORE any API call is made.
  if (competitors.length > MAX_PHASE0_COMPETITORS) {
    console.error(`\n❌ Phase 0 allows at most ${MAX_PHASE0_COMPETITORS} competitors per run (got ${competitors.length}). This is a deliberate Phase 0 guard, not a production-scale workflow. Trim COMPETITORS and re-run.`);
    process.exit(1);
  }
  console.log(`  Competitors:   ${competitors.map((c) => c.name).join(', ')}`);
  console.log(`  Country:       ${META_COUNTRY}`);
  console.log(`  API status:    ${API_ACTIVE_STATUS}  (paging cap ${API_COUNT_LIMIT})`);
  console.log(`  API mode:      ${HAS_TOKEN ? 'LIVE (token set)' : 'SIMULATION (no META_ADLIB_TOKEN) — counts not real'}`);
  console.log(LINE);

  const rows: Record<string, unknown>[] = [];
  for (const c of competitors) {
    const browser = getBrowserObservation(c.pageId);   // identity = EXACT Meta Page ID
    const api = await getApiCount(c.pageId);

    // API-side non-comparison states first, then browser eligibility. An OFFICIAL
    // count_difference is produced ONLY for an eligible (COMPARED) result.
    let comparisonStatus: string;
    let eligible = false;
    if (api.simulation) comparisonStatus = 'SIMULATION_NO_TOKEN';
    else if (api.error) comparisonStatus = 'API_ERROR';
    else if (api.capped) comparisonStatus = 'API_CAPPED_LOWER_BOUND';
    else {
      comparisonStatus = eligibility(browser, c.pageId, META_COUNTRY);
      eligible = comparisonStatus === 'COMPARED';
    }
    const countDifference: number | null =
      (eligible && browser.count !== null && api.count !== null) ? browser.count - api.count : null;

    console.log(`\n  ${c.name}  (page ${c.pageId})`);
    console.log(`    Browser observed count: ${browser.count ?? 'n/a'}  [from ${browser.source}, ${browser.kind}]`);
    console.log(`    API returned count:     ${api.count ?? 'n/a'}${api.capped ? ' (capped — lower bound)' : ''}`);
    console.log(`    Count difference:       ${eligible ? (countDifference ?? 'n/a') : 'null (ineligible — reference only)'}  (browser − API)`);
    console.log(`    Browser run status:     ${browser.status}${browser.capped ? ' (capped)' : ''}  stop=${browser.stopCondition || 'n/a'}  pageId=${browser.metaPageId || 'n/a'}`);
    console.log(`    Comparison status:      ${comparisonStatus}${eligible ? '' : '  → NOT an official completeness comparison'}`);
    if (api.error) console.log(`    API error:              ${api.error}`);

    rows.push({
      competitor_name: c.name,                 // human-readable label only
      meta_page_id: c.pageId,                  // identity used for matching
      meta_country: META_COUNTRY,
      browser_observed_count: browser.count,
      browser_run_status: browser.status,
      browser_capped: browser.capped,
      browser_stop_condition: browser.stopCondition || null,
      browser_meta_page_id: browser.metaPageId || null,
      browser_meta_country: browser.metaCountry || null,
      browser_observed_country: browser.metaObservedCountry || null,
      browser_scope_confirmed: browser.scopeConfirmed,
      browser_source: browser.source,
      browser_kind: browser.kind,
      api_returned_count: api.count,
      api_capped: api.capped,
      api_active_status: API_ACTIVE_STATUS,
      api_ad_type: API_AD_TYPE,
      api_error: api.error || null,
      eligible_for_official_comparison: eligible,
      count_difference: eligible ? countDifference : null,   // null whenever ineligible
      comparison_status: comparisonStatus,
    });
  }

  const report = {
    schema: 'phase0-browser-vs-api/1',
    generated_at: new Date().toISOString(),
    read_only: true,
    no_db_writes: true,
    no_ingestion: true,
    scope: {
      imports_dir: IMPORTS_DIR,
      meta_country: META_COUNTRY,
      api_active_status: API_ACTIVE_STATUS,
      api_ad_type: API_AD_TYPE,
      api_count_limit: API_COUNT_LIMIT,
      api_mode: HAS_TOKEN ? 'live' : 'simulation',
    },
    rows,
    notes:
      'Phase 0 read-only browser-vs-API count diagnostic. Browser observations are matched ' +
      'to competitors by EXACT meta_page_id ONLY (competitor names are human-readable labels). ' +
      'A comparison is eligible (COMPARED) ONLY when the browser observation is a clean ' +
      'SUCCESSFUL_DISCOVERY, not capped, with an exact page-ID + country/scope match, ended via ' +
      'no_growth_limit or confirmed_no_active_ads. For any ineligible result the comparison_status ' +
      'is a specific INELIGIBLE_* value, count_difference is null, and the raw counts are reference ' +
      'only. NEITHER the browser count NOR the API count is a complete inventory, and this report ' +
      'is NEVER an official completeness verdict. No DB writes, no ingestion.',
  };

  const reportsDir = path.join(IMPORTS_DIR, 'phase0-reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportsDir, `phase0-browser-vs-api.${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf-8');

  console.log(`\n${LINE}`);
  console.log(`  Report: ${reportPath}  (local only — git-ignored)`);
  console.log('  Neither count is a complete inventory. READ-ONLY. No DB writes. No ingestion.');
  console.log(`${LINE}\n`);
}

main().catch((err: unknown) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
