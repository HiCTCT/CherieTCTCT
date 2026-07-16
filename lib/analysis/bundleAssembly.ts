/**
 * Bundle row assembly (Phase 1) — PURE
 *
 * ONE definition of "which bundle row does each scoped source row become". Lifted
 * out of scripts/preview-browser-collected-ads.ts so the honesty contract can be
 * proven by tracked tests WITHOUT running preview, calling Anthropic, opening a
 * browser or touching the database.
 *
 * Imports canonical source identity only: no fs, no network, no Anthropic, no
 * Playwright, no Prisma.
 *
 * Honesty contract enforced here:
 *   - Every scoped source row produces exactly ONE bundle row.
 *   - A failed analysis becomes an honest ERROR row; it is never dropped.
 *   - A held row (REVIEW / SKIPPED / ERROR) carries a reason and NO result fields.
 *   - A blank, malformed or duplicate source ad_id fails the whole bundle: rows are
 *     never silently removed to make an output succeed.
 */

import { deriveSourceRowIdentity } from './sourceRowIdentity';
import type { BundleRow, BundleSuccessRow } from './browserAnalysisBundle';

/** Everything a SUCCESS row asserts BEYOND its canonical source identity. */
export type BundleSuccessPayload = Omit<
  BundleSuccessRow,
  | 'ad_id' | 'source_row_number' | 'source_status' | 'media_type'
  | 'creative_asset_path' | 'copy_used_for_scoring' | 'analysis_status' | 'error_reason'
>;

export type AssembleInput = {
  /** Every parsed source CSV row, in file order. Never pre-filtered. */
  rawRows: Record<string, string>[];
  /** Exact requested ids, or null for "every source row". */
  scopeIds: string[] | null;
  /** ad_id → analysis payload, for ads this run actually analysed. */
  success: Map<string, BundleSuccessPayload>;
  /** ad_id → error reason, for ads whose analysis failed. */
  errors: Map<string, string>;
  cwd?: string;
};

export type AssembleResult =
  | { ok: true; rows: BundleRow[]; inputRows: number }
  | { ok: false; errors: string[] };

/**
 * Assembles one honest row per scoped source row.
 *
 * A requested id that is absent from the source CSV fails: an exact-ID scope must
 * mean exactly those ads, never "those of them that happened to be present".
 */
export function assembleBundleRows(input: AssembleInput): AssembleResult {
  const { rawRows, success, errors: errorReasons } = input;
  const cwd = input.cwd ?? process.cwd();
  const scope = input.scopeIds ? new Set(input.scopeIds) : null;
  const problems: string[] = [];

  const rows: BundleRow[] = [];
  const seen = new Set<string>();

  rawRows.forEach((raw, i) => {
    const rowNumber = i + 2; // 1-based + header offset
    const ident = deriveSourceRowIdentity(raw, rowNumber, cwd);

    // Source hygiene — never echo the offending value into an error.
    if (ident.ad_id === '') { problems.push(`source row ${rowNumber}: ad_id is blank`); return; }
    if (!/^\d+$/.test(ident.ad_id)) { problems.push(`source row ${rowNumber}: ad_id is not an exact numeric id`); return; }
    if (seen.has(ident.ad_id)) { problems.push(`source CSV contains duplicate ad_id ${ident.ad_id}`); return; }
    seen.add(ident.ad_id);

    if (scope && !scope.has(ident.ad_id)) return;   // out of the requested scope

    const common = {
      ad_id: ident.ad_id,
      source_row_number: ident.source_row_number,
      source_status: ident.source_status,
      media_type: ident.media_type,
      creative_asset_path: ident.creative_asset_path,
      copy_used_for_scoring: ident.copy_used_for_scoring,
    };

    const payload = success.get(ident.ad_id);
    if (payload) {
      rows.push({ ...common, ...payload, analysis_status: 'SUCCESS', error_reason: null });
      return;
    }

    // Not analysed — record honestly, never silently omit. Held rows carry no
    // result block at all, so they cannot imply an analysis that never happened.
    const held = { ...common, creative_source: 'FALLBACK' as const, assets: [] };
    const failure = errorReasons.get(ident.ad_id);
    if (failure) { rows.push({ ...held, analysis_status: 'ERROR', error_reason: failure }); return; }

    switch (ident.source_status) {
      case 'NEEDS_REVIEW':
        rows.push({ ...held, analysis_status: 'REVIEW', error_reason: 'source status NEEDS_REVIEW — capture could not establish the ad state' });
        return;
      case 'UNAVAILABLE':
        // SKIPPED for planning, but source_status stays UNAVAILABLE: the ad was
        // positively observed as ended, which is not the same as "we skipped it".
        rows.push({ ...held, analysis_status: 'SKIPPED', error_reason: 'source status UNAVAILABLE — ad positively detected as ended/not in library' });
        return;
      case 'SKIP':
        rows.push({ ...held, analysis_status: 'SKIPPED', error_reason: 'source status SKIP' });
        return;
      case 'READY':
        rows.push({ ...held, analysis_status: 'REVIEW', error_reason: 'READY row was not analysed in this run (outside the processed selection)' });
        return;
      default:
        rows.push({ ...held, analysis_status: 'ERROR', error_reason: 'unrecognised source status — failing closed' });
    }
  });

  if (scope) {
    for (const id of scope) if (!seen.has(id)) problems.push(`requested ad_id ${id} is absent from the source CSV`);
  }

  if (problems.length > 0) return { ok: false, errors: problems };
  return { ok: true, rows, inputRows: rawRows.length };
}

// ─── Held-only output decision ────────────────────────────────────────────────

export type BundleOutputDecision = 'WRITE_HELD_ONLY' | 'EARLY_RETURN';

/**
 * What preview does when the scoped workload contains NO READY row.
 *
 * A scope of only NEEDS_REVIEW / SKIP / UNAVAILABLE rows is an honest result, not a
 * reason to produce nothing — but only when an output file was actually requested,
 * and never during the no-spend preflight, which must stay write-free.
 */
export function decideHeldOnlyBundleOutput(o: { outputRequested: boolean; preflight: boolean }): BundleOutputDecision {
  if (o.preflight) return 'EARLY_RETURN';
  return o.outputRequested ? 'WRITE_HELD_ONLY' : 'EARLY_RETURN';
}
