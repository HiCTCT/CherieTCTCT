/**
 * capture-browser-ad-assets.ts
 *
 * Reads an existing browser-collected CSV, opens each READY ad's
 * ad_library_url in Playwright/Chromium, captures the visible creative
 * assets, saves them locally, and writes a new enriched CSV with
 * creative_asset_path populated.
 *
 * NO DB writes. NO scoring. NO ingestion. NO Anthropic API calls.
 * This script only captures assets and produces the .with-assets.csv file.
 *
 * Usage:
 *   set BROWSER_ADS_FILE=data/imports/hipvan-browser-collected-ads-pilot-01.csv
 *   npm run browser:capture-assets
 *
 * Options (env vars):
 *   BROWSER_ADS_FILE   — input CSV path (required)
 *   HEADLESS=true      — run Chromium headless (default: headful)
 *
 * Output:
 *   data/imports/{original-name}.with-assets.csv
 *   data/creative-assets/{safeCompetitorName}/{ad_id}/
 *
 * Asset naming (quality-gated capture; video uses playback-confirmed frames):
 *   IMAGE    → image-01.png
 *   CAROUSEL → card-01.png, card-02.png, …
 *   VIDEO    → frame-01.png, frame-02.png
 */

import { parse } from 'csv-parse/sync';
import * as fs   from 'fs';
import * as path from 'path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

// ─── Config ───────────────────────────────────────────────────────────────────

const INPUT_FILE   = process.env.BROWSER_ADS_FILE ?? 'data/imports/hipvan-browser-collected-ads-pilot-01.csv';
const HEADLESS     = process.env.HEADLESS === 'true';
const ASSET_BASE   = 'data/creative-assets';
const NAV_TIMEOUT  = 25_000;  // ms — page navigation
const MEDIA_WAIT   = 15_000;  // ms — wait for media elements
const PAGE_SETTLE  = 2_500;   // ms — let React render after navigation
const OVERLAY_WAIT = 600;     // ms — after dismissing overlays
const CAROUSEL_MAX = 10;      // max cards per carousel

const DEBUG_CAPTURE_GLOBAL = process.env.DEBUG_CAPTURE === 'true';

// ─── Types ────────────────────────────────────────────────────────────────────

type BrowserAdRow = {
  collection_status: string;
  competitor_name:   string;
  meta_page_id:      string;
  ad_id:             string;
  ad_library_url:    string;
  media_type:        string;
  publisher_platforms:      string;
  ad_delivery_start_time:   string;
  ad_copy:           string;
  headline:          string;
  description:       string;
  landing_page_url:  string;
  notes:             string;
  visual_description:  string;
  creative_notes:      string;
  creative_asset_path?: string;
  [key: string]: string | undefined;
};

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function parseHeaders(rawCsv: string): string[] {
  // Extract the first line and split respecting quotes
  const firstLine = rawCsv.split('\n')[0] ?? '';
  // Simple unquote: remove surrounding quotes if present on each token
  return firstLine.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
}

function csvEscape(value: string | undefined): string {
  const v = String(value ?? '');
  // Quote if contains comma, double-quote, or newline
  if (v.includes(',') || v.includes('"') || v.includes('\n') || v.includes('\r')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function serializeCsv(headers: string[], rows: BrowserAdRow[]): string {
  const lines: string[] = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

function outputCsvPath(inputFile: string): string {
  const dir  = path.dirname(inputFile);
  const base = path.basename(inputFile, '.csv');
  return path.join(dir, `${base}.with-assets.csv`);
}

// ─── Asset path helpers ───────────────────────────────────────────────────────

function toSafeFolder(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function assetDir(competitorName: string, adId: string): string {
  const safe = toSafeFolder(competitorName) || 'unknown';
  return path.join(ASSET_BASE, safe, adId);
}

// ─── Active-ad detection ──────────────────────────────────────────────────────

/**
 * Phrases that definitively indicate the ad is unavailable or has ended.
 * Kept specific to avoid false positives on ad copy text.
 */
const INACTIVE_PHRASES: string[] = [
  'this ad is no longer available',
  'this ad is no longer running',
  "this content isn't available",
  'this content is unavailable',
  'we could not find this ad',
  'ad is no longer active',
  'this ad has ended',
  'something went wrong',
  'page not found',
];

/**
 * After page load, returns whether the ad appears to still be running.
 * A missing creative (no CDN images, no video) is treated as inactive.
 */
async function checkAdActive(page: Page): Promise<{ active: boolean; reason: string }> {
  let bodyText = '';
  try {
    bodyText = (await page.innerText('body')).toLowerCase();
  } catch {
    return { active: false, reason: 'could not read page text' };
  }

  for (const phrase of INACTIVE_PHRASES) {
    if (bodyText.includes(phrase)) {
      return { active: false, reason: `page contains: "${phrase}"` };
    }
  }

  // If no CDN media at all, assume the ad is unavailable
  const hasMedia = !!(
    await page.$('img[src*="scontent"], img[src*="fbcdn.net"], video')
  );
  if (!hasMedia) {
    return { active: false, reason: 'no creative media found on page' };
  }

  return { active: true, reason: 'active' };
}

// ─── Page helpers ─────────────────────────────────────────────────────────────

/** Dismiss Facebook cookie banners and login modals. */
async function dismissOverlays(page: Page): Promise<void> {
  const clickIfPresent = async (selectors: string[]): Promise<void> => {
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await el.click();
          await page.waitForTimeout(OVERLAY_WAIT);
          return;
        }
      } catch { /* ignore */ }
    }
  };

  // Cookie consent
  await clickIfPresent([
    '[data-testid="cookie-policy-manage-dialog-accept-button"]',
    'button:has-text("Allow all cookies")',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    '[aria-label="Allow all cookies"]',
  ]);

  // Login / sign-up modal close button
  await clickIfPresent([
    '[aria-label="Close"]',
    '[data-testid="dialog-close-button"]',
    'div[role="dialog"] [aria-label="Close"]',
  ]);
}

type BBox = { x: number; y: number; width: number; height: number };

// ─── Debug state ──────────────────────────────────────────────────────────────

type DebugState = {
  modalBBox:       BBox | null;
  adCardBBox:      BBox | null;
  creativeBBox:    BBox | null;
  mediaType:       string;
  playClicked:     boolean;
  framesChanged:   boolean;
  carouselNextBtn: string;
  stopReason:      string;
  notes:           string[];
};

function newDebugState(mt: string): DebugState {
  return {
    modalBBox: null, adCardBBox: null, creativeBBox: null,
    mediaType: mt, playClicked: false, framesChanged: false,
    carouselNextBtn: 'not attempted', stopReason: '', notes: [],
  };
}

// ─── Modal detection ──────────────────────────────────────────────────────────

/**
 * Waits up to 4 s for a [role="dialog"] to appear after navigation.
 * Returns its BBox if found; null when the ad is rendered as page content.
 */
async function waitForModal(page: Page): Promise<{ bbox: BBox | null; notes: string[] }> {
  try { await page.waitForSelector('[role="dialog"]', { timeout: 4000 }); }
  catch { /* no dialog — ad may be main page content */ }

  const r = await page.evaluate(() => {
    const elems: HTMLElement[] = [];
    for (const sel of ['[role="dialog"]', '[aria-modal="true"]']) {
      for (const e of Array.from(document.querySelectorAll<HTMLElement>(sel))) elems.push(e);
    }

    const log: string[] = [];
    let bestScore = -1;
    let best: { x: number; y: number; width: number; height: number; reason: string } | null = null;

    for (const el of elems) {
      const b = el.getBoundingClientRect();
      const dims = `${Math.round(b.width)}x${Math.round(b.height)} at (${Math.round(b.x)},${Math.round(b.y)})`;
      // Hard reject: too small or far-right narrow side panel (the old skinny-modal bug).
      if (b.width < 350 || b.height < 300) { log.push(`reject ${dims}: too small`); continue; }
      if (b.x > 900 && b.width < 450)      { log.push(`reject ${dims}: far-right narrow side panel`); continue; }

      const txt   = (el.textContent ?? '').toLowerCase();
      const ctrX  = b.x + b.width / 2;
      let score   = 0;
      let reason  = `w=${Math.round(b.width)} x=${Math.round(b.x)}`;

      if (txt.includes('link to ad')) { score += 6; reason += ' [link-to-ad]'; }
      if (txt.includes('library id')) { score += 3; reason += ' [library-id]'; }
      if (b.width >= 450)             { score += 3; reason += ' [wide]'; }
      if (ctrX < 900)                 { score += 2; reason += ' [centered]'; }
      if (b.x < 500)                  { score += 1; reason += ' [left-half]'; }

      log.push(`consider ${dims}: score=${score} ${reason}`);
      if (score > bestScore) {
        bestScore = score;
        best = { x: b.x, y: b.y, width: b.width, height: b.height, reason };
      }
    }

    if (!best) return { found: false as const, reason: 'no modal passed filters', log };
    return { found: true as const, ...best, log };
  });

  const notes: string[] = ['── Modal detection ──', ...r.log];
  if (r.found) {
    console.log(`    modal accepted: ${Math.round(r.width)}x${Math.round(r.height)} [${r.reason}]`);
    notes.push(`ACCEPTED modal: ${Math.round(r.width)}x${Math.round(r.height)} [${r.reason}]`);
    return { bbox: { x: r.x, y: r.y, width: r.width, height: r.height }, notes };
  }
  console.log(`    modal: not found (${r.reason})`);
  notes.push(`no modal accepted (${r.reason}) — using page layout`);
  return { bbox: null, notes };
}

// ─── Ad card detection ────────────────────────────────────────────────────────

/**
 * Finds the ad preview card (creative + Library ID + Active badge).
 * Searches inside modal if present; otherwise searches full page.
 */
async function findAdCard(page: Page, modalBBox: BBox | null): Promise<BBox | null> {
  const r = await page.evaluate((modal) => {
    const M = 'img[src*="scontent"], img[src*="fbcdn.net"], img[src*="cdninstagram"], video';
    const P = 30;
    type C = { score: number; x: number; y: number; width: number; height: number };
    const cands: C[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('div,section,article'))) {
      const b = el.getBoundingClientRect();
      const insideModal = !modal
        ? (b.x > 100 && b.y > 40 && b.width < 900)
        : (b.x >= modal.x - P && b.y >= modal.y - P &&
           b.x + b.width  <= modal.x + modal.width  + P &&
           b.y + b.height <= modal.y + modal.height + P);
      if (!insideModal || b.width < 200 || b.height < 200 || b.width > 900 || b.y < 40) continue;
      const txt = (el.textContent ?? '').toLowerCase();
      const mc  = el.querySelectorAll(M).length;
      if (mc === 0 && txt.length < 80) continue;
      let s = 0;
      if (mc > 0) s += 5;
      if (el.querySelector('img[src*="scontent"], img[src*="fbcdn.net"]')) s += 3;
      if (el.querySelector('video')) s += 3;
      if (txt.includes('library id')) s += 5;
      if (txt.includes('active'))     s += 2;
      if (b.width >= 300 && b.width <= 700) s += 2;
      if (b.height >= 300) s += 1;
      if (b.width > 700)   s -= 2;
      if (s >= 3) cands.push({ score: s, x: b.x, y: b.y, width: b.width, height: b.height });
    }
    if (!cands.length) return { found: false as const };
    cands.sort((a, b) => b.score - a.score);
    return { found: true as const, ...cands[0]! };
  }, modalBBox);
  return r.found ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}

