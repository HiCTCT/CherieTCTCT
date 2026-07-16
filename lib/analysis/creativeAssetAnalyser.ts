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

import { isCreativeAssetFile, creativeIndexOf } from './creativeAssetFiles';

// ─── Public types ─────────────────────────────────────────────────────────────

export type CreativeSource = 'ASSET' | 'MANUAL' | 'FALLBACK';

/** Model's self-reported confidence in its VISUAL interpretation (VIDEO only). */
export type VisualConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type CreativeContext = {
  visual_description: string;
  creative_notes: string;
  source: CreativeSource;
  // VIDEO only. Absent/unparseable → LOW (fail closed). Undefined for IMAGE /
  // CAROUSEL / MANUAL / FALLBACK, which are not asked for a confidence.
  visual_confidence?: VisualConfidence;
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
// The creative-file allowlist now lives in a PURE module (lib/analysis/creativeAssetFiles.ts)
// so the bundle validator / planner can share the identical rule WITHOUT importing this
// Anthropic-calling analyser. Re-exported here so existing importers keep working.
export { isCreativeAssetFile, CREATIVE_ASSET_FILE_RE } from './creativeAssetFiles';

// ── Video frame budget (Phase 1C) ────────────────────────────────────────────
// AI_VIDEO_MAX_FRAMES: how many sequential frames ONE video ad may send inside its
// single Vision request. Absent → 4. An explicitly supplied value is validated in
// full: a whole integer >= 1 only. 0, negatives, decimals, blanks, junk and unsafe
// magnitudes all FAIL CLOSED — never a silent fallback to the default.
export const AI_VIDEO_MAX_FRAMES_DEFAULT = 4;
export type VideoFramesConfig = { ok: true; value: number } | { ok: false; reason: string };
export function resolveVideoMaxFrames(): VideoFramesConfig {
  const raw = process.env.AI_VIDEO_MAX_FRAMES;
  if (raw === undefined) return { ok: true, value: AI_VIDEO_MAX_FRAMES_DEFAULT };
  if (!/^\d+$/.test(raw)) {
    return { ok: false, reason: `AI_VIDEO_MAX_FRAMES must be a whole integer >= 1 (got "${raw}")` };
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    return { ok: false, reason: `AI_VIDEO_MAX_FRAMES is not a safe integer (got "${raw}")` };
  }
  if (n < 1) {
    return { ok: false, reason: `AI_VIDEO_MAX_FRAMES must be at least 1 for a paid video analysis (got "${raw}")` };
  }
  return { ok: true, value: n };
}
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

/** Label emitted as a text block immediately BEFORE each video frame image. */
export function videoFrameLabel(index: number, total: number): string {
  return `FRAME ${index} OF ${total}`;
}

/** The labelled sections a VIDEO response must contain, in order. */
export const VIDEO_PROMPT_SECTIONS = [
  'FRAME_OBSERVATIONS',
  'VISUAL_DESCRIPTION',
  'VISUAL_CONFIDENCE',
  'CREATIVE_NOTES',
] as const;

function buildVideoPrompt(frameCount: number): string {
  return `You have been shown ${frameCount} still frames sampled IN ORDER from ONE Meta Ad Library VIDEO ad for a competitor advertiser. Each image was preceded by a label "FRAME n OF ${frameCount}".

The advertiser may be in any industry and may sell a product or a service. Analyse ONLY what is visible in the frames.

MANDATORY METHOD — follow in this order:
1. Examine EVERY frame separately, in order, BEFORE deciding what the ad is about.
2. Do NOT classify the video from FRAME 1 alone. FRAME 1 is frequently an intro, a close-up, a texture or fabric shot, a logo card, an empty room, or a transitional shot, and is often NOT the subject of the ad. Later frames commonly carry the decisive product context.
3. Decide the overall subject only after weighing all ${frameCount} frames together. If a later frame reveals the product, that product is the subject — not whatever FRAME 1 happened to show.

Rules:
- Do not infer audio, voiceover, music, narration, or motion you cannot see.
- Do not invent a product category. If the frames are ambiguous, say they are ambiguous.
- If the frames do not support ONE coherent interpretation, report the uncertainty instead of guessing.
- Describe only what is actually visible. Never compare to another brand or assume an industry.

Respond with exactly these four labelled sections and nothing else:

FRAME_OBSERVATIONS:
One line per frame, in order, formatted exactly "FRAME n: <what is visible in that frame>". For each frame state the main object or subject, any people, any on-screen text, and whether the frame looks like an intro / close-up / transitional shot rather than a product shot.

VISUAL_DESCRIPTION:
2-4 sentences describing the video as a unit AFTER considering every frame: the recurring product or subject across the sequence, what changes from frame to frame, whether FRAME 1 is an intro/close-up/transitional shot, the setting, human presence (yes/no), text overlays (yes/no and wording if clear), price or discount visible (yes/no), CTA visible (yes/no and wording if clear), brand or logo visible (yes/no), and the best-supported overall purpose of the video.

VISUAL_CONFIDENCE:
Exactly one word first — HIGH, MEDIUM or LOW — then " - " and a short reason, on one line.
Use LOW when: the frames conflict; the main object cannot be identified; your description rests mainly on an ambiguous close-up; or the visual evidence does not align into one coherent subject.
Use MEDIUM when the subject is probable but partly inferred.
Use HIGH only when the recurring subject is unambiguous across multiple frames.

CREATIVE_NOTES:
First line only: "Attention X/10. Interest X/10. Desire X/10. Action X/10." (score the video as a unit, 1-10 each, based solely on what is observable).
Then 2-3 sentences covering: the funnel stage this video appears to target (TOFU/MOFU/BOFU), the opening hook strength, the ad's primary message or offer, any trust signals visible, and one key strength and one key weakness.

No preamble or commentary.`;
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
    .filter((f) => isCreativeAssetFile(f))   // creative files only — no debug/support output
    .map((f) => path.join(folderPath, f))
    .sort((a, b) => creativeIndexOf(a) - creativeIndexOf(b) || a.localeCompare(b));
}

// ── Shared Vision input planner (Phase 1C) ───────────────────────────────────
// Single source of truth for WHICH files a paid request would send, used by both
// analyseCreativeAsset() and the no-spend preflight, so the preflight's reported
// counts are exactly the payload a paid run would build.
export type VisionPlanKind = 'CAROUSEL' | 'VIDEO' | 'IMAGE' | 'SINGLE_FILE' | 'NONE';
export type VisionPlan = {
  kind: VisionPlanKind;
  eligible: string[];   // every eligible creative file found at the path
  planned: string[];    // exactly the files sent in this ad's ONE request
};

export function planVisionInputs(
  assetPath: string,
  mediaType: string,
  maxVideoFrames: number,
): VisionPlan {
  const none: VisionPlan = { kind: 'NONE', eligible: [], planned: [] };
  let st: fs.Stats;
  try { st = fs.statSync(assetPath); } catch { return none; }
  const mt = mediaType.trim().toUpperCase();

  // Direct single-file path must pass the same allowlist as folder contents.
  if (!st.isDirectory()) {
    if (!isCreativeAssetFile(assetPath)) return none;
    return { kind: 'SINGLE_FILE', eligible: [assetPath], planned: [assetPath] };
  }

  let eligible: string[];
  try { eligible = collectImageFiles(assetPath); } catch { return none; }
  if (eligible.length === 0) return none;

  if (mt === 'CAROUSEL') return { kind: 'CAROUSEL', eligible, planned: eligible };
  // VIDEO: send up to AI_VIDEO_MAX_FRAMES sequential frames in the SAME request.
  if (mt === 'VIDEO') return { kind: 'VIDEO', eligible, planned: eligible.slice(0, Math.max(1, maxVideoFrames)) };
  // IMAGE folder: its eligible image file.
  return { kind: 'IMAGE', eligible, planned: [eligible[0]!] };
}

// ─── Response parsing ─────────────────────────────────────────────────────────

export type ParsedCreativeResponse = {
  visual_description: string;
  creative_notes: string;
  visual_confidence?: VisualConfidence;
};

// Neutral, reviewable fallbacks for a malformed VIDEO response. The raw model output
// is deliberately NOT surfaced here — a malformed response must not leak section
// labels or unstructured text into scored fields.
const MALFORMED_VIDEO_DESCRIPTION =
  'Structured video response was malformed (missing, duplicated or out-of-order sections). Manual review required; no visual interpretation accepted.';
const MALFORMED_VIDEO_NOTES =
  'Structured creative notes were unavailable for this video response. Manual review required.';

/**
 * Locates the four required VIDEO sections and validates the WHOLE structure.
 * Returns null (→ caller fails closed to LOW) when any required header is missing,
 * appears more than once, or appears out of the required order. Content ranges are
 * sliced strictly between one header's end and the next header's start, so a section
 * can never absorb another section's header or text.
 */
function locateVideoSections(text: string): Record<string, { start: number; end: number }> | null {
  const found: Array<{ name: string; index: number; end: number }> = [];

  for (const name of VIDEO_PROMPT_SECTIONS) {
    const re = new RegExp(`^[ \\t]*${name}[ \\t]*:`, 'gim');
    let count = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      count++;
      if (count > 1) return null;                       // duplicate header → invalid
      found.push({ name, index: m.index, end: m.index + m[0].length });
    }
    if (count !== 1) return null;                       // missing header → invalid
  }

  found.sort((a, b) => a.index - b.index);
  for (let i = 0; i < VIDEO_PROMPT_SECTIONS.length; i++) {
    if (found[i]!.name !== VIDEO_PROMPT_SECTIONS[i]) return null;   // out of order → invalid
  }

  const out: Record<string, { start: number; end: number }> = {};
  for (let i = 0; i < found.length; i++) {
    out[found[i]!.name] = {
      start: found[i]!.end,
      end: i + 1 < found.length ? found[i + 1]!.index : text.length,
    };
  }
  return out;
}

