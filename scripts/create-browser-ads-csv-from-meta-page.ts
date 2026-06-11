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

const NAV_TIMEOUT = 45_000;
const SETTLE = 2_500;
const SCROLL_PAUSE = 1_800;
const MAX_SCROLLS = 30;
const NO_GROWTH_LIMIT = 4;
const DETAIL_SETTLE = 2_000;
const ZERO_CARD_WAIT = 6_000;          // extra lazy-load wait before the 0-card reload
const ZERO_CARD_SIGNAL_TIMEOUT = 15_000; // wait for ad cards / no-active-ads state after reload

type AdInfo = { mediaType: string; startDate: string; copy: string; headline: string; landing: string };

function parsePageIdFromUrl(url: string): string {
  const m = url.match(/[?&]view_all_page_id=([0-9]+)/);
  return m ? m[1]! : '';
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

  try {
    note('navigating to Ad Library listing…');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(SETTLE);
    await dismissOverlays(page);
    await page.waitForTimeout(SETTLE);

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
      }

      let noGrowth = 0;
      for (let scroll = 0; scroll <= MAX_SCROLLS; scroll++) {
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
          for (const r of a.rejected) note(`ad ${a.id}: ${r}`);
        }
        if (ads.size >= MAX_ADS) break;
      }
      note(`scroll ${scroll}: page shows ${batch.length} card(s); +${added} new; total unique = ${ads.size}`);

      if (ads.size >= MAX_ADS) { note(`reached MAX_ADS (${MAX_ADS}) — stopping`); break; }
      noGrowth = added === 0 ? noGrowth + 1 : 0;
      if (noGrowth >= NO_GROWTH_LIMIT) { note(`no new ads for ${NO_GROWTH_LIMIT} scrolls — stopping`); break; }

      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
      await page.waitForTimeout(SCROLL_PAUSE);
      }

      if (ads.size > 0) break;            // found ads — no retry needed
      if (attempt === 2) note('still 0 cards after retry');
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
    note(`⚠ navigation/extraction error: ${err instanceof Error ? err.message : String(err)}`);
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
    const hasText = Boolean((info.copy && info.copy.trim()) || (info.headline && info.headline.trim()));
    const ready = Boolean(id) && known && hasText;
    const status = ready ? 'READY' : 'NEEDS_REVIEW';
    if (ready) readyCount++; else needsReviewCount++;

    const reasons: string[] = [];
    if (!id) reasons.push('no ad_id');
    if (!known) reasons.push(`media_type=${info.mediaType || 'UNKNOWN'}`);
    if (!hasText) reasons.push('no copy/headline');

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
      headline: info.headline || '',
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

  console.log(`${LINE}`);
  console.log(`  Extraction log: ${logPath}  (local only — do not commit)`);
  console.log('  No DB writes. No ingestion. One competitor per CSV.');
  console.log(`${LINE}\n`);
}

main().catch((err: unknown) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