// ─── Creative area detection ──────────────────────────────────────────────────

/**
 * Finds the specific creative element inside the ad card and rejects anything
 * that is not the real ad creative (Meta placeholder/empty-state illustrations,
 * static UI resources, emoji, SVG, profile avatars, logos, reaction icons, and
 * extreme-aspect banners/strips).
 *
 * Returns { bbox, notes }. A null bbox means "skip this row" — the caller must
 * NOT save a misleading asset. `notes` carries a full per-candidate audit trail
 * for debug-container-info.
 *
 *   VIDEO    — <video> player region (>= MIN), falls back to poster image region
 *   IMAGE    — largest real creative <img> (>= MIN), never the modal/card itself
 *   CAROUSEL — real-creative card viewport (>= 280x250), never a tiny image tile
 *
 * NOTE: every page.evaluate() body below is fully inlined — no named helper
 * functions or `const x = () =>` assignments inside evaluate — because tsx/esbuild
 * runs with keepNames and would inject `__name(...)` calls that crash in the
 * browser context (ReferenceError: __name is not defined). Do not refactor the
 * evaluate bodies into named helpers.
 */
async function findCreativeArea(
  page: Page, adCardBBox: BBox, mediaType: string,
): Promise<{ bbox: BBox | null; notes: string[] }> {
  const mt = mediaType.trim().toUpperCase();
  const r  = await page.evaluate(({ card, mtype }: { card: BBox; mtype: string }) => {
    const P = 15;                 // inside-card slack (px)
    const MIN_W = 280;            // minimum real-creative width
    const MIN_H = 250;            // minimum real-creative height
    const log: string[] = [];

    // ── Pass 1: gather + classify every media candidate (inline, no helpers) ──
    type Cand = {
      el: HTMLElement; tag: string;
      x: number; y: number; w: number; h: number;
      natW: number; natH: number; ar: number;
      src: string; alt: string;
      inCard: boolean; inView: boolean; placeholder: boolean; reject: boolean; reason: string;
    };
    const cands: Cand[] = [];
    const vw = window.innerWidth  || 1280;
    const vh = window.innerHeight || 900;

    const mediaEls = Array.from(document.querySelectorAll<HTMLElement>(
      'img[src*="scontent"], img[src*="fbcdn.net"], img[src*="cdninstagram"], video',
    ));

    for (const el of mediaEls) {
      const b   = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const isImg = tag === 'img';
      const img = el as HTMLImageElement;
      const src = ((isImg ? (img.currentSrc || img.src) : (el.getAttribute('src') || '')) || '').toLowerCase();
      const alt = (el.getAttribute('alt') || '').toLowerCase();
      const natW = isImg ? (img.naturalWidth  || 0) : b.width;
      const natH = isImg ? (img.naturalHeight || 0) : b.height;
      const ar   = b.height > 0 ? b.width / b.height : 0;

      const inCard = b.x >= card.x - P && b.y >= card.y - P &&
        b.x + b.width  <= card.x + card.width  + P &&
        b.y + b.height <= card.y + card.height + P;

      // Visible in the current viewport (at least partially). Guards against
      // off-screen duplicate ads further down the page (e.g. y=2094) that would
      // produce an out-of-bounds screenshot clip.
      const inView = b.width > 0 && b.height > 0 &&
        b.x < vw && b.x + b.width > 0 && b.y < vh && b.y + b.height > 0;

      // Placeholder / non-creative classification (most-specific first).
      let placeholder = false; let preason = '';
      if (src.startsWith('data:'))                              { placeholder = true; preason = 'data-uri'; }
      else if (src.includes('.svg'))                            { placeholder = true; preason = 'svg-asset'; }
      else if (src.includes('rsrc.php'))                        { placeholder = true; preason = 'fb-static-resource(rsrc.php)'; }
      else if (src.includes('/emoji.php') || src.includes('/images/emoji')) { placeholder = true; preason = 'emoji'; }
      else if (src.includes('static.') && src.includes('fbcdn')) { placeholder = true; preason = 'fb-static-host'; }
      else if (src.includes('safe_image'))                      { placeholder = true; preason = 'safe_image-proxy'; }
      else if (alt.includes('profile') || alt.includes('avatar') || alt.includes('logo')) { placeholder = true; preason = `alt:${alt.slice(0, 24)}`; }

      // Soft reject (not placeholder, but probably not the creative): outside card,
      // avatar/icon-sized, or extreme-aspect strip. Thresholds are deliberately
      // loose so real creatives are kept; placeholder rejection above is the strict
      // gate. Selection falls back to non-placeholder candidates if soft rejects
      // would otherwise leave nothing.
      let reject = placeholder; let reason = preason;
      if (!reject) {
        if (!inCard)                              { reject = true; reason = 'outside-card'; }
        else if (!inView)                         { reject = true; reason = `off-screen y=${Math.round(b.y)}`; }
        else if (b.width < 120 || b.height < 90)  { reject = true; reason = `too-small ${Math.round(b.width)}x${Math.round(b.height)}`; }
        else if (isImg && natW > 0 && natW < 80)  { reject = true; reason = `icon-res natW=${natW}`; }
        else if (tag === 'img' && (ar > 6 || ar < 0.18)) { reject = true; reason = `extreme-aspect ar=${ar.toFixed(2)}`; }
      }

      cands.push({
        el, tag, x: b.x, y: b.y, w: b.width, h: b.height,
        natW, natH, ar, src, alt, inCard, inView, placeholder, reject, reason,
      });

      const srcSnip = src ? src.replace(/^https?:\/\//, '').slice(0, 48) : '(no src)';
      log.push(
        `cand ${tag} ${Math.round(b.width)}x${Math.round(b.height)} at (${Math.round(b.x)},${Math.round(b.y)}) ar=${ar.toFixed(2)} natW=${natW} ` +
        `src=${srcSnip} alt="${alt.slice(0, 20)}" inCard=${inCard} inView=${inView} ` +
        `${placeholder ? 'PLACEHOLDER' : (reject ? 'REJECT' : 'ok')}${reason ? ` (${reason})` : ''}`,
      );
    }

    // ── VIDEO ──────────────────────────────────────────────────────────────
    if (mtype === 'VIDEO') {
      // Prefer a real <video>; if collapsed/too short, fall back to poster image.
      let seed: Cand | null = null;
      for (const c of cands) if (c.tag === 'video' && c.inCard && !c.reject && c.h >= 120) { seed = c; break; }
      if (!seed) for (const c of cands) if (c.tag === 'video' && c.inCard && !c.reject) { seed = c; break; }
      if (!seed) {
        // No usable <video>: use the largest non-placeholder poster image. Try
        // strict (non-reject) first, then any non-placeholder image >= 80x80.
        let bestA = 0;
        for (const c of cands) {
          if (c.tag !== 'img' || c.reject) continue;
          const a = c.w * c.h;
          if (a > bestA) { bestA = a; seed = c; }
        }
        if (!seed) {
          for (const c of cands) {
            if (c.tag !== 'img' || c.placeholder || !c.inCard || !c.inView || c.w < 80 || c.h < 80) continue;
            const a = c.w * c.h;
            if (a > bestA) { bestA = a; seed = c; }
          }
          if (seed) log.push('video fallback: largest non-placeholder in-card image');
        }
        if (seed) log.push('no usable <video> — falling back to poster image region');
      }
      if (!seed) return { found: false as const, notes: [...log, 'no real video/poster creative in card'] };

      // Walk up to the player container: largest squareish ancestor inside the
      // card that is not the full card and is >= MIN.
      let best = { x: seed.x, y: seed.y, width: seed.w, height: seed.h };
      let cur: HTMLElement | null = seed.el.parentElement; let depth = 0;
      while (cur && depth < 8) {
        const cb = cur.getBoundingClientRect();
        const curIn = cb.x >= card.x - P && cb.y >= card.y - P &&
          cb.x + cb.width  <= card.x + card.width  + P &&
          cb.y + cb.height <= card.y + card.height + P;
        if (!curIn) break;
        if (cb.width >= card.width - 5 && cb.height >= card.height - 5) break;
        const car = cb.height > 0 ? cb.width / cb.height : 0;
        if (cb.width >= MIN_W && cb.height >= MIN_H && car >= 0.5 && car <= 2.2 &&
            cb.width * cb.height >= best.width * best.height) {
          best = { x: cb.x, y: cb.y, width: cb.width, height: cb.height };
        }
        cur = cur.parentElement; depth++;
      }
      log.push(`video region ${Math.round(best.width)}x${Math.round(best.height)} at (${Math.round(best.x)},${Math.round(best.y)})`);
      return { found: true as const, ...best, notes: log };
    }

    // ── CAROUSEL ─────────────────────────────────────────────────────────────
    if (mtype === 'CAROUSEL') {
      let best: { x: number; y: number; width: number; height: number } | null = null;
      let bestScore = -1;
      for (const c of cands) {
        if (c.tag !== 'img' || c.reject) continue;
        // Walk up: collect the smallest squareish ancestor >= MIN that is inside
        // the card but not the full card (the visible carousel card viewport).
        let cur: HTMLElement | null = c.el.parentElement; let depth = 0;
        while (cur && depth < 15) {
          const cb = cur.getBoundingClientRect();
          const curIn = cb.x >= card.x - P && cb.y >= card.y - P &&
            cb.x + cb.width  <= card.x + card.width  + P &&
            cb.y + cb.height <= card.y + card.height + P;
          if (!curIn) break;
          if (cb.width >= card.width - 5 && cb.height >= card.height - 5) break;
          if (cb.width >= MIN_W && cb.height >= MIN_H) {
            const car = cb.height > 0 ? cb.width / cb.height : 0;
            // Prefer squarer, larger viewports.
            const score = (cb.width * cb.height) - Math.abs(1 - car) * 60000;
            if (score > bestScore) {
              bestScore = score;
              best = { x: cb.x, y: cb.y, width: cb.width, height: cb.height };
              log.push(`-> viewport ${Math.round(cb.width)}x${Math.round(cb.height)} ar=${car.toFixed(2)} [candidate]`);
            }
            break; // smallest qualifying ancestor for this image
          }
          cur = cur.parentElement; depth++;
        }
      }
      if (!best) return { found: false as const, notes: [...log, 'no carousel viewport >=280x250 inside card'] };
      return { found: true as const, ...best, notes: log };
    }

    // ── IMAGE ──────────────────────────────────────────────────────────────
    // Tier 1: largest non-soft-rejected, non-placeholder image.
    let best: { x: number; y: number; width: number; height: number } | null = null;
    let bestA = 0;
    for (const c of cands) {
      if (c.tag !== 'img' || c.reject) continue;
      const a = c.w * c.h;
      if (a > bestA) { bestA = a; best = { x: c.x, y: c.y, width: c.w, height: c.h }; }
    }
    // Tier 2 fallback: largest non-placeholder image >= 80x80 (ignores soft rejects
    // so a real creative is still captured rather than skipped).
    if (!best) {
      for (const c of cands) {
        if (c.tag !== 'img' || c.placeholder || !c.inCard || !c.inView || c.w < 80 || c.h < 80) continue;
        const a = c.w * c.h;
        if (a > bestA) { bestA = a; best = { x: c.x, y: c.y, width: c.w, height: c.h }; }
      }
      if (best) log.push('image fallback: largest non-placeholder in-card candidate');
    }
    // Tier 3: CSS background-image — Meta sometimes renders the creative as a div
    // with background-image instead of an <img> element; scan for CDN bg URLs.
    if (!best) {
      let t3A = 0;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('div,section,figure,span'))) {
        const b  = el.getBoundingClientRect();
        const ic = b.x >= card.x - P && b.y >= card.y - P &&
          b.x + b.width  <= card.x + card.width  + P &&
          b.y + b.height <= card.y + card.height + P;
        if (!ic || b.width < 120 || b.height < 90) continue;
        const iv = b.width > 0 && b.height > 0 &&
          b.x < (window.innerWidth || 1280) && b.y < (window.innerHeight || 900);
        if (!iv) continue;
        const bgImg = window.getComputedStyle(el).backgroundImage || '';
        if (!bgImg || bgImg === 'none') continue;
        const cdnBg = bgImg.includes('scontent') || bgImg.includes('fbcdn.net') || bgImg.includes('cdninstagram');
        if (!cdnBg) continue;
        const a = b.width * b.height;
        if (a > t3A) { t3A = a; best = { x: b.x, y: b.y, width: b.width, height: b.height }; }
      }
      if (best) log.push(`tier3 bg-image: ${Math.round(best.width)}x${Math.round(best.height)} (CSS background-image CDN source)`);
    }
    // Tier 4: Semantic layout crop — locate the "Library ID" text element inside the
    // card (the info footer); take everything ABOVE it as the visual creative area.
    // This works even when no <img> or bg-image CDN element is detectable.
    if (!best) {
      let libY: number | null = null;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('span,div,p,a,strong'))) {
        const txt = (el.textContent || '').toLowerCase().trim();
        if (!txt.includes('library id')) continue;
        const b  = el.getBoundingClientRect();
        const ic = b.x >= card.x - P && b.y >= card.y - P &&
          b.x + b.width  <= card.x + card.width  + P &&
          b.y + b.height <= card.y + card.height + P;
        if (!ic) continue;
        if (b.height > 80 || b.width > card.width * 0.95) continue; // skip card-sized containers
        if (libY === null || b.y < libY) libY = b.y;
      }
      if (libY !== null) {
        const vH = libY - card.y;
        if (vH >= 120 && vH <= card.height * 0.92) {
          const m = 6; // trim card border artefacts
          best = { x: card.x + m, y: card.y, width: card.width - m * 2, height: vH };
          log.push(`tier4 semantic-crop: upper ${Math.round(vH)}px of card (library-id anchor at y=${Math.round(libY)})`);
        } else {
          log.push(`tier4 semantic-crop: library-id at y=${Math.round(libY)}, visual area ${Math.round(vH)}px — out of range [120–${Math.round(card.height * 0.92)}]`);
        }
      } else {
        log.push('tier4 semantic-crop: library-id text not found inside card');
      }
    }
    if (best) log.push(`image accepted: ${Math.round(best.width)}x${Math.round(best.height)}`);
    return best
      ? { found: true as const, ...best, notes: log }
      : { found: false as const, notes: [...log, 'no real creative image found (all tiers exhausted)'] };

  }, { card: adCardBBox, mtype: mt });

  const notes: string[] = Array.isArray((r as any).notes) ? (r as any).notes as string[] : [];

  if (r.found) {
    // Final size gate. Carousel keeps the hard 280x250 minimum (reject tiny tiles).
    // Image/video only need a real creative region, not modal chrome, so the floor
    // is low — this is what stops legitimate creatives being over-rejected.
    if (mt === 'CAROUSEL' && (r.width < 280 || r.height < 250)) {
      notes.push(`REJECTED final: carousel ${Math.round(r.width)}x${Math.round(r.height)} below 280x250 minimum`);
      return { bbox: null, notes };
    }
    if ((mt === 'IMAGE' || mt === 'VIDEO') && (r.width < 120 || r.height < 90)) {
      notes.push(`REJECTED final: ${Math.round(r.width)}x${Math.round(r.height)} below 120x90 minimum`);
      return { bbox: null, notes };
    }
    return { bbox: { x: r.x, y: r.y, width: r.width, height: r.height }, notes };
  }

  // Not found → SKIP. Never fall back to the ad card / modal as a production asset.
  notes.push(
    mt === 'CAROUSEL'
      ? 'SKIP: carousel creative area too small or uncertain'
      : 'SKIP: could not identify real creative media inside modal',
  );
  return { bbox: null, notes };
}

