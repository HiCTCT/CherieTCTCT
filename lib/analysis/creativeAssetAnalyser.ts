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

const IMAGE_PROMPT = `You are analysing a Meta Ad Library advertising creative for a Singapore home furniture or lifestyle brand. Your output will be used to score the ad's marketing effectiveness.

Provide exactly two sections:

VISUAL_DESCRIPTION:
2-4 sentences covering: product shown, setting or background, human presence (yes/no), text overlays visible (yes/no and what they say if clear), price or discount visible (yes/no), CTA button or text visible (yes/no and wording if clear), brand or logo visible (yes/no), visual hierarchy (strong/moderate/weak), composition quality (polished/clean/cluttered), scroll-stopping strength (high/medium/low).

CREATIVE_NOTES:
First line only: "Attention X/10. Interest X/10. Desire X/10. Action X/10." (score each dimension 1-10 based solely on what you can observe).
Then 2-3 sentences covering: funnel stage (TOFU/MOFU/BOFU), the ad's primary message or offer, the main emotional hook or trigger, any trust signals present, and one key strength and one key weakness of this creative.

Respond with only the two labelled sections. No preamble or commentary.`;

function buildCarouselPrompt(cardCount: number): string {
  return `You are analysing a ${cardCount}-card Meta Ad Library carousel ad for a Singapore home furniture or lifestyle brand. Your output will be used to score the ad's marketing effectiveness.

Provide exactly two sections:

VISUAL_DESCRIPTION:
Describe the carousel as a unit: products shown across all cards, setting or tone, human presence (yes/no), text overlays present (yes/no), price or offer visible on any card (yes/no), CTA on any card (yes/no and wording if clear), brand or logo visible (yes/no), first-card visual strength (strong/moderate/weak), visual consistency across cards, whether later cards introduce new products or information.

CREATIVE_NOTES:
First line only: "Attention X/10. Interest X/10. Desire X/10. Action X/10." (score the carousel as a unit, 1-10 each).
Then 2-3 sentences covering: funnel stage (TOFU/MOFU/BOFU), first-card hook strength, whether the sequence tells a coherent story or shows product variety, whether the final card drives action, and one key strength and one key weakness of this carousel.

Respond with only the two labelled sections. No preamble or commentary.`;
}

// ─── Image helpers ────────────────────────────────────────────────────────────

function detectMimeType(filePath: string): SupportedMimeType {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png')  return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function buildImageBlock(filePath: string): ImageBlock {
  const data = fs.readFileSync(filePath).toString('base64');
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: detectMimeType(filePath),
      data,
    },
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
    const imageBlocks: ImageBlock[] = frames.map(buildImageBlock);
    content = [...imageBlocks, { type: 'text', text: buildCarouselPrompt(frames.length) }];
  } else if (stat.isDirectory()) {
    // VIDEO Phase 1 or IMAGE folder fallback — use first frame
    const frames = collectImageFiles(assetPath);
    if (frames.length === 0) {
      throw new Error(`No image files found in folder: ${assetPath}`);
    }
    content = [buildImageBlock(frames[0]!), { type: 'text', text: IMAGE_PROMPT }];
  } else {
    // Single image file (IMAGE or VIDEO frame)
    content = [buildImageBlock(assetPath), { type: 'text', text: IMAGE_PROMPT }];
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