/**
 * FRAME_OBSERVATIONS must carry exactly one ANCHORED "FRAME n: <text>" line per
 * supplied frame, numbered 1..expectedFrames in order, EACH with real observation
 * text after the colon. Line-anchored + colon-required, so "FRAME 1" inside ordinary
 * prose is never counted. Missing, duplicate, extra, empty, frame 0, above-N,
 * out-of-order observations — and an invalid expectedFrames — all fail closed.
 *
 * Group 1 = frame number, group 2 = same-line observation text (may be empty → reject).
 * Tolerates "FRAME 1 :", "FRAME 1:\ttext" and lower-case "frame 1:". "FRAME 01:"
 * resolves to 1 and cannot bypass the duplicate/order check below.
 */
function hasExactFrameObservations(body: string, expectedFrames: number): boolean {
  // Fail CLOSED on an invalid expected count — never treat it as "not enforced".
  // Number.isSafeInteger rejects non-numbers, NaN, Infinity, decimals and unsafe
  // magnitudes; the > 0 test rejects 0 and negatives.
  if (!Number.isSafeInteger(expectedFrames) || expectedFrames <= 0) return false;

  const re = /^[ \t]*FRAME[ \t]+(\d+)[ \t]*:(.*)$/gim;
  const nums: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if ((m[2] ?? '').trim() === '') return false;   // labelled but no observation text
    nums.push(Number(m[1]));
  }
  if (nums.length !== expectedFrames) return false;
  for (let i = 0; i < expectedFrames; i++) if (nums[i] !== i + 1) return false;
  return true;
}

