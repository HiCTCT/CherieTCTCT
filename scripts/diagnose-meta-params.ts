/**
 * Meta Parameter Format Diagnostic — Phase 2
 *
 * Phase 1 (diagnose-meta-fetch.ts) confirmed that all 8 standard parameter
 * combinations return 0 ads for Castlery, despite ~230 active ads visible
 * in the Meta Ad Library browser interface.
 *
 * This script tests whether the issue lies in how individual parameter
 * values are formatted — specifically:
 *   - ad_reached_countries value format (['SG'] vs ["SG"] vs SG vs omitted)
 *   - ad_type case and presence (ALL vs all vs omitted)
 *   - ad_active_status case and presence (ALL vs ACTIVE vs lowercase)
 *   - search_terms present vs empty string vs omitted
 *
 * No Prisma. No DB reads. No DB writes. No simulation fallback.
 * Requires META_ADLIB_TOKEN. Token is redacted from every printed URL.
 *
 * Usage (Windows):
 *   set META_ADLIB_TOKEN=<token>
 *   set META_DIAG_PAGE_ID=374586035998186
 *   npm run meta:diagnose-params
 *
 * Optional overrides:
 *   META_DIAG_PAGE_ID       Page ID to test (default: 374586035998186)
 *   META_DIAG_SEARCH_TERMS  Keyword for search_terms tests (default: Castlery)
 *   META_DIAG_COUNTRY       ISO country code (default: SG)
 */

import { redactToken } from '@/lib/providers/meta/redact';

// ─── Constants ────────────────────────────────────────────────────────────────

const META_API_BASE = 'https://graph.facebook.com/v25.0/ads_archive';
const DIAG_LIMIT = 5;
const FIELDS = [
  'id',
  'page_id',
  'page_name',
  'ad_creative_bodies',
  'ad_delivery_start_time',
  'publisher_platforms',
].join(',');

// ─── Types ────────────────────────────────────────────────────────────────────

type ParamValue = string | null; // null = omit the parameter entirely

type TestCase = {
  id: string;
  group: string;
  label: string;
  // Core params — null means omit entirely, '' means send as empty string
  searchTerms: ParamValue;
  pageId: ParamValue;
  adReachedCountries: ParamValue;
  adType: ParamValue;
  adActiveStatus: ParamValue;
  mediaType: ParamValue;
};

type AdSample = {
  id: string;
  page_name: string;
  page_id: string;
  platforms: string;
};

type TestResult = {
  testCase: TestCase;
  count: number;
  samples: AdSample[];
  redactedUrl: string;
  error: string | null;
};

type DiagAdRecord = {
  id?: string;
  page_name?: string;
  page_id?: string;
  publisher_platforms?: string[];
};

type DiagApiResponse = {
  data?: DiagAdRecord[];
  error?: { message: string; code: number; type?: string };
};

// ─── URL builder ─────────────────────────────────────────────────────────────
//
// Uses URLSearchParams for all parameters — the same approach as the
// production fetch.ts. URLSearchParams percent-encodes special characters
// (e.g. ['SG'] → %5B%27SG%27%5D), which is standard HTTP behaviour.
// The Meta API server should decode these back to their original values.
// null values are omitted entirely from the URL.

function buildUrl(testCase: TestCase, token: string): string {
  const params = new URLSearchParams();

  // search_terms: null = omit, '' = send empty, any string = send as-is
  if (testCase.searchTerms !== null) {
    params.set('search_terms', testCase.searchTerms);
  }

  if (testCase.pageId !== null) {
    params.set('search_page_ids', `[${testCase.pageId}]`);
  }

  if (testCase.adReachedCountries !== null) {
    params.set('ad_reached_countries', testCase.adReachedCountries);
  }

  if (testCase.adActiveStatus !== null) {
    params.set('ad_active_status', testCase.adActiveStatus);
  }

  if (testCase.adType !== null) {
    params.set('ad_type', testCase.adType);
  }

  if (testCase.mediaType !== null) {
    params.set('media_type', testCase.mediaType);
  }

  params.set('fields', FIELDS);
  params.set('limit', String(DIAG_LIMIT));
  params.set('access_token', token);

  return `${META_API_BASE}?${params.toString()}`;
}

