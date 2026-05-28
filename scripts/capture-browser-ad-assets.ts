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
import type { Browser, BrowserContext, Page, ElementHandle } from 'playwright';

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

type ContainerHints = {
  competitorName?: string;
  headline?:       string;
  adCopy?:         string;
  description?:    string;
};

/**
 * Use the ad_id to locate the specific ad card container on the page.
 *
 * Meta Ad Library places the ad_id in link hrefs and/or visible "Library ID"
 * text. We find those references, walk up the DOM, and return the bounding box
 * of the smallest ancestor that (a) has a reasonable size and (b) contains
 * media elements.
 *
 * Returns null if the container cannot be reliably identified.
 */
async function findAdContainer(
  page:     Page,
  adId:     string,
  hints:    ContainerHints = {},
  debugOut: string[] = [],
): Promise<BBox | null> {

  // ── S1: ad_id in href or leaf text ────────────────────────────────────────
  debugOut.push('S1: searching ad_id in hrefs and leaf text');
  const s1 = await page.evaluate((id) => {
    const MEDIA_SEL = 'img[src*="scontent"], img[src*="fbcdn.net"], img[src*="cdninstagram"], video';
    const sources: Element[] = [
      ...Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
           .filter((a) => a.href.includes(id)),
      ...Array.from(document.querySelectorAll<HTMLElement>('span, div, p'))
           .filter((el) => {
             if (el.childElementCount > 0) return false;
             const t = (el.textContent ?? '').trim();
             return t === id || (t.includes(id) && t.length <= id.length + 25);
           }),
    ];
    for (const start of sources) {
      let el: HTMLElement | null = start as HTMLElement;
      let depth = 0;
      while (el && depth < 25) {
        el = el.parentElement; depth++;
        if (!el) break;
        const rect = el.getBoundingClientRect();
        if (rect.width < 280 || rect.height < 200 || rect.width > 1100) continue;
        if (el.querySelectorAll(MEDIA_SEL).length > 0)
          return { found: true as const, x: rect.x, y: rect.y, width: rect.width, height: rect.height, sources: sources.length };
      }
    }
    return { found: false as const, sources: sources.length };
  }, adId);

  if (s1.found) {
    debugOut.push('S1 success');
    return { x: s1.x, y: s1.y, width: s1.width, height: s1.height };
  }
  debugOut.push(`S1 failed: ${s1.sources} source(s) found, none led to a media container`);

  // ── S2: Walk up from "Library ID" label ──────────────────────────────────
  debugOut.push('S2: searching Library ID label');
  const s2 = await page.evaluate(() => {
    const MEDIA_SEL = 'img[src*="scontent"], img[src*="fbcdn.net"], img[src*="cdninstagram"], video';
    const labels = Array.from(document.querySelectorAll<HTMLElement>('span, div, p'))
      .filter((el) => (el.textContent ?? '').trim().toLowerCase().startsWith('library id'));
    for (const label of labels) {
      let el: HTMLElement | null = label as HTMLElement;
      let depth = 0;
      while (el && depth < 20) {
        el = el.parentElement; depth++;
        if (!el) break;
        const rect = el.getBoundingClientRect();
        if (rect.width < 280 || rect.height < 200 || rect.width > 1100) continue;
        if (el.querySelectorAll(MEDIA_SEL).length > 0)
          return { found: true as const, x: rect.x, y: rect.y, width: rect.width, height: rect.height, labels: labels.length };
      }
    }
    return { found: false as const, labels: labels.length };
  });

  if (s2.found) {
    debugOut.push('S2 success');
    return { x: s2.x, y: s2.y, width: s2.width, height: s2.height };
  }
  debugOut.push(`S2 failed: ${s2.labels} Library ID label(s), none led to a media container`);

  // ── S3: CSV text hints (headline / ad_copy / competitor_name) ────────────
  const hintPhrases: string[] = [];
  for (const raw of [hints.headline, hints.adCopy, hints.competitorName, hints.description]) {
    if (!raw?.trim()) continue;
    const phrase = raw.trim().split(/\s+/).slice(0, 4).join(' ').toLowerCase();
    if (phrase.length > 4) hintPhrases.push(phrase);
  }

  if (hintPhrases.length > 0) {
    debugOut.push(`S3: hint phrases: ${hintPhrases.join(' | ')}`);
    const s3 = await page.evaluate((phrases) => {
      const MEDIA_SEL = 'img[src*="scontent"], img[src*="fbcdn.net"], img[src*="cdninstagram"], video, img';
      const matches = Array.from(document.querySelectorAll<HTMLElement>('span, div, p, h1, h2, h3'))
        .filter((el) => {
          const t = (el.textContent ?? '').trim().toLowerCase();
          return t.length < 500 && phrases.some((ph) => t.includes(ph));
        });
      for (const start of matches) {
        let el: HTMLElement | null = start as HTMLElement;
        let depth = 0;
        while (el && depth < 20) {
          el = el.parentElement; depth++;
          if (!el) break;
          const rect = el.getBoundingClientRect();
          if (rect.width < 300 || rect.height < 250 || rect.width > 1000) continue;
          if (rect.x < 150 || rect.y < 40) continue;
          if (el.querySelectorAll(MEDIA_SEL).length > 0)
            return { found: true as const, x: rect.x, y: rect.y, width: rect.width, height: rect.height, matches: matches.length };
        }
      }
      return { found: false as const, matches: matches.length };
    }, hintPhrases);

    if (s3.found) {
      debugOut.push('S3 success');
      return { x: s3.x, y: s3.y, width: s3.width, height: s3.height };
    }
    debugOut.push(`S3 failed: ${s3.matches} text match(es), none led to a media container`);
  } else {
    debugOut.push('S3 skipped: no usable hint phrases');
  }

  // ── S4: Scored card scan — main ad card heuristic ────────────────────────
  // URL is already scoped to ?id=<adId>, so ANY card-like element on the
  // page is the right ad.  Score each candidate; return the best.
  debugOut.push('S4: scored card scan');
  const s4 = await page.evaluate(() => {
    type Cand = { score: number; x: number; y: number; width: number; height: number };
    const MEDIA_SEL = 'img, video, canvas';
    const CDN_SEL   = 'img[src*="scontent"], img[src*="fbcdn.net"], img[src*="cdninstagram"]';
    const candidates: Cand[] = [];

    for (const el of Array.from(document.querySelectorAll<HTMLElement>('div, section, article'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width  < 280  || rect.width  > 1000) continue;
      if (rect.height < 250) continue;
      if (rect.x      < 150) continue;
      if (rect.y      <  40) continue;
      if (rect.y      > 850) continue;

      const text      = (el.textContent ?? '').toLowerCase();
      const mediaCnt  = el.querySelectorAll(MEDIA_SEL).length;
      const cdnCnt    = el.querySelectorAll(CDN_SEL).length;
      const hasVideo  = !!el.querySelector('video');

      // Must have media OR substantial text
      if (mediaCnt === 0 && text.length < 80) continue;

      let score = 0;
      if (mediaCnt > 0) score += 3;
      if (cdnCnt   > 0) score += 3;
      if (hasVideo)     score += 2;
      if (text.includes('library id'))  score += 5;
      if (text.includes('active'))      score += 2;
      if (text.includes('sponsored'))   score += 1;
      // Centered on a 1280px viewport
      if (rect.x >= 250 && rect.x + rect.width <= 1050) score += 2;
      // Typical ad card width 300–700
      if (rect.width >= 300 && rect.width <= 700) score += 2;
      if (rect.height >= 400) score += 1;
      if (rect.width  >  800) score -= 3; // penalise wide wrappers

      candidates.push({ score, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }

    if (candidates.length === 0) return { found: false as const, candidates: 0, bestScore: 0 };
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0]!;
    return { found: true as const, ...best, candidates: candidates.length };
  });

  if (s4.found && s4.score >= 3) {
    debugOut.push(`S4 success: score=${s4.score}, candidates=${s4.candidates}`);
    return { x: s4.x, y: s4.y, width: s4.width, height: s4.height };
  }
  const s4cands = (s4 as any).candidates ?? 0;
  const s4score = (s4 as any).bestScore ?? (s4.found ? s4.score : 0);
  debugOut.push(`S4 failed: ${s4cands} candidate(s), best score=${s4score} (min 3)`);

  // ── S5: Broadest fallback — largest CDN media in plausible position ───────
  debugOut.push('S5: broad CDN media scan');
  const s5 = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(
      'img[src*="scontent"], img[src*="fbcdn.net"], img[src*="cdninstagram"], video',
    ));
    let best: { x: number; y: number; width: number; height: number } | null = null;
    let bestArea = 0;
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 100) continue;
      if (rect.x < 100 || rect.y < 40 || rect.y > 900) continue;
      const area = rect.width * rect.height;
      if (area > bestArea) { bestArea = area; best = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; }
    }
    return best ? { found: true as const, ...best } : { found: false as const };
  });

  if (s5.found) {
    debugOut.push('S5 success');
    return { x: s5.x, y: s5.y, width: s5.width, height: s5.height };
  }
  debugOut.push('S5 failed: no CDN media in plausible position');
  return null;
}
/**
 * Find the best creative media element within an optional container BBox.
 * When containerBBox is given, only elements whose centre falls inside it
 * are considered.  Falls back to page-wide search if nothing is found.
 */
