/**
 * Canonical source-row identity — PURE.
 *
 * ONE definition of "what this CSV row is", shared by the preview (which writes a
 * bundle) and the planner (which validates one). Because both sides derive identity
 * with the same rules, a bundle row can be bound to its actual CSV row field by
 * field — not merely to a whole-file checksum.
 *
 * Imports `path` only: no network, no Anthropic, no Playwright, no Prisma.
 *
 * NOTE: raw browser-listing `headline` / `description` are deliberately NOT part of
 * identity and are never read here. Only the approved primary browser copy field
 * (`ad_copy`, contamination-filtered) is used as scoring copy.
 */

import * as path from 'path';

export type SourceRowIdentity = {
  ad_id: string;
  source_row_number: number;
  source_status: string;
  media_type: string;
  creative_asset_path: string;   // canonical: repo-relative, forward slashes, '' when absent
  copy_used_for_scoring: string;
};

/**
 * Canonical repo-relative path with forward slashes, so a harmless Windows separator
 * difference never reads as a mismatch — while genuinely different paths still differ.
 */
export function canonicalAssetPath(p: string | undefined | null, cwd = process.cwd()): string {
  const raw = (p ?? '').trim();
  if (raw === '') return '';
  const abs = path.resolve(cwd, raw);
  const rel = path.relative(cwd, abs);
  return rel.split(path.sep).join('/');
}

/**
 * Detects comment-contaminated ad_copy (e.g. UGC comment dumps captured by the
 * browser). Mirrors the preview/ingestion rule exactly so scoring copy is identical
 * on both sides of the handoff.
 *
 * Flags as contaminated when:
 *  1. Copy starts with a separator character: ; | ,
 *  2. Copy contains 3+ semicolon-separated segments that are all short (avg < 120 chars)
 */
export function cleanAdCopyForScoring(raw: string): { cleanedCopy: string | undefined; wasContaminated: boolean } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { cleanedCopy: undefined, wasContaminated: false };

  if (/^[;|,]/.test(trimmed)) return { cleanedCopy: undefined, wasContaminated: true };

  const parts = trimmed.split(';');
  if (parts.length >= 3) {
    const avgLen = parts.map((p) => p.trim().length).reduce((a, b) => a + b, 0) / parts.length;
    if (avgLen < 120) return { cleanedCopy: undefined, wasContaminated: true };
  }
  return { cleanedCopy: trimmed, wasContaminated: false };
}

/** Derives the canonical identity of one parsed CSV row. `rowNumber` is 1-based + header. */
export function deriveSourceRowIdentity(
  raw: Record<string, string>,
  rowNumber: number,
  cwd = process.cwd(),
): SourceRowIdentity {
  return {
    ad_id: (raw.ad_id ?? '').trim(),
    source_row_number: rowNumber,
    source_status: (raw.collection_status ?? '').trim().toUpperCase(),
    media_type: (raw.media_type ?? '').trim().toUpperCase(),
    creative_asset_path: canonicalAssetPath(raw.creative_asset_path, cwd),
    copy_used_for_scoring: cleanAdCopyForScoring(raw.ad_copy ?? '').cleanedCopy ?? '',
  };
}

/** Field-by-field comparison. Returns the names of every mismatched field. */
export function sourceRowIdentityMismatch(expected: SourceRowIdentity, actual: SourceRowIdentity): string[] {
  const out: string[] = [];
  const keys: Array<keyof SourceRowIdentity> = [
    'ad_id', 'source_row_number', 'source_status', 'media_type', 'creative_asset_path', 'copy_used_for_scoring',
  ];
  for (const k of keys) if (expected[k] !== actual[k]) out.push(String(k));
  return out;
}