// ─── API runner ───────────────────────────────────────────────────────────────

async function runTest(testCase: TestCase, token: string): Promise<TestResult> {
  const url = buildUrl(testCase, token);
  const redactedUrl = redactToken(url);

  try {
    const response = await fetch(url);
    const json = (await response.json()) as DiagApiResponse;

    if (json.error) {
      const safeMsg = redactToken(
        `API error (code ${json.error.code}): ${json.error.message}`,
      );
      return { testCase, count: 0, samples: [], redactedUrl, error: safeMsg };
    }

    const data = json.data ?? [];
    const samples: AdSample[] = data.slice(0, 3).map((r) => ({
      id: r.id ?? '(no id)',
      page_name: r.page_name ?? '(no page_name)',
      page_id: r.page_id ?? '(no page_id)',
      platforms: (r.publisher_platforms ?? []).join(', ') || '(none)',
    }));

    return { testCase, count: data.length, samples, redactedUrl, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      testCase,
      count: 0,
      samples: [],
      redactedUrl,
      error: `Fetch error: ${redactToken(message)}`,
    };
  }
}

// ─── Test matrix ─────────────────────────────────────────────────────────────
//
// Groups:
//   A — ad_reached_countries format (hold all else constant, vary country format)
//   B — ad_type case and presence  (hold country=SG bare, vary type param)
//   C — ad_active_status case      (hold country=SG bare, vary status param)
//   D — search_terms presence      (hold country=SG bare, test keyword vs empty vs omit)
//
// Control values across all tests unless the test is varying that param:
//   page_id      = META_DIAG_PAGE_ID
//   ad_type      = ALL
//   ad_status    = ALL
//   search_terms = empty string (removes it as a variable for B/C groups)
//   media_type   = omitted (not a suspect in Phase 2)