// ─── Screenshot helpers ───────────────────────────────────────────────────────

function bufferSig(buf: Buffer): string {
  return `${buf.length}|${buf.subarray(0, 1024).toString('base64')}`;
}

async function screenshotCreative(page: Page, bbox: BBox, outPath: string): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1280, height: 900 };
  // Reject clips that fall entirely outside the rendered viewport (e.g. an
  // off-screen duplicate at y=2094). page.screenshot would otherwise throw
  // "Clipped area is either empty or outside the resulting image".
  if (bbox.x >= vp.width || bbox.y >= vp.height ||
      bbox.x + bbox.width <= 0 || bbox.y + bbox.height <= 0) {
    throw new Error(
      `creative bbox outside viewport (x=${Math.round(bbox.x)}, y=${Math.round(bbox.y)}, ` +
      `${Math.round(bbox.width)}x${Math.round(bbox.height)}, viewport ${vp.width}x${vp.height})`,
    );
  }
  // Clamp the clip to the viewport so it is always a valid screenshot region.
  const x = Math.max(0, Math.floor(bbox.x));
  const y = Math.max(0, Math.floor(bbox.y));
  const width  = Math.max(1, Math.min(Math.ceil(bbox.width),  vp.width  - x));
  const height = Math.max(1, Math.min(Math.ceil(bbox.height), vp.height - y));
  await page.screenshot({ path: outPath, clip: { x, y, width, height } });
}

