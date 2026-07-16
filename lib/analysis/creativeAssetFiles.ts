/**
 * Creative asset file allowlist — PURE.
 *
 * Extracted so the bundle validator / planner can share the exact same allowlist
 * WITHOUT transitively importing the Anthropic analyser. This module imports
 * nothing but `path`: no network, no Playwright, no Prisma, no Anthropic.
 *
 * The rule itself is unchanged from the analyser's original definition.
 */

import * as path from 'path';

// Only the capture script's INTENDED creative outputs are eligible for Vision:
//   IMAGE → image-NN.ext,  CAROUSEL → card-NN.ext,  VIDEO → frame-NN.ext.
// Everything else in an asset folder — debug/audit/diagnostic/full-page/modal/
// selected-creative/screenshot/raw/temp/support output (e.g. debug-*.png,
// *-notes.txt, video.mp4) — is NEVER eligible.
export const CREATIVE_ASSET_FILE_RE = /^(?:image|card|frame)-\d+\.(?:png|jpe?g|webp)$/i;

/** True only for an intended creative asset file (image-/card-/frame-NN.ext). */
export function isCreativeAssetFile(filePath: string): boolean {
  return CREATIVE_ASSET_FILE_RE.test(path.basename(filePath));
}

/** Numeric index of an allowlisted creative filename, so frame-2 sorts before frame-10. */
export function creativeIndexOf(filePath: string): number {
  const m = /-(\d+)\.[^.]+$/.exec(path.basename(filePath));
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}