function buildTestMatrix(pageId: string, searchTerms: string, country: string): TestCase[] {
  // Prebuilt country format strings
  const countrySingleQuote = `['${country}']`; // current production format → ['SG']
  const countryDoubleQuote = `["${country}"]`; //                           → ["SG"]
  const countryBare        = country;           // bare ISO code             → SG

  return [
    // ── Group A: ad_reached_countries format ──────────────────────────────────
    // All A tests: search_terms=keyword, page_id set, ad_type=ALL, status=ALL
    {
      id: 'A1',
      group: 'A',
      label: `country=['${country}'] single-quote array — current production format`,
      searchTerms,
      pageId,
      adReachedCountries: countrySingleQuote,
      adType: 'ALL',
      adActiveStatus: 'ALL',
      mediaType: null,
    },
    {
      id: 'A2',
      group: 'A',
      label: `country=["${country}"] double-quote array`,
      searchTerms,
      pageId,
      adReachedCountries: countryDoubleQuote,
      adType: 'ALL',
      adActiveStatus: 'ALL',
      mediaType: null,
    },
    {
      id: 'A3',
      group: 'A',
      label: `country=${country} bare ISO code — no brackets or quotes`,
      searchTerms,
      pageId,
      adReachedCountries: countryBare,
      adType: 'ALL',
      adActiveStatus: 'ALL',
      mediaType: null,
    },
    {
      id: 'A4',
      group: 'A',
      label: `country OMITTED — no ad_reached_countries parameter`,
      searchTerms,
      pageId,
      adReachedCountries: null,
      adType: 'ALL',
      adActiveStatus: 'ALL',
      mediaType: null,
    },

    // ── Group B: ad_type case and presence ────────────────────────────────────
    // All B tests: search_terms=empty, page_id set, country=bare SG, status=ALL
    {
      id: 'B1',
      group: 'B',
      label: `ad_type=ALL (uppercase) — current production value`,
      searchTerms: '',
      pageId,
      adReachedCountries: countryBare,
      adType: 'ALL',
      adActiveStatus: 'ALL',
      mediaType: null,
    },
    {
      id: 'B2',
      group: 'B',
      label: `ad_type=all (lowercase)`,
      searchTerms: '',
      pageId,
      adReachedCountries: countryBare,
      adType: 'all',
      adActiveStatus: 'ALL',
      mediaType: null,
    },
    {
      id: 'B3',
      group: 'B',
      label: `ad_type OMITTED — no ad_type parameter`,
      searchTerms: '',
      pageId,
      adReachedCountries: countryBare,
      adType: null,
      adActiveStatus: 'ALL',
      mediaType: null,
    },

    // ── Group C: ad_active_status case and value ──────────────────────────────
    // All C tests: search_terms=empty, page_id set, country=bare SG, ad_type=ALL
    {
      id: 'C1',
      group: 'C',
      label: `ad_active_status=ALL (uppercase) — current production value`,
      searchTerms: '',
      pageId,
      adReachedCountries: countryBare,
      adType: 'ALL',
      adActiveStatus: 'ALL',
      mediaType: null,
    },
    {
      id: 'C2',
      group: 'C',
      label: `ad_active_status=ACTIVE (uppercase)`,
      searchTerms: '',
      pageId,
      adReachedCountries: countryBare,
      adType: 'ALL',
      adActiveStatus: 'ACTIVE',
      mediaType: null,
    },
    {
      id: 'C3',
      group: 'C',
      label: `ad_active_status=active (lowercase)`,
      searchTerms: '',
      pageId,
      adReachedCountries: countryBare,
      adType: 'ALL',
      adActiveStatus: 'active',
      mediaType: null,
    },
    {
      id: 'C4',
      group: 'C',
      label: `ad_active_status=all (lowercase)`,
      searchTerms: '',
      pageId,
      adReachedCountries: countryBare,
      adType: 'ALL',
      adActiveStatus: 'all',
      mediaType: null,
    },

    // ── Group D: search_terms presence ────────────────────────────────────────
    // All D tests: page_id set, country=bare SG, ad_type=ALL, status=ALL
    {
      id: 'D1',
      group: 'D',
      label: `search_terms="${searchTerms}" (keyword present)`,
      searchTerms,
      pageId,
      adReachedCountries: countryBare,
      adType: 'ALL',
      adActiveStatus: 'ALL',
      mediaType: null,
    },
    {
      id: 'D2',
      group: 'D',
      label: `search_terms="" (empty string — parameter present but blank)`,
      searchTerms: '',
      pageId,
      adReachedCountries: countryBare,
      adType: 'ALL',
      adActiveStatus: 'ALL',
      mediaType: null,
    },
    {
      id: 'D3',
      group: 'D',
      label: `search_terms OMITTED — parameter not sent at all`,
      searchTerms: null,
      pageId,
      adReachedCountries: countryBare,
      adType: 'ALL',
      adActiveStatus: 'ALL',
      mediaType: null,
    },
  ];
}

// ─── Print helpers ────────────────────────────────────────────────────────────

function printResult(result: TestResult): void {
  const { testCase, count, samples, redactedUrl, error } = result;
  const icon = error ? '✗' : count > 0 ? '✓' : '○';
  const countLabel = error ? 'ERROR' : `${count} ad(s)`;

  console.log(`\n  ${icon} ${testCase.id} [Group ${testCase.group}]: ${testCase.label}`);
  console.log(`    Result: ${countLabel}`);
  console.log(`    URL:    ${redactedUrl}`);

  if (error) {
    console.log(`    Error:  ${error}`);
    return;
  }

  if (samples.length === 0) {
    console.log('    Sample: (none)');
    return;
  }

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    console.log(
      `    [${i + 1}] id=${s.id}  page_name="${s.page_name}"  page_id=${s.page_id}  platforms=${s.platforms}`,
    );
  }
}