// ─── Debug info ───────────────────────────────────────────────────────────────

async function saveDebugInfo(
  page: Page, adId: string, outDir: string, state: DebugState,
): Promise<void> {
  if (!DEBUG_CAPTURE_GLOBAL) return;
  fs.mkdirSync(outDir, { recursive: true });
  try { await page.screenshot({ path: path.join(outDir, `debug-full-page-${adId}.png`), fullPage: true }); }
  catch { /* ignore */ }
  if (state.modalBBox) {
    try { await page.screenshot({ path: path.join(outDir, `debug-modal-${adId}.png`), clip: state.modalBBox }); }
    catch { /* ignore */ }
  }
  if (state.adCardBBox) {
    try { await page.screenshot({ path: path.join(outDir, `debug-ad-card-${adId}.png`), clip: state.adCardBBox }); }
    catch { /* ignore */ }
  }
  if (state.creativeBBox) {
    try { await screenshotCreative(page, state.creativeBBox, path.join(outDir, `debug-selected-creative-${adId}.png`)); }
    catch { /* ignore */ }
  }
  const info = [
    `ad_id:                ${adId}`,
    `modal found:          ${state.modalBBox ? JSON.stringify(state.modalBBox) : 'no'}`,
    `ad card found:        ${state.adCardBBox ? JSON.stringify(state.adCardBBox) : 'no'}`,
    `creative bbox:        ${state.creativeBBox ? JSON.stringify(state.creativeBBox) : 'null'}`,
    `media type:           ${state.mediaType}`,
    `play clicked:         ${state.playClicked}`,
    `video frames changed: ${state.framesChanged}`,
    `carousel next btn:    ${state.carouselNextBtn}`,
    `stop reason:          ${state.stopReason || 'none'}`,
    '',
    '── Notes ──',
    ...state.notes,
  ].join('\n');
  fs.writeFileSync(path.join(outDir, `debug-container-info-${adId}.txt`), info, 'utf-8');
}

// ─── Play button helper ───────────────────────────────────────────────────────

async function clickPlayButton(page: Page, creativeBBox: BBox): Promise<boolean> {
  await page.mouse.move(
    creativeBBox.x + creativeBBox.width  / 2,
    creativeBBox.y + creativeBBox.height / 2,
  );
  await page.waitForTimeout(400);
  const labelled = await page.evaluate((bbox) => {
    for (const btn of Array.from(document.querySelectorAll<HTMLElement>(
      '[aria-label*="Play" i], [aria-label*="play" i], [data-testid*="play" i]',
    ))) {
      const r = btn.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      if (cx >= bbox.x && cx <= bbox.x + bbox.width && cy >= bbox.y && cy <= bbox.y + bbox.height) {
        btn.click(); return true;
      }
    }
    return false;
  }, creativeBBox);
  if (!labelled) {
    await page.mouse.click(
      creativeBBox.x + creativeBBox.width  / 2,
      creativeBBox.y + creativeBBox.height / 2,
    );
  }
  return labelled;
}

// ─── Carousel next-button helper ─────────────────────────────────────────────