/** VIDEO: structure AND bodies must fully validate before HIGH or MEDIUM is accepted. */
function parseVideoResponse(text: string, expectedFrames: number): ParsedCreativeResponse {
  const malformed = (): ParsedCreativeResponse => ({
    visual_description: MALFORMED_VIDEO_DESCRIPTION,
    creative_notes: MALFORMED_VIDEO_NOTES,
    visual_confidence: 'LOW',
  });

  const sec = locateVideoSections(text);
  if (!sec) return malformed();                       // missing / duplicate / out-of-order headers

  const body = (name: string) => text.slice(sec[name]!.start, sec[name]!.end).trim();
  const frames      = body('FRAME_OBSERVATIONS');
  const description = body('VISUAL_DESCRIPTION');
  const notes       = body('CREATIVE_NOTES');

  // Headers alone are not a response: required bodies must carry real content.
  if (!frames || !description || !notes) return malformed();

  // Every supplied frame must have been observed exactly once, in order.
  if (!hasExactFrameObservations(frames, expectedFrames)) return malformed();

  // Confidence is read ONLY from between its own header and CREATIVE_NOTES, and only
  // as an exact leading token — never borrowed from another section. An unreadable
  // token with otherwise valid sections is a STRUCTURED LOW (real content retained),
  // which stays distinguishable from the neutral malformed fallback above.
  const m = /^(HIGH|MEDIUM|LOW)\b/i.exec(body('VISUAL_CONFIDENCE'));
  return {
    visual_description: description,
    creative_notes:     notes,
    visual_confidence:  m ? (m[1]!.toUpperCase() as VisualConfidence) : 'LOW',
  };
}