function printSummaryTable(results: TestResult[]): void {
  const LINE = '─'.repeat(63);
  console.log(`\n${'═'.repeat(63)}`);
  console.log('  SUMMARY TABLE');
  console.log('═'.repeat(63));
  console.log('');

  let currentGroup = '';
  for (const result of results) {
    if (result.testCase.group !== currentGroup) {
      currentGroup = result.testCase.group;
      const groupLabel =
        currentGroup === 'A' ? 'Group A — ad_reached_countries format' :
        currentGroup === 'B' ? 'Group B — ad_type case and presence' :
        currentGroup === 'C' ? 'Group C — ad_active_status case and value' :
                               'Group D — search_terms presence';
      console.log(`  ${LINE}`);
      console.log(`  ${groupLabel}`);
      console.log(`  ${LINE}`);
    }

    const icon = result.error ? '✗' : result.count > 0 ? '✓' : '○';
    const countCell = result.error ? ' ERR' : String(result.count).padStart(4);
    const desc = result.testCase.label.slice(0, 50);
    console.log(`  ${icon} ${result.testCase.id.padEnd(3)}  ${countCell}  ${desc}`);
  }

  console.log(`  ${LINE}`);
  console.log('');
}

function printDiagnosis(results: TestResult[]): void {
  const LINE = '─'.repeat(63);
  console.log(`${'═'.repeat(63)}`);
  console.log('  DIAGNOSIS');
  console.log('═'.repeat(63));
  console.log('');

  const hit  = (id: string) => (results.find((r) => r.testCase.id === id)?.count ?? 0) > 0;
  const hasErr = (id: string) => results.find((r) => r.testCase.id === id)?.error !== null;

  const findings: string[] = [];

  // Group A: country format
  const aHits = ['A1', 'A2', 'A3', 'A4'].filter(hit);
  if (aHits.length === 0) {
    findings.push(
      `Group A (country format): all 4 variants returned 0. ` +
      `Country format is not the differentiating factor — the issue lies elsewhere. ` +
      `Check Group B, C, and D findings.`,
    );
  } else {
    for (const id of aHits) {
      const label = results.find((r) => r.testCase.id === id)?.testCase.label ?? id;
      findings.push(`✓ ${id} returns ads: ${label}`);
    }
    const failing = ['A1', 'A2', 'A3', 'A4'].filter((id) => !hit(id) && !hasErr(id));
    if (failing.length > 0) {
      findings.push(
        `○ These country formats returned 0: ${failing.join(', ')}. ` +
        `The working format(s) above should be used in production.`,
      );
    }
  }

  // Group B: ad_type
  const bHits = ['B1', 'B2', 'B3'].filter(hit);
  if (bHits.length === 0) {
    findings.push(
      `Group B (ad_type): all variants (ALL, all, omitted) returned 0. ` +
      `ad_type format is not the differentiating factor.`,
    );
  } else {
    findings.push(
      `Group B (ad_type): results for — ${bHits.join(', ')}. ` +
      `Adjust production ad_type value accordingly.`,
    );
  }

  // Group C: ad_active_status
  const cHits = ['C1', 'C2', 'C3', 'C4'].filter(hit);
  if (cHits.length === 0) {
    findings.push(
      `Group C (ad_active_status): ALL, ACTIVE, active, all — all returned 0. ` +
      `ad_active_status format is not the differentiating factor.`,
    );
  } else {
    findings.push(
      `Group C (ad_active_status): results for — ${cHits.join(', ')}. ` +
      `Adjust production ad_active_status value accordingly.`,
    );
  }

  // Group D: search_terms
  const dHits = ['D1', 'D2', 'D3'].filter(hit);
  if (dHits.length === 0) {
    findings.push(
      `Group D (search_terms): keyword, empty string, and omitted all returned 0. ` +
      `search_terms is not the differentiating factor for this page ID.`,
    );
  } else {
    const working  = dHits.map((id) => results.find((r) => r.testCase.id === id)?.testCase.label ?? id);
    findings.push(
      `Group D (search_terms): results found. Working variant(s): ${working.join(' | ')}`,
    );
  }

  // Overall
  const totalHits = results.filter((r) => r.count > 0).length;
  if (totalHits === 0) {
    findings.push(
      `⚠  All 14 tests returned 0. Parameter formatting is not the issue. ` +
      `Likely causes to investigate next: ` +
      `(1) Token lacks ads_read permission or is scoped to wrong app, ` +
      `(2) The Meta Page ID ${results.find((r) => r.testCase.pageId !== null)?.testCase.pageId ?? '(unknown)'} does not serve ads visible to this token, ` +
      `(3) The token is valid but the associated Meta app has not been approved for the Ad Library API.`,
    );
  }

  for (const f of findings) {
    console.log(`  ${f}`);
    console.log('');
  }

  if (totalHits === 0) {
    console.log(LINE);
    console.log('  Suggested next checks (outside this codebase):');
    console.log(LINE);
    console.log('  1. Test the token manually:');
    console.log('     curl "https://graph.facebook.com/v25.0/me?access_token=YOUR_TOKEN"');
    console.log('     Should return your user/app ID and name.');
    console.log('');
    console.log('  2. Check token permissions:');
    console.log('     curl "https://graph.facebook.com/v25.0/me/permissions?access_token=YOUR_TOKEN"');
    console.log('     Must include: ads_read');
    console.log('');
    console.log('  3. Try the Ad Library API with no filters in the browser:');
    console.log('     https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=SG&q=Castlery');
    console.log('     Confirm ads are visible without a login token.');
    console.log('');
    console.log('  4. Check if your Meta app has Ad Library API access approved at:');
    console.log('     https://developers.facebook.com/apps/YOUR_APP_ID/review/');
  }

  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const LINE = '═'.repeat(63);

  const token = process.env.META_ADLIB_TOKEN?.trim();
  if (!token) {
    console.error('\n❌ META_ADLIB_TOKEN is required.');
    console.error('   This script makes real API calls — simulation is not supported.');
    console.error('');
    console.error('   set META_ADLIB_TOKEN=<token>&& npm run meta:diagnose-params');
    process.exit(1);
  }

  const pageId      = (process.env.META_DIAG_PAGE_ID      ?? '374586035998186').trim();
  const searchTerms = (process.env.META_DIAG_SEARCH_TERMS ?? 'Castlery').trim();
  const country     = (process.env.META_DIAG_COUNTRY      ?? 'SG').trim();

  const tests = buildTestMatrix(pageId, searchTerms, country);

  console.log(`\n${LINE}`);
  console.log('  Meta Parameter Format Diagnostic — Phase 2');
  console.log(LINE);
  console.log(`  Page ID:       ${pageId}`);
  console.log(`  Search terms:  "${searchTerms}"`);
  console.log(`  Country:       ${country}`);
  console.log(`  Limit/test:    ${DIAG_LIMIT} ads`);
  console.log(`  Total tests:   ${tests.length}`);
  console.log(`  Groups:        A (country format)  B (ad_type)  C (ad_active_status)  D (search_terms)`);
  console.log(`  DB writes:     0`);
  console.log(`  Token:         present (redacted in all output)`);
  console.log(LINE);

  console.log('\n  Running tests...\n');

  const results: TestResult[] = [];

  for (const testCase of tests) {
    process.stdout.write(`  ${testCase.id}... `);
    const result = await runTest(testCase, token);
    results.push(result);
    process.stdout.write(
      result.error  ? `ERROR\n`          :
      result.count > 0 ? `${result.count} ad(s)\n` :
      `0\n`,
    );
  }

  console.log(`\n${LINE}`);
  console.log('  DETAILED RESULTS');
  console.log(LINE);

  for (const result of results) {
    printResult(result);
  }

  printSummaryTable(results);
  printDiagnosis(results);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('\n❌ Diagnostic failed:', redactToken(message));
  process.exit(1);
});