async function findCarouselNextButton(
  page: Page, creativeBBox: BBox,
): Promise<{ x: number; y: number } | null> {
  // Hover right edge to reveal controls
  await page.mouse.move(
    creativeBBox.x + creativeBBox.width * 0.92,
    creativeBBox.y + creativeBBox.height / 2,
  );
  await page.waitForTimeout(500);

  // Strategy A: aria-label "next/forward/right" near creative right edge
  const sA = await page.evaluate((bbox) => {
    const rh = bbox.x + bbox.width * 0.5;
    const re = bbox.x + bbox.width;
    for (const btn of Array.from(document.querySelectorAll<HTMLElement>(
      '[aria-label*="next" i], [aria-label*="forward" i], [aria-label*="right" i], [data-testid*="next" i]',
    ))) {
      const r = btn.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      if (cx < rh || cx > re + 100) continue;
      if (cy < bbox.y - 60 || cy > bbox.y + bbox.height + 60) continue;
      return { x: cx, y: cy };
    }
    return null;
  }, creativeBBox);
  if (sA) return sA;

  // Strategy B: any small button near the right edge (post-hover reveal)
  return await page.evaluate((bbox) => {
    const rh = bbox.x + bbox.width * 0.55;
    const re = bbox.x + bbox.width;
    for (const btn of Array.from(document.querySelectorAll<HTMLElement>(
      'button, [role="button"], div[tabindex="0"]',
    ))) {
      const r = btn.getBoundingClientRect();
      if (!r.width || !r.height || r.width > 80) continue;
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      if (cx < rh || cx > re + 80) continue;
      if (cy < bbox.y + 20 || cy > bbox.y + bbox.height - 20) continue;
      return { x: cx, y: cy };
    }
    return null;
  }, creativeBBox);
}

// ─── Carousel central-card helper ────────────────────────────────────────────

/**
 * Within the carousel viewport, pick the SINGLE card whose centre is closest to
 * the viewport centre and return only that card's image bbox (clamped to the
 * viewport). This is what makes each card-NN.png contain one card instead of the
 * whole rail (neighbouring cards, side cards, arrows, CTAs).
 *
 * Inline-only page.evaluate body — no named helpers / `const x = () =>` inside
 * evaluate — to avoid the tsx/esbuild `__name` injection that crashes the browser.
 */
async function findCentralCard(
  page: Page, vp: BBox,
): Promise<{ bbox: BBox | null; notes: string[] }> {
  const r = await page.evaluate((view) => {
    const cx = view.x + view.width / 2;
    const log: string[] = [];
    type K = { x: number; y: number; w: number; h: number; dist: number; vis: number };
    const cands: K[] = [];
    for (const img of Array.from(document.querySelectorAll<HTMLImageElement>(
      'img[src*="scontent"], img[src*="fbcdn.net"], img[src*="cdninstagram"]',
    ))) {
      const b = img.getBoundingClientRect();
      const src = (img.currentSrc || img.src || '').toLowerCase();
      // Skip placeholder / UI resources.
      if (src.startsWith('data:') || src.includes('rsrc.php') || src.includes('.svg') ||
          (src.includes('static.') && src.includes('fbcdn'))) continue;
      // Must overlap the viewport.
      const ox = Math.min(b.x + b.width,  view.x + view.width)  - Math.max(b.x, view.x);
      const oy = Math.min(b.y + b.height, view.y + view.height) - Math.max(b.y, view.y);
      if (ox <= 0 || oy <= 0) continue;
      if (b.width < 100 || b.height < 100) continue;
      if (b.height < view.height * 0.35) continue; // too short to be a card image
      const vis  = (ox * oy) / (b.width * b.height);
      const dist = Math.abs((b.x + b.width / 2) - cx);
      cands.push({ x: b.x, y: b.y, w: b.width, h: b.height, dist, vis });
      log.push(`card-img ${Math.round(b.width)}x${Math.round(b.height)} at (${Math.round(b.x)},${Math.round(b.y)}) distFromCentre=${Math.round(dist)} vis=${vis.toFixed(2)}`);
    }
    if (!cands.length) return { found: false as const, log };
    // Prefer the most-centred card that is at least 60% visible; else most centred.
    cands.sort((a, b) => a.dist - b.dist);
    let pick = cands[0]!;
    for (const c of cands) { if (c.vis >= 0.6) { pick = c; break; } }
    // Clamp to the viewport so neighbouring/overflow cards are excluded.
    // A small pad includes the card frame/border without reaching adjacent cards.
    const PAD = 8;
    const x = Math.max(pick.x - PAD, view.x);
    const y = Math.max(pick.y - PAD, view.y);
    const right  = Math.min(pick.x + pick.w + PAD, view.x + view.width);
    const bottom = Math.min(pick.y + pick.h + PAD, view.y + view.height);
    log.push(`SELECTED central card at (${Math.round(pick.x)},${Math.round(pick.y)}) ${Math.round(pick.w)}x${Math.round(pick.h)} — closest to viewport centre, vis=${pick.vis.toFixed(2)}; ${cands.length - 1} neighbour card(s) excluded`);
    return { found: true as const, x, y, width: right - x, height: bottom - y, log };
  }, vp);

  const notes = Array.isArray((r as { log?: string[] }).log) ? (r as { log: string[] }).log : [];
  if (r.found && r.width >= 80 && r.height >= 80) {
    return { bbox: { x: r.x, y: r.y, width: r.width, height: r.height }, notes };
  }
  return { bbox: null, notes };
}

// ─── Capture functions ────────────────────────────────────────────────────────

async function captureImage(
  page: Page, outDir: string, creativeBBox: BBox,
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'image-01.png');
  await screenshotCreative(page, creativeBBox, out);
  return [out];
}

