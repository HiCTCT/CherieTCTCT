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
 * Asset naming:
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
async function waitForModal(page: Page): Promise<BBox | null> {
  try { await page.waitForSelector('[role="dialog"]', { timeout: 4000 }); }
  catch { /* no dialog — ad may be main page content */ }
  const r = await page.evaluate(() => {
    for (const sel of ['[role="dialog"]', '[aria-modal="true"]']) {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        const b = el.getBoundingClientRect();
        if (b.width > 200 && b.height > 200)
          return { found: true as const, x: b.x, y: b.y, width: b.width, height: b.height };
      }
    }
    return { found: false as const };
  });
  return r.found ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
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
    function inB(b: DOMRect): boolean {
      if (!modal) return b.x > 100 && b.y > 40 && b.width < 900;
      return b.x >= modal.x - P && b.y >= modal.y - P &&
             b.x + b.width  <= modal.x + modal.width  + P &&
             b.y + b.height <= modal.y + modal.height + P;
    }
    type C = { score: number; x: number; y: number; width: number; height: number };
    const cands: C[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('div,section,article'))) {
      const b = el.getBoundingClientRect();
      if (!inB(b) || b.width < 200 || b.height < 200 || b.width > 900 || b.y < 40) continue;
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
 * Within the ad card, finds the specific creative element:
 *   VIDEO    — <video> element, walking up to player wrapper
 *   IMAGE    — largest CDN <img>
 *   CAROUSEL — largest CDN <img> (first card)
 * Falls back to adCardBBox when no specific element is found.
 */
async function findCreativeArea(
  page: Page, adCardBBox: BBox, mediaType: string,
): Promise<BBox | null> {
  const isVid = mediaType.trim().toUpperCase() === 'VIDEO';
  const r = await page.evaluate(({ card, vid }: { card: BBox; vid: boolean }) => {
    const P = 15;
    function inCard(b: DOMRect): boolean {
      return b.x >= card.x - P && b.y >= card.y - P &&
             b.x + b.width  <= card.x + card.width  + P &&
             b.y + b.height <= card.y + card.height + P;
    }
    if (vid) {
      for (const v of Array.from(document.querySelectorAll<HTMLElement>('video'))) {
        const b = v.getBoundingClientRect();
        if (!inCard(b) || b.width < 100 || b.height < 80) continue;
        let el: HTMLElement = v;
        for (let i = 0; i < 5; i++) {
          const p = el.parentElement;
          if (!p) break;
          const pb = p.getBoundingClientRect();
          if (pb.width <= b.width + 60 && pb.height <= b.height + 80 && inCard(pb)) el = p;
          else break;
        }
        const fb = el.getBoundingClientRect();
        return { found: true as const, x: fb.x, y: fb.y, width: fb.width, height: fb.height };
      }
    }
    let best: { x: number; y: number; width: number; height: number } | null = null;
    let bestA = 0;
    for (const img of Array.from(document.querySelectorAll<HTMLImageElement>(
      'img[src*="scontent"], img[src*="fbcdn.net"], img[src*="cdninstagram"]',
    ))) {
      const b = img.getBoundingClientRect();
      if (!inCard(b) || b.width < 150 || b.height < 100) continue;
      const a = b.width * b.height;
      if (a > bestA) { bestA = a; best = { x: b.x, y: b.y, width: b.width, height: b.height }; }
    }
    return best ? { found: true as const, ...best } : { found: false as const };
  }, { card: adCardBBox, vid: isVid });
  if (r.found) return { x: r.x, y: r.y, width: r.width, height: r.height };
  return adCardBBox; // last resort: use the full ad card
}

// ─── Screenshot helpers ───────────────────────────────────────────────────────

function bufferSig(buf: Buffer): string {
  return `${buf.length}|${buf.subarray(0, 1024).toString('base64')}`;
}

async function screenshotCreative(page: Page, bbox: BBox, outPath: string): Promise<void> {
  await page.screenshot({
    path: outPath,
    clip: {
      x:      Math.max(0, Math.floor(bbox.x)),
      y:      Math.max(0, Math.floor(bbox.y)),
      width:  Math.max(1, Math.ceil(bbox.width)),
      height: Math.max(1, Math.ceil(bbox.height)),
    },
  });
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

  dbg.playClicked = await clickPlayButton(page, creativeBBox);
  dbg.notes.push(`play: labelled button found=${dbg.playClicked}`);
  await page.waitForTimeout(2500);

  for (let i = 1; i <= 3; i++) {
    if (i > 1) await page.waitForTimeout(2000);
    const fp = path.join(outDir, `frame-0${i}.png`);
    await screenshotCreative(page, creativeBBox, fp);
    const sig = bufferSig(fs.readFileSync(fp));
    if (sigs.includes(sig)) {
      fs.unlinkSync(fp);
      dbg.notes.push(`frame-0${i}: duplicate — not saved`);
    } else {
      sigs.push(sig); files.push(fp);
      dbg.notes.push(`frame-0${i}: saved`);
    }
  }

  dbg.framesChanged = files.length > 1;

  if (files.length === 1) {
    dbg.notes.push('warning: only one unique frame — playback may not have started');
    fs.writeFileSync(
      path.join(outDir, 'video-capture-notes.txt'),
      `ad_id: ${path.basename(outDir)}\nOnly thumbnail captured. Playback may not have started.\n\n${dbg.notes.join('\n')}`,
      'utf-8',
    );
  }
  return files;
}

async function captureCarousel(
  page: Page, outDir: string, creativeBBox: BBox, dbg: DebugState,
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  const sigs:  string[] = [];

  for (let n = 1; n <= CAROUSEL_MAX; n++) {
    await page.waitForTimeout(600);
    const lbl  = String(n).padStart(2, '0');
    const fp   = path.join(outDir, `card-${lbl}.png`);

    await screenshotCreative(page, creativeBBox, fp);
    const sig = bufferSig(fs.readFileSync(fp));

    if (sigs.includes(sig)) {
      fs.unlinkSync(fp);
      dbg.notes.push(`card-${lbl}: duplicate — stopping`);
      dbg.carouselNextBtn = `stopped at card ${n} (duplicate)`;
      break;
    }
    sigs.push(sig); files.push(fp);
    dbg.notes.push(`card-${lbl}: saved`);
    console.log(`       card-${lbl}: saved`);

    if (n === CAROUSEL_MAX) break;

    const nxt = await findCarouselNextButton(page, creativeBBox);
    if (!nxt) {
      dbg.notes.push(`card-${lbl}: no next button — stopping`);
      dbg.carouselNextBtn = `not found after card ${n}`;
      break;
    }
    dbg.carouselNextBtn = `clicked at (${Math.round(nxt.x)},${Math.round(nxt.y)})`;

    // JS DOM click — reliable for React SPAs
    const dc = await page.evaluate((pos) => {
      const el = document.elementFromPoint(pos.x, pos.y) as HTMLElement | null;
      if (el) { el.click(); return true; }
      return false;
    }, nxt);
    if (!dc) await page.mouse.click(nxt.x, nxt.y);
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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  let captured   = 0;
  let skipped    = 0;
  let inactive   = 0;
  let failed     = 0;
  let noContainer = 0;

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
      const dbg       = newDebugState(mt);
      const modalBBox = await waitForModal(page);
      dbg.modalBBox   = modalBBox;
      dbg.notes.push(modalBBox
        ? `modal: ${Math.round(modalBBox.width)}×${Math.round(modalBBox.height)} at (${Math.round(modalBBox.x)},${Math.round(modalBBox.y)})`
        : 'modal: not found — using page layout');
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
      const creativeBBox = await findCreativeArea(page, adCardBBox, mt);
      dbg.creativeBBox   = creativeBBox;
      if (!creativeBBox) {
        dbg.stopReason = 'creative area not found in ad card';
        await saveDebugInfo(page, adId, outDir, dbg);
        console.log('    SKIPPED — could not identify modal creative container');
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
      failed++;
    } finally {
      await page.close();
    }
  }

  await browser.close();

  const outputFile = outputCsvPath(inputFile);
  fs.writeFileSync(outputFile, serializeCsv(headers, rows), 'utf-8');

  console.log('\n' + '═'.repeat(64));
  console.log(`  READY rows:       ${readyRows.length}`);
  console.log(`  Captured:         ${captured}`);
  console.log(`  Inactive/skipped: ${inactive}`);
  console.log(`  No container:     ${noContainer}`);
  console.log(`  Failed:           ${failed}`);
  console.log(`  Non-READY:        ${skipped}`);
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