async function findCreativeElement(
  page:          Page,
  containerBBox: BBox | null = null,
): Promise<ElementHandle | null> {

  function inBox(box: BBox): boolean {
    if (!containerBBox) return true;
    const cx = box.x + box.width  / 2;
    const cy = box.y + box.height / 2;
    return (
      cx >= containerBBox.x - 20 &&
      cx <= containerBBox.x + containerBBox.width  + 20 &&
      cy >= containerBBox.y - 20 &&
      cy <= containerBBox.y + containerBBox.height + 20
    );
  }

  const selectors = [
    'video',
    'img[src*="scontent"]',
    'img[src*="fbcdn.net"]',
    '[role="img"]',
  ];

  for (const sel of selectors) {
    try {
      const els  = await page.$$(sel);
      let best: ElementHandle | null = null;
      let bestArea = 0;
      for (const el of els) {
        const box = await el.boundingBox();
        if (!box || box.width < 100 || box.height < 80) continue;
        if (!inBox(box)) continue;
        const area = box.width * box.height;
        if (area > bestArea) { bestArea = area; best = el; }
      }
      if (best) return best;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Screenshot a container BBox region, falling back to element.screenshot(),
 * then to a wide viewport clip.
 */
async function screenshotRegion(
  page:          Page,
  containerBBox: BBox | null,
  outPath:       string,
): Promise<void> {
  // Prefer clip from the container bbox (consistent region every time)
  if (containerBBox) {
    try {
      await page.screenshot({
        path: outPath,
        clip: {
          x:      Math.max(0, containerBBox.x - 5),
          y:      Math.max(0, containerBBox.y - 5),
          width:  Math.min(1280, containerBBox.width  + 10),
          height: Math.min(900,  containerBBox.height + 10),
        },
      });
      return;
    } catch { /* fall through */ }
  }
  // Generic viewport fallback
  await page.screenshot({ path: outPath, clip: { x: 150, y: 80, width: 900, height: 720 } });
}

/** Save debug files when DEBUG_CAPTURE=true. */
async function saveDebugInfo(
  page:          Page,
  adId:          string,
  containerBBox: BBox | null,
  outDir:        string,
  strategy:      string,
  rejected:      string[],
  debugLines:    string[] = [],
): Promise<void> {
  if (!DEBUG_CAPTURE_GLOBAL) return;
  fs.mkdirSync(outDir, { recursive: true });
  try {
    await page.screenshot({ path: path.join(outDir, `debug-full-page-${adId}.png`), fullPage: true });
  } catch { /* ignore */ }
  if (containerBBox) {
    try {
      await page.screenshot({
        path: path.join(outDir, `debug-selected-container-${adId}.png`),
        clip: containerBBox,
      });
    } catch { /* ignore */ }
  }
  const info = [
    `ad_id: ${adId}`,
    `strategy: ${strategy}`,
    `container: ${containerBBox ? JSON.stringify(containerBBox) : 'null'}`,
    `rejected: ${rejected.join('; ') || 'none'}`,
    '',
    '── Container search log ──',
    ...debugLines,
  ].join('\n');
  fs.writeFileSync(path.join(outDir, `debug-container-info-${adId}.txt`), info, 'utf-8');
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Compute a visual signature for duplicate/change detection. */
function bufferSig(buf: Buffer): string {
  return `${buf.length}|${buf.subarray(0, 1024).toString('base64')}`;
}

// ─── Capture functions ────────────────────────────────────────────────────────

async function captureImage(
  page:          Page,
  outDir:        string,
  containerBBox: BBox | null,
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  try {
    await page.waitForSelector(
      'img[src*="scontent"], img[src*="fbcdn.net"], video',
      { timeout: MEDIA_WAIT },
    );
  } catch { /* proceed with whatever is loaded */ }

  const outPath = path.join(outDir, 'image-01.png');
  await screenshotRegion(page, containerBBox, outPath);
  return [outPath];
}

// ─── Carousel helpers ────────────────────────────────────────────────────────

type AdvanceResult =
  | { advanced: true;  strategy: string }
  | { advanced: false; reason: string };

/**
 * Attempt to advance a carousel to the next card.
 *
 * Strategy order:
 *   1. Hover the creative area (right-middle) to reveal Meta hover-only controls
 *   2. JS DOM click — find any [aria-label*="next"] element and call .click()
 *      (most reliable on React SPAs; bypasses Playwright visibility edge-cases)
 *   3. Position-restricted Playwright click — only elements within 120 px of
 *      the creative's right edge and vertically aligned with the creative
 *   4. Keyboard ArrowRight (focused on creative)
 *   5. Coordinate click — 90% across, 50% down the creative bounding box
 */
async function tryAdvanceCarousel(
  page:         Page,
  creativeBBox: BBox | null,
  cardNum:      number,
  outDir:       string,
): Promise<AdvanceResult> {

  // ── Step 1: hover right-middle of creative to reveal carousel controls ────
  if (creativeBBox) {
    try {
      const hx = creativeBBox.x + creativeBBox.width * 0.85;
      const hy = creativeBBox.y + creativeBBox.height * 0.50;
      await page.mouse.move(hx, hy);
      await page.waitForTimeout(800); // wait for hover controls to appear
    } catch { /* ignore */ }
  }

  // ── Optional debug screenshot: before advance ─────────────────────────────
  if (DEBUG_CAPTURE_GLOBAL) {
    try {
      const dbgPath = path.join(outDir, `debug-before-next-${String(cardNum).padStart(2, '0')}.png`);
      await page.screenshot({ path: dbgPath });
    } catch { /* ignore */ }
  }

  // ── Step 2: JS DOM click on any aria-label containing "next" ─────────────
  // This runs inside the page context — no Playwright selector matching needed
  const jsResult = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label]'),
    );
    for (const el of candidates) {
      const label = (el.getAttribute('aria-label') ?? '').toLowerCase();
      if (!label.includes('next')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      // Skip large elements (not carousel arrow buttons)
      if (rect.width > 100 || rect.height > 100) continue;
      el.click();
      return {
        found: true,
        label: el.getAttribute('aria-label') ?? '',
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      };
    }
    return { found: false, label: '', x: 0, y: 0, w: 0, h: 0 };
  }) as { found: boolean; label: string; x: number; y: number; w: number; h: number };

  if (jsResult.found) {
    await page.waitForTimeout(900);
    console.log(
      `       → JS click: aria-label="${jsResult.label}" ` +
      `at (${jsResult.x},${jsResult.y}) ${jsResult.w}×${jsResult.h}`,
    );

    // ── Optional debug screenshot: after advance ───────────────────────────
    if (DEBUG_CAPTURE_GLOBAL) {
      try {
        const dbgPath = path.join(outDir, `debug-after-next-${String(cardNum).padStart(2, '0')}.png`);
        await page.screenshot({ path: dbgPath });
      } catch { /* ignore */ }
    }

    return { advanced: true, strategy: `js:aria-label="${jsResult.label}"` };
  }

  // ── Step 3: position-restricted Playwright selector ───────────────────────
  // Only consider elements within 120 px right of the creative and vertically aligned
  if (creativeBBox) {
    const rightBound  = creativeBBox.x + creativeBBox.width + 120;
    const leftBound   = creativeBBox.x + creativeBBox.width * 0.5; // right half only
    const topBound    = creativeBBox.y - 40;
    const bottomBound = creativeBBox.y + creativeBBox.height + 40;

    const restrictedSelectors = [
      'button[aria-label*="Next" i]',
      'div[aria-label*="Next" i]',
      '[role="button"][aria-label*="Next" i]',
    ];

    for (const sel of restrictedSelectors) {
      try {
        const els = await page.$$(sel);
        for (const el of els) {
          if (!(await el.isVisible())) continue;
          const box = await el.boundingBox();
          if (!box) continue;
          const cx = box.x + box.width  / 2;
          const cy = box.y + box.height / 2;
          if (cx < leftBound || cx > rightBound) continue;
          if (cy < topBound  || cy > bottomBound) continue;
          if (box.width > 100 || box.height > 100) continue;

          console.log(
            `       → Playwright "${sel}" ` +
            `at (${Math.round(box.x)},${Math.round(box.y)}) ` +
            `${Math.round(box.width)}×${Math.round(box.height)}`,
          );
          await el.click({ force: true });
          await page.waitForTimeout(900);
          return { advanced: true, strategy: `playwright:${sel}` };
        }
      } catch { /* ignore */ }
    }
  }

  // ── Step 4: keyboard ArrowRight ───────────────────────────────────────────
  try {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(800);
    console.log('       → keyboard:ArrowRight');
    return { advanced: true, strategy: 'keyboard:ArrowRight' };
  } catch { /* ignore */ }

  // ── Step 5: coordinate click — 90% right, 50% down the creative bbox ──────
  if (creativeBBox) {
    const clickX = creativeBBox.x + creativeBBox.width  * 0.90;
    const clickY = creativeBBox.y + creativeBBox.height * 0.50;
    console.log(`       → coordinate click at (${Math.round(clickX)},${Math.round(clickY)})`);
    try {
      await page.mouse.click(clickX, clickY);
      await page.waitForTimeout(800);
      return { advanced: true, strategy: 'coordinate:right-middle' };
    } catch { /* ignore */ }
  }

  return { advanced: false, reason: 'no next control found via any strategy' };
}

async function captureCarousel(
  page:          Page,
  outDir:        string,
  containerBBox: BBox | null,
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const saved:    string[]    = [];
  const seenSigs: Set<string> = new Set();
  let noChanges = 0;

  try {
    await page.waitForSelector(
      'img[src*="scontent"], img[src*="fbcdn.net"]',
      { timeout: MEDIA_WAIT },
    );
  } catch { /* proceed with whatever loaded */ }

  // If no container from ad-id detection, try to find media within any container
  const initBox: BBox | null = containerBBox ?? (() => {
    // Can't do async here — fall back to generic clip below
    return null;
  })();

  console.log(
    `       creative container: ${
      initBox
        ? `${Math.round(initBox.width)}×${Math.round(initBox.height)} ` +
          `at (${Math.round(initBox.x)},${Math.round(initBox.y)})`
        : 'not found — will use viewport clip'
    }`,
  );

  // Fixed clip region — consistent across all card screenshots
  const clip: BBox = initBox
    ? {
        x:      Math.max(0, initBox.x - 5),
        y:      Math.max(0, initBox.y - 5),
        width:  Math.min(1280 - Math.max(0, initBox.x - 5), initBox.width  + 10),
        height: Math.min(900  - Math.max(0, initBox.y - 5), initBox.height + 10),
      }
    : { x: 150, y: 80, width: 900, height: 700 };

  let nextCandidateCount = 0;

  for (let cardNum = 1; cardNum <= CAROUSEL_MAX; cardNum++) {

    // Capture the creative clip region
    let buf: Buffer;
    try {
      buf = await page.screenshot({ clip }) as Buffer;
    } catch {
      buf = await page.screenshot() as Buffer;
    }

    const sig = bufferSig(buf as Buffer);
    if (seenSigs.has(sig)) {
      console.log(`       card ${cardNum}: duplicate — stopping. Reason: screenshot region unchanged`);
      console.log(`       total cards captured: ${saved.length}`);
      break;
    }
    seenSigs.add(sig);

    const outPath = path.join(outDir, `card-${String(cardNum).padStart(2, '0')}.png`);
    fs.writeFileSync(outPath, buf);
    saved.push(outPath);
    console.log(`       card ${cardNum}: saved`);

    // Count visible next-button candidates for diagnostic logging
    try {
      nextCandidateCount = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[aria-label]'))
          .filter((el) => {
            const label = (el.getAttribute('aria-label') ?? '').toLowerCase();
            if (!label.includes('next')) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.width <= 100 && r.height <= 100;
          }).length,
      );
      console.log(`       next candidates visible: ${nextCandidateCount}`);
    } catch { /* ignore */ }

    // Attempt to advance
    const result = await tryAdvanceCarousel(page, initBox, cardNum, outDir);

    if (!result.advanced) {
      console.log(`       stop reason: ${result.reason}`);
      noChanges++;
    } else {
      // Verify the clip region actually changed
      let freshBuf: Buffer;
      try { freshBuf = await page.screenshot({ clip }) as Buffer; }
      catch { freshBuf = await page.screenshot() as Buffer; }

      if (bufferSig(freshBuf as Buffer) !== sig) {
        console.log(`       strategy worked: ${result.strategy}`);
        noChanges = 0;
      } else {
        console.log(`       strategy "${result.strategy}" — clip unchanged`);
        noChanges++;
      }
    }

    if (noChanges >= 2) {
      console.log(`       carousel stopped: no card change after ${noChanges} attempts`);
      break;
    }
  }

  console.log(`       total cards captured: ${saved.length}`);
  return saved;
}

