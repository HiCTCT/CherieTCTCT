/**
 * Creative Asset Analyser
 *
 * Calls the Claude vision API to generate visual_description and creative_notes
 * from actual creative asset files saved to disk.
 *
 * This is a pre-processing step that runs BEFORE analyseAdRow().
 * The generated text feeds into the existing scoring pipeline unchanged.
 * analyseAdRow(), staticAnalyser.ts, and videoAnalyser.ts are not touched.
 *
 * Supported asset layouts:
 *   IMAGE    — creative_asset_path points to a single image file
 *   CAROUSEL — creative_asset_path points to a folder of sorted image files
 *   VIDEO    — Phase 1: creative_asset_path points to a single representative
 *              frame image (or a folder; first frame is used). Full video
 *              analysis (transcript, audio) is out of scope for this pass.
 *
 * Requires: ANTHROPIC_API_KEY environment variable when creative_asset_path
 * is present in any READY row. Scripts enforce this before calling here.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Public types ─────────────────────────────────────────────────────────────

export type CreativeSource = 'ASSET' | 'MANUAL' | 'FALLBACK';

export type CreativeContext = {
  visual_description: string;
  creative_notes: string;
  source: CreativeSource;
};

// ─── Internal types ───────────────────────────────────────────────────────────

type RowCreativeFields = {
  creative_asset_path?: string;
  visual_description?: string;
  creative_notes?: string;
};

type SupportedMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

type ImageBlock = {
  type: 'image';
  source: {
    type: 'base64';
    media_type: SupportedMimeType;
    data: string;
  };
};

type TextBlock = {
  type: 'text';
  text: string;
};

type ContentBlock = ImageBlock | TextBlock;

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';
const MAX_TOKENS = 1024;
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
// Anthropic rejects images whose longest side exceeds 8000px. Tall carousel-card
// screenshots (deviceScaleFactor 2) can exceed this, so we downscale any creative
// whose longest side is over this safe limit BEFORE sending it to Vision.
const MAX_VISION_SIDE = 4096;

const IMAGE_PROMPT = `You are analysing a Meta Ad Library advertising creative for a competitor advertiser. The advertiser may be in any industry and may sell a product or a service. Describe only what is actually shown in this creative; do not assume an industry or category and do not compare it to any other brand or product type. Your output will be used to score the ad's marketing effectiveness.

Provide exactly two sections:

VISUAL_DESCRIPTION:
2-4 sentences covering: product or service shown, setting or background, human presence (yes/no), text overlays visible (yes/no and what they say if clear), price or discount visible (yes/no), CTA button or text visible (yes/no and wording if clear), brand or logo visible (yes/no), visual hierarchy (strong/moderate/weak), composition quality (polished/clean/cluttered), scroll-stopping strength (high/medium/low).

CREATIVE_NOTES:
First line only: "Attention X/10. Interest X/10. Desire X/10. Action X/10." (score each dimension 1-10 based solely on what you can observe).
Then 2-3 sentences covering: the funnel stage this creative appears to target (TOFU/MOFU/BOFU), the ad's primary message or offer, the main emotional hook or trigger, any trust signals present, and one key strength and one key weakness of this creative.

Respond with only the two labelled sections. No preamble or commentary.`;

function buildCarouselPrompt(cardCount: number): string {
  return `You are analysing a ${cardCount}-card Meta Ad Library carousel ad for a competitor advertiser. The advertiser may be in any industry and may sell a product or a service. Describe only what is actually shown across these cards; do not assume an industry or category and do not compare it to any other brand or product type. Your output will be used to score the ad's marketing effectiveness.

Provide exactly two sections:

VISUAL_DESCRIPTION:
Describe the carousel as a unit: products or services shown across all cards, setting or tone, human presence (yes/no), text overlays present (yes/no), price or offer visible on any card (yes/no), CTA on any card (yes/no and wording if clear), brand or logo visible (yes/no), first-card visual strength (strong/moderate/weak), visual consistency across cards, whether later cards introduce new products, services, or information.

CREATIVE_NOTES:
First line only: "Attention X/10. Interest X/10. Desire X/10. Action X/10." (score the carousel as a unit, 1-10 each).
Then 2-3 sentences covering: the funnel stage this carousel appears to target (TOFU/MOFU/BOFU), first-card hook strength, whether the sequence tells a coherent story or shows product variety, whether the final card drives action, and one key strength and one key weakness of this carousel.

Respond with only the two labelled sections. No preamble or commentary.`;
}

// ─── Image helpers ────────────────────────────────────────────────────────────

function detectMimeType(filePath: string): SupportedMimeType {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png')  return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/** Read PNG pixel dimensions from the IHDR header (no image library required). */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Downscale an oversized creative IN MEMORY for Vision only — the originals on disk
 * are never modified. Reuses the already-installed Playwright/Chromium via a lazy
 * import (no new dependency), so this only runs for images that are actually too
 * large. Returns a base64 PNG of the resized image, or null if no resize was needed
 * or possible (caller then uses the original).
 */
async function resizeImageForVision(filePath: string, buf: Buffer, mime: string): Promise<string | null> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    const result = await page.evaluate(async (args) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = () => resolve(null);
        img.onerror = () => reject(new Error('image failed to load'));
        img.src = args.src;
      });
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const scale = Math.min(1, args.maxSide / Math.max(w, h));
      if (scale >= 1) return { resized: false, w, h, cw: w, ch: h, data: '' };
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      if (!ctx) return { resized: false, w, h, cw: w, ch: h, data: '' };
      ctx.drawImage(img, 0, 0, cw, ch);
      return { resized: true, w, h, cw, ch, data: canvas.toDataURL('image/png').split(',')[1] || '' };
    }, { src: dataUrl, maxSide: MAX_VISION_SIDE });

    if (!result.resized || !result.data) return null;
    console.log(`  ↺ resized creative for Vision: ${path.basename(filePath)} ${result.w}x${result.h} → ${result.cw}x${result.ch}`);
    return result.data;
  } finally {
    await browser.close();
  }
}