/** IMAGE / CAROUSEL / single file — unchanged two-section behaviour, never a confidence. */
function parseSimpleResponse(text: string): ParsedCreativeResponse {
  const visMatch   = text.match(/VISUAL_DESCRIPTION:\s*([\s\S]*?)(?=VISUAL_CONFIDENCE:|CREATIVE_NOTES:|$)/i);
  const notesMatch = text.match(/CREATIVE_NOTES:\s*([\s\S]*?)$/i);
  return {
    visual_description: visMatch  ? visMatch[1]!.trim()   : text.trim(),
    creative_notes:     notesMatch ? notesMatch[1]!.trim() : '',
    // These prompts never ask for a confidence, so an unexpected VISUAL_CONFIDENCE
    // label in the output must NOT populate the field. It stays undefined.
    visual_confidence: undefined,
  };
}

/**
 * `expectedFrames` is the number of frames actually supplied in the request (VIDEO
 * only; pass 0 for IMAGE/CAROUSEL). It is required — not defaulted — so a caller can
 * never silently skip frame-observation validation.
 */
export function parseResponse(
  text: string,
  expectConfidence: boolean,
  expectedFrames: number,
): ParsedCreativeResponse {
  return expectConfidence ? parseVideoResponse(text, expectedFrames) : parseSimpleResponse(text);
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
): Promise<{ visual_description: string; creative_notes: string; visual_confidence?: VisualConfidence }> {
  // Frame budget is validated BEFORE any request is built — fail closed on a
  // malformed AI_VIDEO_MAX_FRAMES rather than silently defaulting.
  const framesCfg = resolveVideoMaxFrames();
  if (!framesCfg.ok) throw new Error(framesCfg.reason);

  // Plan the payload with the SAME shared planner the no-spend preflight reports on.
  const plan = planVisionInputs(assetPath, mediaType, framesCfg.value);
  if (plan.planned.length === 0) {
    throw new Error(
      `No eligible creative asset file for Vision at: ${assetPath} ` +
      '(expected image-NN / card-NN / frame-NN .png/.jpg/.jpeg/.webp)',
    );
  }

  // ONE logical Vision request per ad, however many images it carries:
  //   CAROUSEL → every eligible card;  VIDEO → up to AI_VIDEO_MAX_FRAMES frames;
  //   IMAGE / single file → its one eligible image.
  let content: ContentBlock[];

  if (plan.kind === 'VIDEO') {
    // Each frame is explicitly labelled ("FRAME n OF N") in a text block placed
    // immediately BEFORE its image, so the model can reason per frame and cannot
    // silently treat frame 1 as the whole ad. Still ONE request.
    const total = plan.planned.length;
    const blocks: ContentBlock[] = [];
    for (let i = 0; i < total; i++) {
      blocks.push({ type: 'text', text: videoFrameLabel(i + 1, total) });
      blocks.push(await buildImageBlock(plan.planned[i]!)); // sequential: avoids concurrent browser launches
    }
    content = [...blocks, { type: 'text', text: buildVideoPrompt(total) }];
  } else {
    // IMAGE / CAROUSEL / single file — unchanged ordering: images, then one prompt.
    const imageBlocks: ImageBlock[] = [];
    for (const f of plan.planned) imageBlocks.push(await buildImageBlock(f)); // sequential: avoids concurrent browser launches
    const prompt = plan.kind === 'CAROUSEL' ? buildCarouselPrompt(plan.planned.length) : IMAGE_PROMPT;
    content = [...imageBlocks, { type: 'text', text: prompt }];
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

  const isVideo = plan.kind === 'VIDEO';
  return parseResponse(responseText, isVideo, isVideo ? plan.planned.length : 0);
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