async function captureVideo(
  page: Page, outDir: string, creativeBBox: BBox, dbg: DebugState,
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  const sigs:  string[] = [];

  // ── Probe any <video> overlapping the creative area (inline, no helpers) ──
  const probe = await page.evaluate((bbox) => {
    for (const v of Array.from(document.querySelectorAll<HTMLVideoElement>('video'))) {
      const b = v.getBoundingClientRect();
      if (b.width < 40 || b.height < 40) continue;
      const overlap = !(b.x > bbox.x + bbox.width || b.x + b.width < bbox.x ||
                        b.y > bbox.y + bbox.height || b.y + b.height < bbox.y);
      if (!overlap) continue;
      return {
        hasVideo: true,
        currentTime: v.currentTime || 0,
        duration: (isFinite(v.duration) && v.duration > 0) ? v.duration : 0,
        paused: v.paused, muted: v.muted, readyState: v.readyState,
      };
    }
    return { hasVideo: false, currentTime: 0, duration: 0, paused: true, muted: false, readyState: 0 };
  }, creativeBBox);
  dbg.notes.push(`video probe: hasVideo=${probe.hasVideo} duration=${probe.duration.toFixed(2)} readyState=${probe.readyState}`);

  // ── Baseline thumbnail (pre-play) used to detect whether anything moved ──
  const thumbTmp = path.join(outDir, '.thumb.png');
  await screenshotCreative(page, creativeBBox, thumbTmp);
  const thumbSig = bufferSig(fs.readFileSync(thumbTmp));

  // ── Start playback: click the centre play button AND force the <video> ──
  dbg.playClicked = await clickPlayButton(page, creativeBBox);
  dbg.notes.push(`play: centre play button clicked (labelled=${dbg.playClicked})`);
  if (probe.hasVideo) {
    await page.evaluate((bbox) => {
      for (const v of Array.from(document.querySelectorAll<HTMLVideoElement>('video'))) {
        const b = v.getBoundingClientRect();
        if (b.width < 40 || b.height < 40) continue;
        const overlap = !(b.x > bbox.x + bbox.width || b.x + b.width < bbox.x ||
                          b.y > bbox.y + bbox.height || b.y + b.height < bbox.y);
        if (!overlap) continue;
        try { v.muted = true; const p = v.play(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch { /* play blocked */ }
        break;
      }
    }, creativeBBox);
  }

  // ── Capture frames across time; only frames that differ from the thumbnail
  //    (i.e. real playback) are saved. Sample across duration when known. ──
  const plan = (probe.duration > 1.5)
    ? [0.1, 0.3, 0.55, 0.8].map((f) => Math.max(0.5, probe.duration * f))
    : [1, 3, 5, 8];
  let prev = 0;
  for (let i = 0; i < plan.length; i++) {
    const waitMs = Math.max(200, Math.round((plan[i]! - prev) * 1000));
    prev = plan[i]!;
    await page.waitForTimeout(waitMs);
    const tmp = path.join(outDir, `.tmp-frame-${i + 1}.png`);
    await screenshotCreative(page, creativeBBox, tmp);
    const sig = bufferSig(fs.readFileSync(tmp));
    if (sig === thumbSig || sigs.includes(sig)) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
      dbg.notes.push(`frame@${plan[i]!.toFixed(1)}s: ${sig === thumbSig ? 'same as thumbnail (overlay/no playback)' : 'duplicate'} — skipped`);
      continue;
    }
    sigs.push(sig);
    const fp = path.join(outDir, `frame-0${files.length + 1}.png`);
    fs.renameSync(tmp, fp);
    files.push(fp);
    dbg.notes.push(`frame-0${files.length}: saved (t≈${plan[i]!.toFixed(1)}s)`);
  }

  // ── Post-play state for confirmation + summary ──
  const post = probe.hasVideo
    ? await page.evaluate((bbox) => {
        for (const v of Array.from(document.querySelectorAll<HTMLVideoElement>('video'))) {
          const b = v.getBoundingClientRect();
          if (b.width < 40 || b.height < 40) continue;
          const overlap = !(b.x > bbox.x + bbox.width || b.x + b.width < bbox.x ||
                            b.y > bbox.y + bbox.height || b.y + b.height < bbox.y);
          if (!overlap) continue;
          const anyV = v as unknown as { mozHasAudio?: boolean; webkitAudioDecodedByteCount?: number };
          const hasAudio = anyV.mozHasAudio === true || (typeof anyV.webkitAudioDecodedByteCount === 'number' && anyV.webkitAudioDecodedByteCount > 0);
          return { t: v.currentTime || 0, paused: v.paused, duration: (isFinite(v.duration) && v.duration > 0) ? v.duration : 0, hasAudio };
        }
        return { t: 0, paused: true, duration: 0, hasAudio: false };
      }, creativeBBox)
    : { t: 0, paused: true, duration: 0, hasAudio: false };

  const overlayVisible = await page.evaluate((bbox) => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(
      '[aria-label*="play" i], [data-testid*="play" i]',
    ))) {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) continue; // only the LARGE overlay
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      if (cx < bbox.x || cx > bbox.x + bbox.width || cy < bbox.y || cy > bbox.y + bbox.height) continue;
      const st = window.getComputedStyle(el);
      if (st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity || '1') > 0.1) return true;
    }
    return false;
  }, creativeBBox);

  const timeAdvanced = probe.hasVideo && (post.t - probe.currentTime) > 0.15;
  // Playback is "started" only with real evidence: a <video> whose currentTime
  // advanced, or (when there is no <video> at all) frames that actually changed.
  // A frame change alone is NOT trusted when a <video> exists, because a poster
  // image loading after the thumbnail would otherwise look like playback.
  const started = timeAdvanced || (!probe.hasVideo && files.length >= 1);
  dbg.framesChanged = files.length > 1;
  dbg.notes.push(`playback: started=${started} (frames=${files.length}, currentTime ${probe.currentTime.toFixed(2)}→${post.t.toFixed(2)}, overlayVisible=${overlayVisible})`);

  if (!started) {
    // Playback failed → keep exactly ONE thumbnail frame, clearly marked
    // thumbnail-only. If the loop captured a poster frame, keep that (more
    // informative); otherwise fall back to the pre-play thumbnail.
    if (files.length === 0) {
      const fp = path.join(outDir, 'frame-01.png');
      try { fs.renameSync(thumbTmp, fp); files.push(fp); } catch { /* keep going */ }
    } else {
      try { fs.unlinkSync(thumbTmp); } catch { /* best-effort */ }
      for (let k = files.length; k >= 2; k--) {
        try { fs.unlinkSync(path.join(outDir, `frame-0${k}.png`)); } catch { /* best-effort */ }
      }
      files.length = 1;
    }
    dbg.stopReason = 'video could not be played; thumbnail captured only';
    dbg.notes.push('VIDEO: playback NOT confirmed — saved thumbnail only (may show play overlay)');
    fs.writeFileSync(
      path.join(outDir, 'video-capture-notes.txt'),
      `ad_id: ${path.basename(outDir)}\n` +
      `video could not be played; thumbnail captured only\n` +
      `large play overlay visible: ${overlayVisible}\n` +
      `play button labelled-click: ${dbg.playClicked}\n`,
      'utf-8',
    );
  } else {
    if (files.length === 0) {
      // Playback confirmed (currentTime advanced) but the sampled frames looked
      // identical — keep one representative frame rather than returning nothing.
      const fp = path.join(outDir, 'frame-01.png');
      try { fs.renameSync(thumbTmp, fp); files.push(fp); } catch { /* best-effort */ }
      dbg.notes.push('VIDEO: playback confirmed but frames identical — saved one frame');
    } else {
      try { fs.unlinkSync(thumbTmp); } catch { /* best-effort */ }
    }
    dbg.notes.push(`VIDEO: playback confirmed — ${files.length} unique frame(s)`);
  }

  // ── Best-effort: capture the video SOURCE for richer later analysis ──
  // Preference order for downstream analysis: downloaded file > recording > frames.
  // Never break capture if any of this fails.
  let sourceUrl = '';
  let sourceDownloaded = false;
  const recordingSaved = false; // cropped per-element recording is not supported by
                                // Playwright (context recordVideo = whole page only),
                                // and we avoid whole-page recording — deferred by design.
  if (probe.hasVideo) {
    try {
      sourceUrl = await page.evaluate((bbox) => {
        for (const v of Array.from(document.querySelectorAll<HTMLVideoElement>('video'))) {
          const b = v.getBoundingClientRect();
          if (b.width < 40 || b.height < 40) continue;
          const overlap = !(b.x > bbox.x + bbox.width || b.x + b.width < bbox.x ||
                            b.y > bbox.y + bbox.height || b.y + b.height < bbox.y);
          if (!overlap) continue;
          // Prefer a <source> child with a real (non-blob) URL over a blob currentSrc.
          let best = v.currentSrc || v.src || '';
          for (const s of Array.from(v.querySelectorAll('source'))) {
            const su = s.getAttribute('src') || '';
            if (su && !su.startsWith('blob:')) { best = su; break; }
          }
          return best;
        }
        return '';
      }, creativeBBox);
    } catch { sourceUrl = ''; }

    if (sourceUrl) {
      try { fs.writeFileSync(path.join(outDir, 'video-source-url.txt'), sourceUrl + '\n', 'utf-8'); } catch { /* best-effort */ }
      // Only attempt a download for simple http(s) sources (blob:/MSE streams and
      // file: are not directly downloadable). Uses the page's request context so
      // cookies are preserved. Capped size, fully guarded.
      if (/^https?:\/\//i.test(sourceUrl)) {
        try {
          const resp = await page.context().request.get(sourceUrl, { timeout: 20000 });
          if (resp.ok()) {
            const buf = await resp.body();
            if (buf.length > 1000 && buf.length < 60 * 1024 * 1024) {
              fs.writeFileSync(path.join(outDir, 'video.mp4'), buf);
              sourceDownloaded = true;
            }
          }
        } catch { sourceDownloaded = false; }
      }
    }
  }
  dbg.notes.push(`video source: urlFound=${!!sourceUrl} downloaded=${sourceDownloaded}`);

  // Which input should the later analyser use for this row?
  const analysisInput = sourceDownloaded
    ? 'video file (video.mp4)'
    : recordingSaved
      ? 'browser recording (video-recording.webm)'
      : (started && files.length >= 1)
        ? 'sampled frames (frame-0N.png)'
        : 'sampled frames (thumbnail only)';

  // ── video-summary-notes.txt — TECHNICAL CAPTURE METADATA ONLY (always) ──
  fs.writeFileSync(
    path.join(outDir, 'video-summary-notes.txt'),
    [
      '# video-summary-notes — TECHNICAL CAPTURE METADATA ONLY.',
      '# This is NOT a semantic description of the ad. Content analysis happens later',
      '# (browser:preview / Claude Vision) using, in order of preference:',
      '#   downloaded video file > browser recording > sampled frames.',
      '',
      `ad_id: ${path.basename(outDir)}`,
      `playback started: ${started}`,
      `play button clicked: ${dbg.playClicked}`,
      `<video> element present: ${probe.hasVideo}`,
      `video duration (s): ${(probe.duration || post.duration) || 'unknown'}`,
      `currentTime reached (s): ${probe.hasVideo ? post.t.toFixed(2) : 'n/a'}`,
      `audio detected: ${probe.hasVideo ? (post.hasAudio ? 'yes' : 'unknown (muted for capture / not exposed)') : 'n/a'}`,
      `unique frames captured: ${files.length}`,
      `large play overlay remained visible: ${overlayVisible}`,
      `source URL found: ${sourceUrl ? 'yes' : 'no'}`,
      `source video downloaded: ${sourceDownloaded ? 'yes (video.mp4)' : 'no'}`,
      `browser recording saved: ${recordingSaved ? 'yes (video-recording.webm)' : 'no (cropped recording unsupported; deferred)'}`,
      `recommended analysis input: ${analysisInput}`,
      `on-screen text (DOM): `,
    ].join('\n') + '\n',
    'utf-8',
  );

  return files;
}