async function captureVideo(
  page:          Page,
  outDir:        string,
  containerBBox: BBox | null,
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const saved: string[] = [];

  try {
    await page.waitForSelector(
      'video, img[src*="scontent"], img[src*="fbcdn.net"]',
      { timeout: MEDIA_WAIT },
    );
  } catch { /* proceed */ }

  // Try to click Play within the container to start the video
  if (containerBBox) {
    try {
      const el = await findCreativeElement(page, containerBBox);
      if (el) await el.click();
      await page.waitForTimeout(800);
    } catch { /* ignore */ }
  }

  // Frame 1
  const frame1 = path.join(outDir, 'frame-01.png');
  await screenshotRegion(page, containerBBox, frame1);
  saved.push(frame1);

  // Frame 2 — 2 s later; only save if visually different from frame 1
  await page.waitForTimeout(2_000);
  const frame2Path = path.join(outDir, 'frame-02.png');
  await screenshotRegion(page, containerBBox, frame2Path);

  const f1 = fs.readFileSync(frame1);
  const f2 = fs.readFileSync(frame2Path);
  if (bufferSig(f2) !== bufferSig(f1)) {
    saved.push(frame2Path);
  } else {
    fs.unlinkSync(frame2Path);
    console.log('       frame-02: identical to frame-01 — not saved');
  }

  return saved;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

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

      // ── Locate correct ad container ──────────────────────────────────────
      const containerDebug: string[] = [];
      const containerBBox = await findAdContainer(page, adId, {
        competitorName: name,
        headline:       row.headline,
        adCopy:         row.ad_copy,
        description:    row.description,
      }, containerDebug);
      const rejected: string[] = [];

      if (containerBBox) {
        console.log(
          `    container: ${Math.round(containerBBox.width)}×${Math.round(containerBBox.height)} ` +
          `at (${Math.round(containerBBox.x)},${Math.round(containerBBox.y)})`,
        );
      } else {
        console.log('    ⚠  container not found by ad_id — using page heuristic');
        rejected.push('ad_id not found in DOM');
      }

      await saveDebugInfo(
        page, adId, containerBBox, outDir,
        containerBBox ? 'found' : 'not-found', rejected, containerDebug,
      );
      if (!containerBBox) {
        console.log('    SKIPPED — could not identify correct creative container');
        noContainer++;
        await page.close();
        continue;
      }

      // ── Dispatch ────────────────────────────────────────────────────────────────────
      let savedFiles: string[] = [];

      if (mt === 'CAROUSEL') {
        console.log('    capturing carousel…');
        savedFiles = await captureCarousel(page, outDir, containerBBox);
      } else if (mt === 'IMAGE') {
        console.log('    capturing image…');
        savedFiles = await captureImage(page, outDir, containerBBox);
      } else {
        console.log(`    capturing video frames (type: ${mt || 'unknown'})…`);
        savedFiles = await captureVideo(page, outDir, containerBBox);
      }

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