/** Build a Claude image content block, downscaling oversized creatives for Vision only. */
async function buildImageBlock(filePath: string): Promise<ImageBlock> {
  const buf = fs.readFileSync(filePath);
  const mime = detectMimeType(filePath);
  const size = pngSize(buf);
  const oversized = !size || size.width > MAX_VISION_SIDE || size.height > MAX_VISION_SIDE;

  if (oversized) {
    const resized = await resizeImageForVision(filePath, buf, mime);
    if (resized) {
      return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: resized } };
    }
    // Could not / did not resize once measured — fall through to the original bytes.
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: mime, data: buf.toString('base64') },
  };
}

function collectImageFiles(folderPath: string): string[] {
  return fs
    .readdirSync(folderPath)
    .filter((f) => SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(folderPath, f));
}

// ─── Response parsing ─────────────────────────────────────────────────────────

function parseResponse(text: string): { visual_description: string; creative_notes: string } {
  const visMatch   = text.match(/VISUAL_DESCRIPTION:\s*([\s\S]*?)(?=CREATIVE_NOTES:|$)/i);
  const notesMatch = text.match(/CREATIVE_NOTES:\s*([\s\S]*?)$/i);

  const visual_description = visMatch  ? visMatch[1].trim()   : text.trim();
  const creative_notes     = notesMatch ? notesMatch[1].trim() : '';

  return { visual_description, creative_notes };
}

// ─── Main analysis function ───────────────────────────────────────────────────

/**
 * Calls the Claude vision API with the asset(s) at assetPath.
 * Returns { visual_description, creative_notes } generated from the creative.
 *
 * IMAGE:    single image file
 * CAROUSEL: folder — all image files sorted alphabetically
 * VIDEO:    Phase 1 — single frame file, or first frame in a folder
 */
export async function analyseCreativeAsset(
  assetPath: string,
  mediaType: string,
): Promise<{ visual_description: string; creative_notes: string }> {
  const mt   = mediaType.trim().toUpperCase();
  const stat = fs.statSync(assetPath);

  let content: ContentBlock[];

  if (mt === 'CAROUSEL' && stat.isDirectory()) {
    const frames = collectImageFiles(assetPath);
    if (frames.length === 0) {
      throw new Error(`No image files found in carousel folder: ${assetPath}`);
    }
    const imageBlocks: ImageBlock[] = [];
    for (const f of frames) imageBlocks.push(await buildImageBlock(f)); // sequential: avoids concurrent browser launches
    content = [...imageBlocks, { type: 'text', text: buildCarouselPrompt(frames.length) }];
  } else if (stat.isDirectory()) {
    // VIDEO Phase 1 or IMAGE folder fallback — use first frame
    const frames = collectImageFiles(assetPath);
    if (frames.length === 0) {
      throw new Error(`No image files found in folder: ${assetPath}`);
    }
    content = [await buildImageBlock(frames[0]!), { type: 'text', text: IMAGE_PROMPT }];
  } else {
    // Single image file (IMAGE or VIDEO frame)
    content = [await buildImageBlock(assetPath), { type: 'text', text: IMAGE_PROMPT }];
  }

  const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type':    'application/json',
      'x-api-key':       process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!apiResponse.ok) {
    const errorText = await apiResponse.text();
    throw new Error(`Anthropic API error ${apiResponse.status}: ${errorText}`);
  }

  const data = await apiResponse.json() as {
    content: Array<{ type: string; text?: string }>;
  };

  const textBlock   = data.content.find((b) => b.type === 'text');
  const responseText = textBlock?.text ?? '';

  return parseResponse(responseText);
}

// ─── Context resolver (called by scripts) ────────────────────────────────────

/**
 * Resolves creative context for one CSV row using three-way priority:
 *   ASSET    — creative_asset_path present and file/folder found on disk
 *   MANUAL   — creative_asset_path absent/missing, but visual_description or creative_notes present in CSV
 *   FALLBACK — neither asset nor manual text available
 *
 * If creative_asset_path is set but the file is missing, logs a warning
 * and falls through to MANUAL. If the API call fails for any other reason
 * (network, rate limit), the error is re-thrown — callers must abort.
 *
 * Note: scripts enforce ANTHROPIC_API_KEY presence BEFORE calling this
 * function when any READY row has creative_asset_path set.
 */
export async function resolveCreativeContext(
  row: RowCreativeFields,
  mediaType: string,
): Promise<CreativeContext> {
  const assetPath = row.creative_asset_path?.trim();

  if (assetPath) {
    const resolvedPath = path.resolve(assetPath);

    if (!fs.existsSync(resolvedPath)) {
      console.warn(`  ⚠  creative_asset_path not found: ${resolvedPath}`);
      console.warn('     Falling back to manual CSV text.');
    } else {
      // If analysis fails, re-throw — callers must abort, not fall back to manual text.
      const result = await analyseCreativeAsset(resolvedPath, mediaType);
      return { ...result, source: 'ASSET' };
    }
 
  }

  const visual = row.visual_description?.trim() || '';
  const notes  = row.creative_notes?.trim()      || '';

  if (visual || notes) {
    return { visual_description: visual, creative_notes: notes, source: 'MANUAL' };
  }

  return { visual_description: '', creative_notes: '', source: 'FALLBACK' };
}