async function captureCarousel(
  page: Page, outDir: string, creativeBBox: BBox, dbg: DebugState,
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  const sigs:  string[] = [];

  dbg.notes.push(`carousel viewport: ${Math.round(creativeBBox.width)}x${Math.round(creativeBBox.height)} at (${Math.round(creativeBBox.x)},${Math.round(creativeBBox.y)})`);

  // ── card-01: crop to the single central card, not the whole rail ──
  await page.waitForTimeout(600);
  const c1   = await findCentralCard(page, creativeBBox);
  for (const ln of c1.notes) dbg.notes.push(`card-01 ${ln}`);
  const crop1 = c1.bbox ?? creativeBBox;
  if (!c1.bbox) dbg.notes.push('card-01: central card not found — using full viewport');
  const first = path.join(outDir, 'card-01.png');
  await screenshotCreative(page, crop1, first);
  let lastSig = bufferSig(fs.readFileSync(first));
  sigs.push(lastSig); files.push(first);
  dbg.notes.push(`card-01: saved (crop ${Math.round(crop1.width)}x${Math.round(crop1.height)})`);
  console.log('       card-01: saved');

  // ── card-02 … card-N: click next, require a visual change before saving ──
  for (let n = 2; n <= CAROUSEL_MAX; n++) {
    const lbl = String(n).padStart(2, '0');

    const nxt = await findCarouselNextButton(page, creativeBBox);
    if (!nxt) {
      dbg.notes.push(`card-${lbl}: no next arrow found — stopping`);
      dbg.carouselNextBtn = `not found after card ${n - 1}`;
      dbg.stopReason = `no next arrow found after card ${n - 1}`;
      break;
    }
    dbg.carouselNextBtn = `clicked at (${Math.round(nxt.x)},${Math.round(nxt.y)})`;

    // Safe DOM click. elementFromPoint can return a non-clickable node (SVG path,
    // span, text wrapper) with no .click(). Climb to the nearest real control,
    // guard typeof .click, fall back to synthetic MouseEvents, and never throw.
    const clicked = await page.evaluate((pos) => {
      try {
        const node = document.elementFromPoint(pos.x, pos.y) as Element | null;
        if (!node) return false;
        const ctrl = (node.closest('button,[role="button"],a,[tabindex]') as HTMLElement | null) || (node as HTMLElement);
        if (ctrl && typeof (ctrl as { click?: unknown }).click === 'function') {
          (ctrl as HTMLElement).click();
          return true;
        }
        const target: Element = ctrl || node;
        for (const type of ['mousedown', 'mouseup', 'click']) {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: pos.x, clientY: pos.y }));
        }
        return true;
      } catch {
        return false; // never throw from the click attempt
      }
    }, nxt);
    if (!clicked) {
      try { await page.mouse.click(nxt.x, nxt.y); }
      catch { dbg.notes.push(`card-${lbl}: all click attempts failed`); }
    }

    // Poll up to ~2.4 s for the creative to visually change. Each attempt
    // recomputes the central card and crops to it, so a saved card is one card.
    let changedSig: string | null = null;
    let usedCrop: BBox = creativeBBox;
    let pickedNote = '';
    const tmp = path.join(outDir, `.tmp-${lbl}.png`);
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.waitForTimeout(600);
      const cc = await findCentralCard(page, creativeBBox);
      usedCrop = cc.bbox ?? creativeBBox;
      for (const ln of cc.notes) if (ln.startsWith('SELECTED')) pickedNote = ln;
      await screenshotCreative(page, usedCrop, tmp);
      const sig = bufferSig(fs.readFileSync(tmp));
      if (sig !== lastSig && !sigs.includes(sig)) { changedSig = sig; break; }
    }

    if (!changedSig) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* temp cleanup best-effort */ }
      const dup = sigs.length > 1 ? 'duplicate card (reached end)' : 'no visual change after click (end or click failed)';
      dbg.notes.push(`card-${lbl}: ${dup} — stopping`);
      dbg.stopReason = `stopped after card ${n - 1}: ${dup}`;
      break;
    }

    const fp = path.join(outDir, `card-${lbl}.png`);
    fs.renameSync(tmp, fp);
    lastSig = changedSig; sigs.push(changedSig); files.push(fp);
    if (pickedNote) dbg.notes.push(`card-${lbl} ${pickedNote}`);
    dbg.notes.push(`card-${lbl}: saved (crop ${Math.round(usedCrop.width)}x${Math.round(usedCrop.height)}, visual change confirmed)`);
    console.log(`       card-${lbl}: saved`);

    if (n === CAROUSEL_MAX) { dbg.stopReason = `reached CAROUSEL_MAX (${CAROUSEL_MAX})`; }
  }

  if (files.length === 1 && !dbg.stopReason) {
    dbg.stopReason = 'only card-01 captured — no further cards detected';
  }
  return files;
}


async function main(): Promise<void> {
  const inputFile = path.resolve(INPUT_FILE);

  if (!fs.existsSync(inputFile)) {
    console.error(`\n❌ Input file not found: ${inputFile}`);
    console.error('   Set BROWSER_ADS_FILE to a valid CSV path.');
    process.exit(1);
  }

  const rawCsv  = fs.readFileSync(inputFile, 'utf-8');
  const rows    = parse(rawCsv, {
    columns:           true,
    skip_empty_lines:  true,
    relax_quotes:      true,
    trim:              false,
  }) as BrowserAdRow[];

  // Build ordered header list, adding creative_asset_path if absent
  let headers = parseHeaders(rawCsv);
  if (!headers.includes('creative_asset_path')) {
    headers = [...headers, 'creative_asset_path'];
  }

  const readyRows = rows.filter(
    (r) => (r.collection_status ?? '').trim().toUpperCase() === 'READY',
  );

  console.log('\n' + '═'.repeat(64));
  console.log('  capture-browser-ad-assets');
  console.log('═'.repeat(64));
  console.log(`  Input:      ${inputFile}`);
  console.log(`  Total rows: ${rows.length}   READY: ${readyRows.length}`);
  console.log(`  Mode:       ${HEADLESS ? 'headless' : 'headful (set HEADLESS=true to suppress)'}`);
  console.log('═'.repeat(64));

  if (readyRows.length === 0) {
    console.log('\n  No READY rows — nothing to capture.\n');
    process.exit(0);
  }

  const browser: Browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context: BrowserContext = await browser.newContext({
    viewport:  { width: 1280, height: 900 },
    // 2x pixel density → captured creatives are sharp, not blurry, when clipped.
    deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  let captured   = 0;
  let skipped    = 0;
  let inactive   = 0;
  let failed     = 0;
  let noContainer = 0;
  let qualitySkipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i]!;
    const rowNum = i + 2;

    const status = (row.collection_status ?? '').trim().toUpperCase();
    if (status !== 'READY') {
      console.log(`\n  Row ${rowNum} [${row.ad_id ?? '?'}] — SKIPPED (status: ${row.collection_status})`);
      skipped++;
      continue;
    }

    const mt   = (row.media_type      ?? '').trim().toUpperCase();
    const adId = (row.ad_id           ?? '').trim();
    const url  = (row.ad_library_url  ?? '').trim();
    const name = (row.competitor_name ?? '').trim();

    console.log(`\n  Row ${rowNum} [${adId}] ${mt}`);
    console.log(`  URL: ${url}`);

    if (!url) {
      console.log('    ❌ ad_library_url is blank — skipping');
      failed++;
      continue;
    }

    if (row.creative_asset_path?.trim()) {
      console.log(`    ↳ Already populated: ${row.creative_asset_path.trim()}`);
      captured++;
      continue;
    }

    const outDir  = assetDir(name, adId);
    const page: Page = await context.newPage();
    const dbg = newDebugState(mt); // hoisted so the catch block can persist debug on failure

    try {
      console.log('    navigating…');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await page.waitForTimeout(PAGE_SETTLE);
      await dismissOverlays(page);
      await page.waitForTimeout(PAGE_SETTLE);

      // Scroll slightly to trigger lazy-load of the creative image, then scroll back
      await page.evaluate(() => window.scrollTo(0, 250));
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.scrollTo(0, 0));

      // Wait up to 6 s for a reasonably-sized CDN image to load
      try {
        await page.waitForFunction(
          () => {
            const imgs = Array.from(
              document.querySelectorAll<HTMLImageElement>(
                'img[src*="scontent"], img[src*="fbcdn.net"], img[src*="cdninstagram"]',
              ),
            );
            return imgs.some((img) => img.naturalWidth > 200);
          },
          { timeout: 6000 },
        );
      } catch { /* proceed anyway — video-only or slow page */ }

      // ── Active-ad check ──────────────────────────────────────────────────
      const activeCheck = await checkAdActive(page);
      console.log(`    active status: ${activeCheck.active ? 'ACTIVE' : 'INACTIVE'} — ${activeCheck.reason}`);

      if (!activeCheck.active) {
        console.log('    SKIPPED — ad not active or unavailable');
        inactive++;
        await page.close();
        continue;
      }

      // ── 1. Modal detection ────────────────────────────────────────────────
      const modalRes  = await waitForModal(page);
      const modalBBox = modalRes.bbox;
      dbg.modalBBox   = modalBBox;
      for (const n of modalRes.notes) dbg.notes.push(n);
      console.log(`    modal: ${modalBBox
        ? `${Math.round(modalBBox.width)}×${Math.round(modalBBox.height)} at (${Math.round(modalBBox.x)},${Math.round(modalBBox.y)})`
        : 'not found'}`);

      // ── 2. Ad card detection ─────────────────────────────────────────────
      const adCardBBox = await findAdCard(page, modalBBox);
      dbg.adCardBBox   = adCardBBox;
      if (!adCardBBox) {
        dbg.stopReason = 'ad card not found';
        await saveDebugInfo(page, adId, outDir, dbg);
        console.log('    SKIPPED — could not identify modal creative container');
        noContainer++;
        await page.close();
        continue;
      }
      console.log(`    ad card: ${Math.round(adCardBBox.width)}×${Math.round(adCardBBox.height)} at (${Math.round(adCardBBox.x)},${Math.round(adCardBBox.y)})`);
      dbg.notes.push(`ad card: ${Math.round(adCardBBox.width)}×${Math.round(adCardBBox.height)} at (${Math.round(adCardBBox.x)},${Math.round(adCardBBox.y)})`);

      // ── 3. Creative area ─────────────────────────────────────────────────
      const { bbox: creativeBBox, notes: creativeNotes } = await findCreativeArea(page, adCardBBox, mt);
      for (const n of creativeNotes) dbg.notes.push(n);
      dbg.creativeBBox = creativeBBox;
      if (!creativeBBox) {
        dbg.stopReason  = creativeNotes[creativeNotes.length - 1] ?? 'creative area not found';
        await saveDebugInfo(page, adId, outDir, dbg);
        // Message is keyed off media type, not string-matching (so an IMAGE row
        // never reports a "carousel" skip reason).
        const skipMsg = mt === 'CAROUSEL'
          ? 'SKIPPED — carousel creative area too small or uncertain'
          : `SKIPPED — could not identify real creative media inside modal (${mt || 'unknown'})`;
        console.log(`    ${skipMsg}`);
        noContainer++;
        await page.close();
        continue;
      }
      console.log(`    creative: ${Math.round(creativeBBox.width)}×${Math.round(creativeBBox.height)} at (${Math.round(creativeBBox.x)},${Math.round(creativeBBox.y)})`);
      dbg.notes.push(`creative: ${Math.round(creativeBBox.width)}×${Math.round(creativeBBox.height)} at (${Math.round(creativeBBox.x)},${Math.round(creativeBBox.y)})`);

      // ── Dispatch ──────────────────────────────────────────────────────────
      let savedFiles: string[] = [];

      if (mt === 'CAROUSEL') {
        console.log('    capturing carousel…');
        savedFiles = await captureCarousel(page, outDir, creativeBBox, dbg);
      } else if (mt === 'IMAGE') {
        console.log('    capturing image…');
        savedFiles = await captureImage(page, outDir, creativeBBox);
      } else {
        console.log(`    capturing video frames (type: ${mt || 'unknown'})…`);
        savedFiles = await captureVideo(page, outDir, creativeBBox, dbg);
      }

      // ── Fail-safe: never mark a row captured unless a real asset was saved ──
      if (savedFiles.length === 0) {
        dbg.stopReason = dbg.stopReason || 'no real creative asset saved';
        await saveDebugInfo(page, adId, outDir, dbg);
        console.log('    SKIPPED — could not identify real creative media inside modal');
        qualitySkipped++;
        await page.close();
        continue;
      }

      await saveDebugInfo(page, adId, outDir, dbg);

      const relPath = path.relative(process.cwd(), outDir).replace(/\\/g, '/');
      row.creative_asset_path = relPath;
      captured++;

      console.log(`    ✅ ${savedFiles.length} file(s) saved → ${relPath}`);
      for (const f of savedFiles) {
        console.log(`       ${path.basename(f)}`);
      }

    } catch (err: unknown) {
      const msg   = err instanceof Error ? err.message : String(err);
      const short = msg.replace(/\n/g, ' ').slice(0, 140);
      console.log(`    ❌ Capture failed: ${short}`);
      // Persist debug info on failure too, so failed rows are diagnosable.
      dbg.stopReason = dbg.stopReason || `capture error: ${short}`;
      dbg.notes.push(`ERROR: ${short}`);
      try { await saveDebugInfo(page, adId, outDir, dbg); } catch { /* page may already be closed */ }
      failed++;
    } finally {
      await page.close();
    }
  }

  await browser.close();

  const outputFile = outputCsvPath(inputFile);
  fs.writeFileSync(outputFile, serializeCsv(headers, rows), 'utf-8');

  console.log('\n' + '═'.repeat(64));
  console.log(`  READY rows:           ${readyRows.length}`);
  console.log(`  Captured:             ${captured}`);
  console.log(`  Inactive/skipped:     ${inactive}`);
  console.log(`  No container:         ${noContainer}`);
  console.log(`  Skipped (no creative):${qualitySkipped}`);
  console.log(`  Failed:               ${failed}`);
  console.log(`  Non-READY:            ${skipped}`);
  console.log('─'.repeat(64));
  console.log(`  Output CSV:       ${outputFile}`);
  console.log(`  Asset folder:     ${path.resolve(ASSET_BASE)}`);
  if (DEBUG_CAPTURE_GLOBAL) console.log('  Debug mode:       ON (debug-* files saved per ad)');
  console.log('═'.repeat(64) + '\n');

  if (inactive > 0) {
    console.log(`  ℹ  ${inactive} ad(s) inactive/unavailable — creative_asset_path left blank.`);
    console.log('     These rows fall back to MANUAL text in browser:preview.\n');
  }
  if (failed > 0) {
    console.log(`  ⚠  ${failed} row(s) errored. creative_asset_path left blank.\n`);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n❌ Fatal error: ${msg}`);
  process.exit(1);
});

