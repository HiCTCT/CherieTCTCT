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
// Max cards per carousel. Not a fixed "3" — the capture keeps advancing until no
// visually-new card appears or this cap is hit. Override with BROWSER_MAX_CAROUSEL_CARDS.
const CAROUSEL_MAX = Math.max(1, Math.min(20, parseInt(process.env.BROWSER_MAX_CAROUSEL_CARDS ?? '10', 10) || 10));

const DEBUG_CAPTURE_GLOBAL = process.env.DEBUG_CAPTURE === 'true';

// Test-only flags (no DB writes; capture-side only):
//   BROWSER_ONLY_AD_ID       — process only this one ad_id from the CSV
//   BROWSER_FORCE_RECAPTURE  — ignore an existing creative_asset_path and recapture
//                              into the SAME asset folder (old generated files cleaned)
const ONLY_AD_ID      = (process.env.BROWSER_ONLY_AD_ID ?? '').trim();
const FORCE_RECAPTURE = process.env.BROWSER_FORCE_RECAPTURE === 'true';

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

// ── Phase H.3b: per-card metadata sidecar (no DB writes) ──────────────────────
// Capture runs one ad at a time, so a module-level accumulator avoids threading an
// extra param through every capture function. main() sets `captureAdId` before each
// ad; the carousel/video capture pushes one row per saved card/frame; main() writes
// data/imports/<basename>.cards.csv at the end.
type CardSidecarRow = {
  ad_id: string; card_index: number; asset_path: string; media_type: string;
  headline: string; description: string; cta: string; display_url: string; landing_url: string;
  brand?: string;   // transient: advertiser/competitor name from the source CSV; NOT serialized to .cards.csv
  strategy?: string; // transient: extraction strategy used (structured-footer/geometry-footer/legacy-fallback/carousel-column)
};
const cardRows: CardSidecarRow[] = [];
let captureAdId = '';
let captureBrand = '';
let captureAdCard: BBox | null = null;

const CARDS_HEADER = ['ad_id', 'card_index', 'asset_path', 'media_type', 'headline', 'description', 'cta', 'display_url', 'landing_url'];

function serializeCardsCsv(rows: CardSidecarRow[]): string {
  const lines = [CARDS_HEADER.join(',')];
  for (const r of rows) {
    lines.push([r.ad_id, String(r.card_index), r.asset_path, r.media_type, r.headline, r.description, r.cta, r.display_url, r.landing_url].map(csvEscape).join(','));
  }
  return lines.join('\n') + '\n';
}

function cardsCsvPath(inputFile: string): string {
  const dir  = path.dirname(inputFile);
  const base = path.basename(inputFile, '.csv');
  return path.join(dir, `${base}.cards.csv`);
}

// ── Ad-level VERIFIED metadata sidecar (separate from per-card .cards.csv) ─────
// One row per ad, PER-FIELD verification. Carousel ads accept an ad-level field ONLY
// when the same normalised value is proven across EVERY captured distinct card (with
// compatible CTA/display/landing). Static/video use one individually verified footer.
// Raw browser listing text is never used; missing evidence → blank.
type VerifiedMetaRow = {
  ad_id: string; verified_headline: string; verified_description: string;
  cta: string; display_url: string; landing_url: string; capture_strategy: string;
  headline_status: string; headline_reason: string;
  description_status: string; description_reason: string;
  verification_status: string; verification_reason: string; captured_at: string;
};
const verifiedMetaMap = new Map<string, VerifiedMetaRow>();   // keyed by ad_id; merge-safe across reruns
const VERIFIED_META_HEADER = ['ad_id', 'verified_headline', 'verified_description', 'cta', 'display_url', 'landing_url', 'capture_strategy', 'headline_status', 'headline_reason', 'description_status', 'description_reason', 'verification_status', 'verification_reason', 'captured_at'];

// Per-visible-card verified footer evidence, accumulated during a carousel capture and
// combined into ONE ad-level row. Reset at the start of every ad.
type FooterVerify = {
  cardIndex: number; strategy: string; contamination: string;
  headline: string; headlineStatus: GateDecision; headlineReason: string;
  description: string; descriptionStatus: GateDecision; descriptionReason: string;
  cta: string; displayUrl: string; landingUrl: string;
};
const carouselVerifiedResults: FooterVerify[] = [];

function serializeVerifiedMetaCsv(rows: VerifiedMetaRow[]): string {
  const lines = [VERIFIED_META_HEADER.join(',')];
  for (const r of rows) {
    lines.push([r.ad_id, r.verified_headline, r.verified_description, r.cta, r.display_url, r.landing_url, r.capture_strategy, r.headline_status, r.headline_reason, r.description_status, r.description_reason, r.verification_status, r.verification_reason, r.captured_at].map(csvEscape).join(','));
  }
  return lines.join('\n') + '\n';
}

// Canonical sidecar path: example.csv AND example.with-assets.csv both map to
// example.verified-meta.csv (identical rule in capture, preview and ingest).
function verifiedMetaPath(inputFile: string): string {
  const dir = path.dirname(inputFile);
  const base = path.basename(inputFile, '.csv').replace(/\.with-assets$/, '');
  return path.join(dir, `${base}.verified-meta.csv`);
}

// Strict loader for an EXISTING verified sidecar (same 14-column contract as preview/
// ingest). Returns the full rows so a rerun can preserve ads it does not re-capture.
function loadExistingVerifiedRows(p: string): { map: Map<string, VerifiedMetaRow>; status: string; message: string } {
  const map = new Map<string, VerifiedMetaRow>();
  if (!fs.existsSync(p)) return { map, status: 'absent', message: `absent (${p})` };
  let raw: string;
  try { raw = fs.readFileSync(p, 'utf-8'); } catch (e) { return { map, status: 'unreadable', message: `unreadable: ${e instanceof Error ? e.message : String(e)}` }; }
  let rows: Record<string, string>[];
  try { rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[]; } catch (e) { return { map, status: 'malformed', message: `malformed CSV: ${e instanceof Error ? e.message : String(e)}` }; }
  if (rows.length === 0) return { map, status: 'ok', message: 'present but empty' };
  const cols = Object.keys(rows[0]!);
  const missing = VERIFIED_META_HEADER.filter((c) => !cols.includes(c));
  if (missing.length) return { map, status: 'malformed', message: `malformed header — missing columns: ${missing.join(', ')}` };
  const counts = new Map<string, number>();
  for (const r of rows) { const id = (r.ad_id ?? '').trim(); if (id) counts.set(id, (counts.get(id) ?? 0) + 1); }
  const dups = Array.from(counts.entries()).filter(([, n]) => n > 1).map(([id]) => id);
  if (dups.length) return { map, status: 'duplicates', message: `duplicate ad_id(s): ${dups.join(', ')}` };
  for (const r of rows) {
    const id = (r.ad_id ?? '').trim();
    if (!id) continue;
    map.set(id, {
      ad_id: id, verified_headline: r.verified_headline ?? '', verified_description: r.verified_description ?? '',
      cta: r.cta ?? '', display_url: r.display_url ?? '', landing_url: r.landing_url ?? '', capture_strategy: r.capture_strategy ?? '',
      headline_status: r.headline_status ?? '', headline_reason: r.headline_reason ?? '',
      description_status: r.description_status ?? '', description_reason: r.description_reason ?? '',
      verification_status: r.verification_status ?? '', verification_reason: r.verification_reason ?? '', captured_at: r.captured_at ?? '',
    });
  }
  return { map, status: 'ok', message: `ok — ${map.size} existing row(s)` };
}

// Duplicate non-empty READY ad_id values in the source CSV (must abort before writing).
function duplicateReadyAdIds(rows: BrowserAdRow[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if ((r.collection_status ?? '').trim().toUpperCase() !== 'READY') continue;
    const id = (r.ad_id ?? '').trim();
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return Array.from(counts.entries()).filter(([, n]) => n > 1).map(([id]) => id);
}

function normVerifyText(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Pure cross-card combiner for one carousel field. ACCEPT only when EVERY captured card
// accepted that field, all share one normalised value, and CTA/display/landing match.
function combineCarouselField(
  cards: FooterVerify[], which: 'headline' | 'description',
  gate: { ok: boolean; status: GateDecision; reason: string },
): { status: GateDecision; reason: string; value: string } {
  if (!gate.ok) return { status: gate.status, reason: gate.reason, value: '' };
  if (cards.length < 2) return { status: 'REVIEW', reason: `${which} cannot be proven shared across the carousel — fewer than two distinct captured cards (${cards.length})`, value: '' };
  const valOf = (c: FooterVerify): string => which === 'headline' ? c.headline : c.description;
  const statOf = (c: FooterVerify): GateDecision => which === 'headline' ? c.headlineStatus : c.descriptionStatus;
  const accepted = cards.filter((c) => statOf(c) === 'ACCEPT' && valOf(c));
  if (accepted.length !== cards.length) {
    return { status: 'REVIEW', reason: `${which} accepted on only ${accepted.length}/${cards.length} captured card(s) — not shared across all`, value: '' };
  }
  if (new Set(cards.map((c) => normVerifyText(valOf(c)))).size !== 1) {
    return { status: 'REVIEW', reason: `${which} differs across captured cards — not a shared ad-level value`, value: '' };
  }
  const ctaSet = new Set(cards.map((c) => normVerifyText(c.cta)));
  const duSet = new Set(cards.map((c) => normVerifyText(c.displayUrl)));
  const luSet = new Set(cards.map((c) => normVerifyText(c.landingUrl)));
  if (ctaSet.size > 1 || duSet.size > 1 || luSet.size > 1) {
    return { status: 'REVIEW', reason: `${which} shared but CTA/display/landing context differs across cards`, value: '' };
  }
  return { status: 'ACCEPT', reason: `shared across all ${cards.length} captured card(s)`, value: valOf(cards[0]!) };
}

// Context (CTA/display/landing) is retained ONLY when it matches across EVERY captured
// carousel card. If any card differs, all three are blanked so no single card's context
// is attributed to the whole ad.
function combineCarouselContext(cards: FooterVerify[], gate: { ok: boolean; status: GateDecision; reason: string }): { cta: string; displayUrl: string; landingUrl: string; match: boolean; note: string } {
  if (!gate.ok) return { cta: '', displayUrl: '', landingUrl: '', match: false, note: `context blanked — exact Library ID unverified: ${gate.reason}` };
  if (cards.length < 2) return { cta: '', displayUrl: '', landingUrl: '', match: false, note: `context blanked — fewer than two distinct captured cards (${cards.length}); shared carousel attribution cannot be proven` };
  if (cards.some((c) => c.strategy === 'no-safe-footer')) return { cta: '', displayUrl: '', landingUrl: '', match: false, note: 'context blanked — one or more cards had an unverified footer scope' };
  const match = new Set(cards.map((c) => normVerifyText(c.cta))).size === 1
    && new Set(cards.map((c) => normVerifyText(c.displayUrl))).size === 1
    && new Set(cards.map((c) => normVerifyText(c.landingUrl))).size === 1;
  if (!match) return { cta: '', displayUrl: '', landingUrl: '', match: false, note: 'CTA/display/landing differ across captured cards — context blanked' };
  return { cta: cards[0]!.cta || '', displayUrl: cards[0]!.displayUrl || '', landingUrl: cards[0]!.landingUrl || '', match: true, note: '' };
}

// No-clobber merge rule. An existing row is preserved UNCHANGED unless the new capture
// produced at least one independently ACCEPTED field (a fully-verified result). A blank
// REVIEW/REJECT recapture never erases a previously accepted row. With no prior row, the
// new (even diagnostic) row is written so the sidecar records the current safe outcome.
function mergeDecision(existing: VerifiedMetaRow | undefined, newRow: VerifiedMetaRow): { write: boolean; action: string } {
  const newAccepted = newRow.headline_status === 'ACCEPT' || newRow.description_status === 'ACCEPT';
  if (existing && !newAccepted) return { write: false, action: 'preserved (recapture produced no ACCEPTED field — prior row kept unchanged)' };
  if (existing) return { write: true, action: 'replaced (newly ACCEPTED metadata)' };
  return { write: true, action: newAccepted ? 'created (ACCEPTED)' : 'created (diagnostic REVIEW/REJECT — no prior row)' };
}

// Build the overall summary + push one verified-meta row.
function pushVerifiedRow(
  adId: string,
  hVal: string, hStatus: GateDecision, hReason: string,
  dVal: string, dStatus: GateDecision, dReason: string,
  cta: string, displayUrl: string, landingUrl: string,
  strategy: string, dbg: DebugState, ctx: string,
): void {
  const overall = (hStatus === 'ACCEPT' || dStatus === 'ACCEPT') ? 'ACCEPT'
    : (hStatus === 'REJECT' || dStatus === 'REJECT') ? 'REJECT' : 'REVIEW';
  const newRow: VerifiedMetaRow = {
    ad_id: adId, verified_headline: hVal, verified_description: dVal,
    cta, display_url: displayUrl, landing_url: landingUrl, capture_strategy: strategy,
    headline_status: hStatus, headline_reason: hReason,
    description_status: dStatus, description_reason: dReason,
    verification_status: overall, verification_reason: ctx, captured_at: new Date().toISOString(),
  };
  const decision = mergeDecision(verifiedMetaMap.get(adId), newRow);
  if (decision.write) verifiedMetaMap.set(adId, newRow);
  console.log(`    verified-meta [${adId}]: ${decision.action}`);
  dbg.notes.push(`verified-meta ad ${adId}: ${decision.action} | overall=${overall} | headline=${hStatus}${hVal ? ` "${hVal}"` : ''} (${hReason}) | description=${dStatus}${dVal ? ` "${dVal}"` : ''} (${dReason}) | strategy=${strategy} | ${ctx}`);
}

// Post-processing safeguard (no DB): if 2+ visually-distinct CAROUSEL_CARD rows for
// the same ad carry the EXACT same headline + landingUrl AND have no per-card
// description/CTA difference, the metadata is shared/low-confidence (not truly
// per-card) — blank headline/description/displayUrl/landingUrl for those rows. The
// CTA is kept if present. Blank beats wrong card attribution.
// Brand / display / platform text that is NOT a real ad description or headline.
// Matched when the WHOLE field equals a known noise token, is a bare domain, or
// matches a Meta ad-status / date line. A genuine multi-word headline like
// "Dalton Storage Bed | Castlery Singapore" survives.
function isWeakMeta(s: string | null | undefined): boolean {
  const t = (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return true;                                   // blank
  const NOISE = new Set([
    'castlery', 'castlery.com', 'www.castlery.com',
    'https://www.castlery.com', 'http://www.castlery.com',
    'facebook', 'instagram', 'meta', 'sponsored',
    'open drop-down', 'platforms',
  ]);
  if (NOISE.has(t)) return true;
  // Bare display URL / domain only (no descriptive text, no real path).
  if (/^(https?:\/\/)?(www\.)?[a-z0-9-]+\.(com\.sg|com|sg|net|org)\/?$/.test(t)) return true;
  // Meta ad-status / date lines — regex, so dynamic dates and IDs are caught too.
  if (/^started running\b/.test(t)) return true;          // "Started running on 11 May 2025" / "Started running 11 May 2025"
  if (/^library id\b/.test(t)) return true;               // "Library ID: 123456789012345"
  if (/^(active|inactive)\b/.test(t)) return true;        // "Active", "Inactive", "Active since ..."
  if (/^\d{1,2}\s+[a-z]+\s+\d{4}$/.test(t)) return true;  // bare date "11 may 2025"
  if (isInstructionUiText(t)) return true;                 // "Use this creative and text", etc.
  return false;
}

// Generic interface / instruction phrases that are never advertiser copy, e.g.
// "Use this creative and text", "Use this template". Narrow to a "use this <noun>"
// shape so a real advertiser headline like "Use this code for 20% off" is kept.
function isInstructionUiText(s: string | null | undefined): boolean {
  const t = (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return false;
  if (/^use this (creative|template|ad|design|image|video|post|format|copy|text)\b/.test(t)) return true;
  return false;
}

// Normalised headline key: trimmed, whitespace-collapsed, lowercased.
function normHeadlineKey(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function dedupeSharedCardMeta(rows: CardSidecarRow[]): void {
  // ── Pass 1: blank headline+link repeated across 2+ visually-distinct cards ──
  const byAd = new Map<string, CardSidecarRow[]>();
  for (const r of rows) {
    if (r.media_type !== 'CAROUSEL_CARD') continue;
    const arr = byAd.get(r.ad_id) ?? [];
    arr.push(r);
    byAd.set(r.ad_id, arr);
  }

  for (const [adId, cards] of byAd) {
    if (cards.length < 2) continue;

    // Group ONLY by headline (normalised). Two or more visually-distinct cards
    // sharing the same non-empty headline is strong evidence the headline (and its
    // landing link) is global/shared, not card-specific.
    const byHeadline = new Map<string, CardSidecarRow[]>();
    for (const c of cards) {
      const hk = normHeadlineKey(c.headline);
      if (!hk) continue;
      const arr = byHeadline.get(hk) ?? [];
      arr.push(c);
      byHeadline.set(hk, arr);
    }

    for (const group of byHeadline.values()) {
      if (group.length < 2) continue;

      // STRONG per-card metadata = every card has its own distinct, non-weak
      // description. Weak text never counts; we have no such proof yet, so a
      // repeated headline is treated as shared and blanked.
      const strongDescs = group
        .map((g) => (g.description ?? '').trim())
        .filter((d) => d && !isWeakMeta(d));
      const distinctStrong = new Set(strongDescs.map((d) => d.toLowerCase()));
      const hasStrongDifferentiator =
        strongDescs.length === group.length && distinctStrong.size === group.length;
      if (hasStrongDifferentiator) continue;

      const labels = group.map((g) => `card-${String(g.card_index).padStart(2, '0')}`).join(', ');
      const sharedHead = (group[0]!.headline ?? '').trim();
      const sharedLand = group.map((g) => (g.landing_url ?? '').trim()).find((l) => l) ?? '';
      const seenDescs = group.map((g) => (g.description ?? '').trim() || 'blank').join(' / ');
      console.log(`    ⚠ metadata repeated across distinct cards: blanked shared headline/link for ${labels}`);
      console.log(`      shared headline "${sharedHead}" + landingUrl "${sharedLand}"`);
      console.log(`      weak descriptions ignored: ${seenDescs}`);
      for (const g of group) {
        g.headline = '';
        g.description = '';
        g.display_url = '';
        g.landing_url = '';
        // CTA intentionally kept.
      }
    }
  }

  // ── Pass 2: anchor rule ──────────────────────────────────────────────────────
  // A card's description / displayUrl / landingUrl are only trustworthy as
  // card-specific metadata when the card has a STRONG, card-specific headline —
  // non-empty AND not brand/display/platform/UI/status noise. If the only detected
  // "headline" is UI/status text (e.g. "Started running on 11 May 2025"), or there
  // is no headline at all, blank headline/description/displayUrl/landingUrl for that
  // card. CTA is always kept if confidently detected.
  for (const r of rows) {
    if (r.media_type !== 'CAROUSEL_CARD') continue;
    const rawHeadline = (r.headline ?? '').trim();
    const headlineStrong = rawHeadline !== '' && !isWeakMeta(rawHeadline);

    if (headlineStrong) {
      // Keep the strong headline; still drop a weak description so noise never shows.
      if ((r.description ?? '').trim() && isWeakMeta(r.description)) {
        console.log(`    ⚠ weak description ignored: "${r.description}" — brand/display/UI/status text; blanked`);
        r.description = '';
      }
      continue;
    }

    if (rawHeadline !== '' && isWeakMeta(rawHeadline)) {
      console.log(`    ⚠ rejected Meta status text: "${rawHeadline}"`);
    }
    const hadAttribution =
      rawHeadline !== '' ||
      (r.description ?? '').trim() !== '' ||
      (r.display_url ?? '').trim() !== '' ||
      (r.landing_url ?? '').trim() !== '';
    if (hadAttribution) {
      console.log(`    ⚠ card-${String(r.card_index).padStart(2, '0')} metadata blanked because no strong card-specific headline remained (CTA kept)`);
    }
    r.headline = '';
    r.description = '';
    r.display_url = '';
    r.landing_url = '';
    // CTA kept.
  }
}

// ── VIDEO_FRAME metadata sanitisation ─────────────────────────────────────────
// A pure video duration / progress timecode, e.g. 0:14, 1:05, 01:05, 0:01:05,
// 1:02:03. Used to reject playback-UI text that leaks into VIDEO_FRAME metadata.
function isDurationText(s: string | null | undefined): boolean {
  const t = (s ?? '').trim();
  if (!t) return false;
  return /^\d{1,2}(?::\d{2}){1,2}$/.test(t);
}

// Single VIDEO_FRAME rows are written straight from extractCardMeta, so the
// carousel dedupe / anchor safeguards never see them. Apply the same noise
// rejection here: blank a headline or description that is Meta status/date text
// (via isWeakMeta) or a video duration timecode (via isDurationText). CTA,
// displayUrl and landingUrl are the real single-ad link preview and are kept
// where present. No shared-metadata blanking (there is only one frame), and a
// headline is NEVER invented from the source CSV.
function sanitizeVideoFrameMeta(rows: CardSidecarRow[]): void {
  for (const r of rows) {
    if (r.media_type !== 'VIDEO_FRAME') continue;

    const h = (r.headline ?? '').trim();
    if (h) {
      if (isDurationText(h)) {
        console.log(`    ⚠ rejected video duration text from VIDEO_FRAME headline: "${h}"`);
        r.headline = '';
      } else if (isInstructionUiText(h)) {
        console.log(`    ⚠ rejected interface/instruction text from VIDEO_FRAME headline: "${h}"`);
        r.headline = '';
      } else if (isWeakMeta(h)) {
        console.log(`    ⚠ rejected Meta status text from VIDEO_FRAME headline: "${h}"`);
        r.headline = '';
      }
    }

    const d = (r.description ?? '').trim();
    if (d) {
      if (isDurationText(d)) {
        console.log(`    ⚠ rejected video duration text from VIDEO_FRAME description: "${d}"`);
        r.description = '';
      } else if (isInstructionUiText(d)) {
        console.log(`    ⚠ rejected interface/instruction text from VIDEO_FRAME description: "${d}"`);
        r.description = '';
      } else if (isWeakMeta(d)) {
        console.log(`    ⚠ rejected Meta status text from VIDEO_FRAME description: "${d}"`);
        r.description = '';
      }
    }
    // CTA, displayUrl, landingUrl kept — real single-ad link preview.
  }
}

// ── H.3f.1 Metadata Quality Gate ──────────────────────────────────────────────
// Decides whether a captured headline/description is safe advertiser copy.
// The system NEVER generates, rewrites, improves, or infers copy — it only accepts
// the EXACT text captured from the public Meta Ad Library page. Three outcomes:
//   ACCEPT — store verbatim
//   REVIEW — plausible but uncertain → blank in .cards.csv, logged in audit
//   REJECT — clear UI/status/date/duration/CTA/URL/instruction noise → blank
// Decisions are recorded in <basename>.cards.audit.csv (diagnosis only, never
// ingested or shown as advertiser copy). Reusable predicates below; isWeakMeta and
// the carousel safeguards are left intact.

type GateDecision = 'ACCEPT' | 'REVIEW' | 'REJECT';

type CardAuditRow = {
  ad_id: string; card_index: number; media_type: string; field: string;
  raw_value: string; decision: GateDecision; reason: string; stored_value: string; strategy: string;
};
const auditRows: CardAuditRow[] = [];
const CARDS_AUDIT_HEADER = ['ad_id', 'card_index', 'media_type', 'field', 'raw_value', 'decision', 'reason', 'stored_value', 'strategy'];

function serializeAuditCsv(rows: CardAuditRow[]): string {
  const lines = [CARDS_AUDIT_HEADER.join(',')];
  for (const r of rows) {
    lines.push([r.ad_id, String(r.card_index), r.media_type, r.field, r.raw_value, r.decision, r.reason, r.stored_value, r.strategy].map(csvEscape).join(','));
  }
  return lines.join('\n') + '\n';
}

function auditCsvPath(inputFile: string): string {
  const dir = path.dirname(inputFile);
  const base = path.basename(inputFile, '.csv');
  return path.join(dir, `${base}.cards.audit.csv`);
}

// CTA-button phrases that are never a headline/description on their own.
const CTA_PHRASES = [
  'shop now', 'learn more', 'sign up', 'book now', 'order now', 'get offer',
  'buy now', 'subscribe', 'download', 'contact us', 'send message', 'get quote',
  'apply now', 'see more', 'shop', 'view', 'get directions', 'call now', 'message',
];

// Normalise a label for brand comparison: lowercase, punctuation -> space, collapse.
// "W. Atelier" / "W Atelier" / "W.Atelier" all normalise to "w atelier".
function normalizeLabel(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

// Returns a specific reason string when the text is a HARD reject (UI/status/date/
// duration/instruction/URL/domain/platform/CTA), or null when it is not. Reuses the
// existing predicates; the noise token list mirrors isWeakMeta and is kept in sync.
function hardRejectReason(raw: string, cta?: string | null, brand?: string | null): string | null {
  const t = (raw ?? '').trim();
  if (!t) return 'empty';
  const low = t.toLowerCase().replace(/\s+/g, ' ');
  if (isDurationText(t)) return 'video duration/timecode';
  if (/^started running\b/.test(low)) return 'Meta ad-status text';
  if (/^library id\b/.test(low)) return 'Meta Library ID label';
  if (/^(active|inactive)\b/.test(low)) return 'Meta status label';
  if (/^\d{1,2}\s+[a-z]+\s+\d{4}$/.test(low)) return 'date text';
  if (isInstructionUiText(t)) return 'interface/instruction text';
  if (/^https?:\/\//i.test(t)) return 'URL';
  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com\.sg|com|sg|net|org)\/?$/i.test(low)) return 'domain/display URL';
  const NOISE = new Set([
    'castlery', 'castlery.com', 'www.castlery.com', 'https://www.castlery.com',
    'http://www.castlery.com', 'facebook', 'instagram', 'meta', 'sponsored',
    'open drop-down', 'platforms',
  ]);
  if (NOISE.has(low)) return 'platform/brand/UI label';
  const ctaLow = (cta ?? '').toLowerCase().trim();
  if (ctaLow && low === ctaLow) return 'duplicate of CTA field';
  if (CTA_PHRASES.includes(low)) return 'CTA-only text';
  // Source-aware: a value that is ONLY the advertiser/brand label is not card copy.
  const nb = normalizeLabel(brand);
  if (nb && normalizeLabel(t) === nb) return 'advertiser/brand label only';
  return null;
}

// Positive advertiser-copy signal: a natural multi-word phrase. Conservative — when
// in doubt this returns false so the gate falls through to REVIEW rather than ACCEPT.
function looksLikeAdvertiserCopy(raw: string): boolean {
  const t = (raw ?? '').trim();
  if (t.length < 6 || t.length > 200) return false;
  if (!/[a-zA-Z]/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  return words.length >= 2;
}

function reviewReason(raw: string): string {
  const t = (raw ?? '').trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2) return 'single-token text — unclear if advertiser copy';
  if (t.length < 6) return 'too short to confirm as advertiser copy';
  return 'ambiguous generic phrase';
}

// The single decision point. No generation/inference — classify the captured text only.
function classifyMetaText(raw: string, cta?: string | null, brand?: string | null): { decision: GateDecision; reason: string } {
  const hr = hardRejectReason(raw, cta, brand);
  if (hr) return { decision: 'REJECT', reason: hr };
  if (looksLikeAdvertiserCopy(raw)) return { decision: 'ACCEPT', reason: 'advertiser copy captured verbatim' };
  return { decision: 'REVIEW', reason: reviewReason(raw) };
}

// Applies the gate to headline + description AFTER the carousel/video safeguards have
// run. rawMeta holds the originally-captured values (pre-blanking) so the audit can
// explain decisions even for values a safeguard already blanked. Only ACCEPT values
// remain in .cards.csv; REVIEW/REJECT are blanked. CTA / display_url / landing_url
// are never touched here.
function applyMetadataQualityGate(rows: CardSidecarRow[], rawMeta: { headline: string; description: string }[]): void {
  let nAccept = 0, nReview = 0, nReject = 0;
  const FIELDS: ('headline' | 'description')[] = ['headline', 'description'];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const raw = rawMeta[i] ?? { headline: '', description: '' };
    for (const field of FIELDS) {
      const rawVal = (raw[field] ?? '').trim();
      if (!rawVal) continue;                       // nothing was captured → no decision to record
      const current = (r[field] ?? '').trim();
      const cls = classifyMetaText(rawVal, r.cta, r.brand);
      let decision: GateDecision = cls.decision;
      let reason = cls.reason;
      let stored = '';

      if (decision === 'ACCEPT' && current === '') {
        // The text itself reads like copy, but a safeguard already blanked it
        // (carousel shared-metadata / anchor rule). Respect that: REVIEW, stays blank.
        decision = 'REVIEW';
        reason = r.media_type === 'CAROUSEL_CARD'
          ? 'repeated/shared across carousel cards — weak card attribution'
          : 'blanked by capture safeguard before quality gate';
        r[field] = '';
      } else if (decision === 'ACCEPT') {
        stored = rawVal;
        r[field] = rawVal;                         // store the exact captured text
      } else {
        r[field] = '';                             // REVIEW / REJECT must be blank
      }

      if (decision === 'ACCEPT') nAccept++;
      else if (decision === 'REVIEW') nReview++;
      else nReject++;

      auditRows.push({
        ad_id: r.ad_id, card_index: r.card_index, media_type: r.media_type, field,
        raw_value: rawVal, decision, reason, stored_value: stored, strategy: r.strategy ?? '',
      });

      if (decision !== 'ACCEPT') {
        console.log(`    ${decision === 'REJECT' ? '✗' : '?'} gate ${field} ${decision}: "${rawVal.slice(0, 60)}" — ${reason}`);
      }
    }
  }
  if (nAccept + nReview + nReject > 0) {
    console.log(`    quality gate: ${nAccept} accepted, ${nReview} review, ${nReject} rejected (audit rows: ${auditRows.length})`);
  }
}

// Read-only extraction-coverage diagnostic for one capture run. Measures whether the
// footer engine actually improved field coverage, before any DB update. No writes.
function printCoverageReport(rows: CardSidecarRow[], audits: CardAuditRow[]): void {
  const rejected = audits.filter((a) => a.decision === 'REJECT').length;
  const review = audits.filter((a) => a.decision === 'REVIEW').length;
  const reportFor = (mt: string): void => {
    const sub = rows.filter((r) => r.media_type === mt);
    if (sub.length === 0) return;
    const accH = sub.filter((r) => (r.headline ?? '').trim() !== '').length;
    const accD = sub.filter((r) => (r.description ?? '').trim() !== '').length;
    const bothBlank = sub.filter((r) => !(r.headline ?? '').trim() && !(r.description ?? '').trim()).length;
    const byStrat = (s: string): number => sub.filter((r) => (r.strategy ?? '') === s).length;
    console.log(`  ${mt}: ${sub.length} row(s)`);
    console.log(`     accepted headline: ${accH}   accepted description: ${accD}   both blank: ${bothBlank}`);
    console.log(`     strategy -> structured-footer: ${byStrat('structured-footer')}  scoped-geometry-footer: ${byStrat('scoped-geometry-footer')}  no-safe-footer: ${byStrat('no-safe-footer')}  legacy-fallback: ${byStrat('legacy-fallback')}  carousel-column: ${byStrat('carousel-column')}`);
  };
  console.log('  -- Extraction coverage (read-only diagnostic) --');
  reportFor('VIDEO_FRAME');
  reportFor('CREATIVE_IMAGE');
  reportFor('CAROUSEL_CARD');
  console.log(`     quality-gate field decisions -> REJECT: ${rejected}  REVIEW: ${review}`);
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

/**
 * Remove ONLY this script's generated files from an existing asset folder (used by
 * BROWSER_FORCE_RECAPTURE so a recapture starts clean). The folder itself and any
 * non-generated user files are left intact. Generated names are well-known:
 *   card-NN.png, image-NN.png, frame-NN.png, .tmp-*.png, .thumb.png,
 *   debug-*-<adId>.{png,txt}, video.mp4, video-summary-notes.txt, video-source-url.txt
 */
function cleanGeneratedAssets(dir: string): void {
  if (!fs.existsSync(dir)) return;
  try {
    for (const f of fs.readdirSync(dir)) {
      const isGenerated =
        /^card-\d+\.png$/i.test(f) ||
        /^image-\d+\.png$/i.test(f) ||
        /^frame-\d+\.png$/i.test(f) ||
        /^\.tmp-.*\.png$/i.test(f) ||
        /^\.thumb\.png$/i.test(f) ||
        /^debug-.*\.(png|txt)$/i.test(f) ||
        f === 'video.mp4' ||
        f === 'video-summary-notes.txt' ||
        f === 'video-source-url.txt';
      if (isGenerated) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort — never throw from cleanup */ }
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
  "ad isn't in the ad library",   // Meta empty-state: ad removed / not yet in library
  'ad is not in the ad library',  // alternate phrasing
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

    // Consider ALL images + videos, then let the placeholder + size rejection below
    // drop chrome. Restricting to specific CDN hosts up front was too strict and
    // missed real creatives whose <img> src does not contain scontent/fbcdn/
    // cdninstagram (lazy-loaded, srcset-driven, or served from another host). The
    // placeholder gate (data:/svg/rsrc.php/emoji/static/safe_image/avatar/logo) and
    // the size/aspect filters still reject non-creative images.
    const mediaEls = Array.from(document.querySelectorAll<HTMLElement>('img, video'));

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
        // Video player container: allow real media slightly shorter than the generic
        // 280x250 floor (>=200x180) so genuine but shorter video regions are kept.
        // The seed <video>/poster is used anyway if no larger container qualifies,
        // and the final size gate still guards against tiny chrome.
        if (cb.width >= 200 && cb.height >= 180 && car >= 0.5 && car <= 2.2 &&
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
      // ── Compact-carousel fallback ──
      // Some Meta carousels use small square cards / compact rails (~140–200px) with
      // no >=280x250 viewport container. Build the visible rail bbox from the real,
      // in-card, non-placeholder image candidates aligned on one row. Avatars, logos,
      // profile pics, icons, SVG/emoji, tiny and off-card images are already excluded
      // by the placeholder + reject classification (c.reject).
      if (!best) {
        log.push('compact-carousel fallback: normal large viewport (>=280x250) not found');
        const compact = cands.filter((c) => c.tag === 'img' && !c.reject && c.inCard && c.inView && c.w >= 140 && c.h >= 140);
        log.push(`compact-carousel fallback: ${compact.length} in-card image candidate(s) >=140x140`);
        if (compact.length >= 1) {
          // Pick the row nearest the card's vertical centre, then union cards sharing
          // that row (centre y within 40px) — the visible carousel rail/card area.
          const cardCy = card.y + card.height / 2;
          let rowSeed = compact[0]!;
          let bestDy = Math.abs((rowSeed.y + rowSeed.h / 2) - cardCy);
          for (const c of compact) {
            const dy = Math.abs((c.y + c.h / 2) - cardCy);
            if (dy < bestDy) { bestDy = dy; rowSeed = c; }
          }
          const rowCy = rowSeed.y + rowSeed.h / 2;
          const row = compact.filter((c) => Math.abs((c.y + c.h / 2) - rowCy) <= 40);
          let minX = Infinity; let minY = Infinity; let maxR = -Infinity; let maxB = -Infinity;
          for (const c of row) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxR = Math.max(maxR, c.x + c.w); maxB = Math.max(maxB, c.y + c.h); }
          // Clamp to the ad card AND the viewport so we cover the rail, not chrome.
          const fx = Math.max(minX, card.x, 0);
          const fy = Math.max(minY, card.y, 0);
          const fr = Math.min(maxR, card.x + card.width, vw);
          const fb = Math.min(maxB, card.y + card.height, vh);
          const fw = fr - fx; const fh = fb - fy;
          if (fw >= 140 && fh >= 140) {
            best = { x: fx, y: fy, width: fw, height: fh };
            log.push(`compact-carousel fallback: selected rail ${Math.round(fw)}x${Math.round(fh)} at (${Math.round(fx)},${Math.round(fy)}) from ${row.length} aligned card(s)`);
          } else {
            log.push(`compact-carousel fallback: rail ${Math.round(fw)}x${Math.round(fh)} too small after clamp — failed`);
          }
        } else {
          log.push('compact-carousel fallback: no in-card image candidate >=140x140 — failed');
        }
      }
      if (!best) return { found: false as const, notes: [...log, 'no carousel viewport (normal or compact) inside card'] };
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
    // Final size gate. Carousel floor is 260x140 so compact square-card rails
    // (~175x175) are accepted while genuine tiny tiles/chrome are still rejected.
    // Image/video only need a real creative region, not modal chrome, so the floor
    // is low — this is what stops legitimate creatives being over-rejected.
    if (mt === 'CAROUSEL' && (r.width < 260 || r.height < 140)) {
      notes.push(`REJECTED final: carousel ${Math.round(r.width)}x${Math.round(r.height)} below 260x140 minimum`);
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
type CardIdentity = { src: string; x: number; y: number; w: number; h: number; text: string };

async function findCentralCard(
  page: Page, vp: BBox,
): Promise<{ bbox: BBox | null; identity: CardIdentity | null; notes: string[] }> {
  const r = await page.evaluate((view) => {
    const cx = view.x + view.width / 2;
    const log: string[] = [];
    type K = { el: HTMLImageElement; x: number; y: number; w: number; h: number; dist: number; vis: number; src: string };
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
      cands.push({ el: img, x: b.x, y: b.y, w: b.width, h: b.height, dist, vis, src });
      log.push(`card-img ${Math.round(b.width)}x${Math.round(b.height)} at (${Math.round(b.x)},${Math.round(b.y)}) distFromCentre=${Math.round(dist)} vis=${vis.toFixed(2)} src=${src.replace(/^https?:\/\//, '').slice(0, 44)}`);
    }
    if (!cands.length) return { found: false as const, log };
    // Prefer the most-centred card that is at least 60% visible; else most centred.
    cands.sort((a, b) => a.dist - b.dist);
    let pick = cands[0]!;
    for (const c of cands) { if (c.vis >= 0.6) { pick = c; break; } }
    // Identity: src + raw (pre-clamp) bbox + a short text snippet from the nearest
    // text-bearing ancestor — used to confirm the carousel actually moved to a
    // different card, not just a re-crop of the same one.
    let text = '';
    let anc: HTMLElement | null = pick.el.parentElement; let d = 0;
    while (anc && d < 4) {
      const t = (anc.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length >= 4) { text = t.slice(0, 80); break; }
      anc = anc.parentElement; d++;
    }
    // Clamp to the viewport so neighbouring/overflow cards are excluded.
    const PAD = 8;
    const x = Math.max(pick.x - PAD, view.x);
    const y = Math.max(pick.y - PAD, view.y);
    const right  = Math.min(pick.x + pick.w + PAD, view.x + view.width);
    const bottom = Math.min(pick.y + pick.h + PAD, view.y + view.height);
    log.push(`SELECTED central card at (${Math.round(pick.x)},${Math.round(pick.y)}) ${Math.round(pick.w)}x${Math.round(pick.h)} src=${pick.src.replace(/^https?:\/\//, '').slice(0, 44)} — closest to centre, vis=${pick.vis.toFixed(2)}; ${cands.length - 1} neighbour(s) excluded`);
    return {
      found: true as const, x, y, width: right - x, height: bottom - y,
      idSrc: pick.src, idX: pick.x, idY: pick.y, idW: pick.w, idH: pick.h, idText: text, log,
    };
  }, vp);

  const notes = Array.isArray((r as { log?: string[] }).log) ? (r as { log: string[] }).log : [];
  if (r.found && r.width >= 80 && r.height >= 80) {
    const rr = r as { idSrc: string; idX: number; idY: number; idW: number; idH: number; idText: string };
    return {
      bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
      identity: { src: rr.idSrc, x: rr.idX, y: rr.idY, w: rr.idW, h: rr.idH, text: rr.idText },
      notes,
    };
  }
  return { bbox: null, identity: null, notes };
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

function srcSnip(s: string | undefined | null): string {
  return s ? s.replace(/^https?:\/\//, '').slice(0, 44) : '(none)';
}

/**
 * Advance the carousel by clicking a real, visible, enabled next-control beside the
 * creative. Guarded + never throws. Returns the method used (for debug). DOM click
 * is tried first, then a located-point page.mouse.click. ArrowRight is a separate
 * escalation handled by the caller when no movement is detected.
 */
async function clickNextControl(page: Page, creativeBBox: BBox): Promise<string> {
  try {
    await page.mouse.move(creativeBBox.x + creativeBBox.width * 0.92, creativeBBox.y + creativeBBox.height / 2);
    await page.waitForTimeout(350);
  } catch { /* ignore */ }

  const dom = await page.evaluate((bbox) => {
    try {
      const keys = ['next', 'forward', 'right', 'chevron'];
      let best: Element | null = null;
      let bestDist = Infinity;
      for (const el of Array.from(document.querySelectorAll('button,[role="button"],[aria-label],div[tabindex="0"],a[role="button"]'))) {
        const he = el as HTMLElement;
        const r = he.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;                       // zero-size
        const st = window.getComputedStyle(he);
        if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity || '1') === 0) continue; // hidden/opacity-0
        if (he.hasAttribute('disabled') || he.getAttribute('aria-disabled') === 'true') continue;                  // disabled
        const lbl = ((he.getAttribute('aria-label') || '') + ' ' + (he.getAttribute('data-testid') || '')).toLowerCase();
        if (!keys.some((k) => lbl.includes(k))) continue;                  // must be a next-ish control
        const ccx = r.x + r.width / 2;
        const ccy = r.y + r.height / 2;
        const nearV = ccy >= bbox.y - 80 && ccy <= bbox.y + bbox.height + 80;        // beside the creative vertically
        const nearRight = ccx >= bbox.x + bbox.width * 0.45 && ccx <= bbox.x + bbox.width + 140; // right side / just beside
        if (!nearV || !nearRight) continue;
        const d = Math.abs(ccx - (bbox.x + bbox.width));
        if (d < bestDist) { bestDist = d; best = el; }
      }
      if (!best) return { ok: false, method: 'no-next-button' };
      const ctrl = (best.closest('button,[role="button"],a,[tabindex]') as HTMLElement | null) || (best as HTMLElement);
      if (typeof (ctrl as { click?: unknown }).click === 'function') { (ctrl as HTMLElement).click(); return { ok: true, method: 'dom-click' }; }
      for (const t of ['mousedown', 'mouseup', 'click']) ctrl.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
      return { ok: true, method: 'dom-dispatch' };
    } catch {
      return { ok: false, method: 'dom-error' }; // never throw from the click attempt
    }
  }, creativeBBox);

  if (dom.ok) return dom.method;

  // Fallback: locate a button point and use the real mouse.
  const pt = await findCarouselNextButton(page, creativeBBox);
  if (pt) {
    try { await page.mouse.click(pt.x, pt.y); return 'mouse-click'; }
    catch { /* fall through */ }
  }
  return dom.method; // 'no-next-button' / 'dom-error'
}

/** Keyboard escalation: focus the carousel area, then press ArrowRight. Never throws. */
async function pressArrowRightOnCarousel(page: Page, creativeBBox: BBox): Promise<void> {
  try {
    await page.mouse.click(creativeBBox.x + creativeBBox.width / 2, creativeBBox.y + creativeBBox.height / 2);
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowRight');
  } catch { /* ignore */ }
}

/**
 * Poll (up to ~2.4s) for the carousel to land on a MEANINGFULLY different card.
 * "Meaningful" requires both a screenshot-signature change AND a real identity
 * change (different image src, a rail shift > 40px, or different card text) versus
 * the previously-saved card — and the new src must not be one we already captured.
 * This rejects tiny-overlay changes and re-crops of the same card.
 */
/**
 * Perceptual visual-difference ratio between two PNG buffers, computed with the
 * browser's own canvas (no new dependency). Both images are drawn into a small
 * NxN canvas and the mean per-pixel grayscale difference is returned in [0,1]:
 * 0 = identical, higher = more different. Inline-only evaluate body (anonymous
 * arrows only) to avoid the tsx/esbuild __name injection.
 */
async function visualDiffRatio(page: Page, pngA: Buffer, pngB: Buffer): Promise<number> {
  const a = `data:image/png;base64,${pngA.toString('base64')}`;
  const b = `data:image/png;base64,${pngB.toString('base64')}`;
  try {
    return await page.evaluate(async (args) => {
      const N = 64;
      const imgA = new Image();
      await new Promise((resolve, reject) => { imgA.onload = () => resolve(null); imgA.onerror = () => reject(new Error('a')); imgA.src = args.a; });
      const imgB = new Image();
      await new Promise((resolve, reject) => { imgB.onload = () => resolve(null); imgB.onerror = () => reject(new Error('b')); imgB.src = args.b; });
      const ca = document.createElement('canvas'); ca.width = N; ca.height = N;
      const cb = document.createElement('canvas'); cb.width = N; cb.height = N;
      const xa = ca.getContext('2d');
      const xb = cb.getContext('2d');
      if (!xa || !xb) return 1;
      xa.drawImage(imgA, 0, 0, N, N);
      xb.drawImage(imgB, 0, 0, N, N);
      const da = xa.getImageData(0, 0, N, N).data;
      const db = xb.getImageData(0, 0, N, N).data;
      let sum = 0; let count = 0;
      for (let i = 0; i < da.length; i += 4) {
        // per-channel RGB difference (ignore alpha) so colour changes at equal
        // luminance still register as different cards
        sum += Math.abs(da[i]! - db[i]!) + Math.abs(da[i + 1]! - db[i + 1]!) + Math.abs(da[i + 2]! - db[i + 2]!);
        count += 3;
      }
      return count ? (sum / count) / 255 : 1;
    }, { a, b });
  } catch {
    return 1; // on any failure, treat as fully different (never block a real new card)
  }
}

// ── Carousel movement helpers (Node-side; never throw) ──
async function moveMouseRightEdge(page: Page, bbox: BBox): Promise<void> {
  try { await page.mouse.click(bbox.x + bbox.width - 14, bbox.y + bbox.height / 2); } catch { /* ignore */ }
}
async function wheelCarousel(page: Page, bbox: BBox): Promise<void> {
  try {
    await page.mouse.move(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
    await page.mouse.wheel(Math.max(260, Math.round(bbox.width)), 0);
  } catch { /* ignore */ }
}
async function swipeCarousel(page: Page, bbox: BBox): Promise<void> {
  try {
    const y = bbox.y + bbox.height / 2;
    const startX = bbox.x + bbox.width * 0.85;
    const endX = bbox.x + bbox.width * 0.2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    for (let s = 1; s <= 6; s++) { await page.mouse.move(startX - (startX - endX) * (s / 6), y, { steps: 2 }); await page.waitForTimeout(40); }
    await page.mouse.up();
  } catch { /* ignore */ }
}

// Reject a candidate card if its visual diff vs EVERY already-saved card is below
// this (i.e. it looks like a card we already have). Tuned for downscaled 64x64
// grayscale comparison; a genuinely different product photo diffs well above this.
const VISUAL_DIFF_MIN = 0.045;

/**
 * Return ALL well-visible carousel card images inside the viewport, ordered
 * left→right, each with its own crop bbox + identity. Unlike findCentralCard
 * (which returns only the central card), this lets a compact rail showing several
 * cards at once be captured fully. Inline-only evaluate (anonymous arrows).
 */
async function findVisibleCards(
  page: Page, vp: BBox,
): Promise<{ cards: { crop: BBox; id: CardIdentity }[]; notes: string[] }> {
  const r = await page.evaluate((view) => {
    const log: string[] = [];
    const out: { cx: number; cropX: number; cropY: number; cropW: number; cropH: number; src: string; idX: number; idY: number; idW: number; idH: number; text: string }[] = [];
    const PAD = 8;
    for (const img of Array.from(document.querySelectorAll<HTMLImageElement>(
      'img[src*="scontent"], img[src*="fbcdn.net"], img[src*="cdninstagram"]',
    ))) {
      const b = img.getBoundingClientRect();
      const src = (img.currentSrc || img.src || '').toLowerCase();
      if (src.startsWith('data:') || src.includes('rsrc.php') || src.includes('.svg') ||
          (src.includes('static.') && src.includes('fbcdn'))) continue;
      const ox = Math.min(b.x + b.width,  view.x + view.width)  - Math.max(b.x, view.x);
      const oy = Math.min(b.y + b.height, view.y + view.height) - Math.max(b.y, view.y);
      if (ox <= 0 || oy <= 0) continue;
      if (b.width < 100 || b.height < 100) continue;
      if (b.height < view.height * 0.35) continue;
      const vis = (ox * oy) / (b.width * b.height);
      if (vis < 0.5) continue; // skip half-cut edge cards
      let text = '';
      let anc: HTMLElement | null = img.parentElement; let d = 0;
      while (anc && d < 4) { const t = (anc.textContent || '').replace(/\s+/g, ' ').trim(); if (t.length >= 4) { text = t.slice(0, 80); break; } anc = anc.parentElement; d++; }
      const x = Math.max(b.x - PAD, view.x);
      const y = Math.max(b.y - PAD, view.y);
      const right  = Math.min(b.x + b.width + PAD, view.x + view.width);
      const bottom = Math.min(b.y + b.height + PAD, view.y + view.height);
      out.push({ cx: b.x, cropX: x, cropY: y, cropW: right - x, cropH: bottom - y, src, idX: b.x, idY: b.y, idW: b.width, idH: b.height, text });
      log.push(`visible card ${Math.round(b.width)}x${Math.round(b.height)} at (${Math.round(b.x)},${Math.round(b.y)}) vis=${vis.toFixed(2)} src=${src.replace(/^https?:\/\//, '').slice(0, 44)}`);
    }
    out.sort((a, b) => a.cx - b.cx); // left → right
    return { out, log };
  }, vp);

  const cards = r.out
    .filter((o) => o.cropW >= 80 && o.cropH >= 80)
    .map((o) => ({
      crop: { x: o.cropX, y: o.cropY, width: o.cropW, height: o.cropH },
      id: { src: o.src, x: o.idX, y: o.idY, w: o.idW, h: o.idH, text: o.text } as CardIdentity,
    }));
  return { cards, notes: r.log };
}

/**
 * Best-effort per-card link-preview metadata, scoped to the card's column and the
 * caption band directly below the card image. Conservative — returns blanks when
 * nothing confident is found; never invents text. Inline-only evaluate (anonymous
 * arrows) to avoid the tsx/esbuild __name injection.
 */
async function extractCardMeta(
  page: Page, cardBBox: BBox,
): Promise<{ headline: string; description: string; cta: string; displayUrl: string; landingUrl: string; candidates: number; rejectedUi: string[]; reason: string }> {
  try {
    return await page.evaluate((bb) => {
      const blocked = ['facebook.com', 'fb.com', 'fb.me', 'meta.com', 'metastatus.com', 'instagram.com', 'whatsapp.com', 'messenger.com', 'fbcdn.net', 'cdninstagram'];
      const ctaWords = ['shop now', 'learn more', 'book now', 'sign up', 'contact us', 'send message', 'get quote', 'apply now', 'download', 'subscribe', 'order now', 'get offer', 'see menu', 'watch more', 'listen now', 'get directions'];
      // Meta UI / chrome text — never a real headline or description.
      const uiChrome = ['open drop-down', 'open drop-down menu', 'open drop down menu', 'open drop down', 'drop-down menu', 'more', 'see more', 'see less', 'sponsored', 'active', 'inactive', 'library id', 'why am i seeing', 'see ad details', 'see summary details', 'see summary', 'this ad has', 'ad library', 'platforms'];
      const colMinX = bb.x - 10;
      const colMaxX = bb.x + bb.width + 10;
      const top = bb.y + bb.height * 0.5;   // caption sits at/below the image bottom
      const bot = bb.y + bb.height + 240;   // ~240px below for the link-preview block
      // Card-scoped width: a per-card caption is roughly card-width. Reject anything
      // wider — those are shared / rail-spanning previews, NOT card-specific.
      const maxElemW = Math.max(bb.width * 1.5, 150);
      let landingUrl = '';
      let displayUrl = '';
      let cta = '';
      let candidates = 0;
      const rejectedUi: string[] = [];
      const lines: { y: number; text: string }[] = [];
      for (const el of Array.from(document.querySelectorAll('a, span, div, button'))) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const ccx = r.x + r.width / 2;
        const ccy = r.y + r.height / 2;
        if (ccx < colMinX || ccx > colMaxX) continue;                       // centre in this card's column
        if (ccy < top || ccy > bot) continue;                               // caption band below the card
        if (r.width > maxElemW) continue;                                   // reject wide shared / rail-spanning blocks
        if (r.x < colMinX - 6 || r.x + r.width > colMaxX + 6) continue;     // must not spill beyond the card column
        const tag = el.tagName.toLowerCase();
        if (tag === 'a' && !landingUrl) {
          const href = (el as HTMLAnchorElement).getAttribute('href') || '';
          let target = href;
          const um = href.match(/[?&]u=([^&]+)/);
          if (um) { try { target = decodeURIComponent(um[1]!); } catch { /* keep */ } }
          if (/^https?:\/\//.test(target)) {
            let isB = false;
            for (const d of blocked) if (target.toLowerCase().includes(d)) { isB = true; break; }
            if (!isB) landingUrl = target;
          }
        }
        let direct = '';
        for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) direct += n.textContent || '';
        direct = direct.replace(/\s+/g, ' ').trim();
        if (!direct) continue;
        candidates++;
        const low = direct.toLowerCase();
        // Reject Meta UI / chrome text outright (never headline/description); log it.
        let isChrome = false;
        for (const u of uiChrome) if (low === u || low.includes(u)) { isChrome = true; break; }
        if (isChrome) { if (rejectedUi.length < 12 && rejectedUi.indexOf(direct) < 0) rejectedUi.push(direct); continue; }
        // CTA is allowed (even though never a headline).
        if (!cta && direct.length <= 20) { for (const w of ctaWords) if (low === w || low.includes(w)) { cta = direct; break; } }
        if (!displayUrl && /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com\.sg|com|sg|net|org)$/i.test(direct)) { displayUrl = direct; continue; }
        if (direct.length < 3 || direct.length > 160) continue;
        if (/^\d+$/.test(direct)) continue;                                      // numeric id
        let isCtaOnly = false; for (const w of ctaWords) if (low === w) { isCtaOnly = true; break; }
        if (isCtaOnly) continue;
        if (/^(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.(?:com\.sg|com|sg|net|org)$/i.test(direct)) continue; // url-only line
        lines.push({ y: r.y, text: direct });
      }
      if (!displayUrl && landingUrl) {
        try { displayUrl = new URL(landingUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
      }
      lines.sort((a, b) => a.y - b.y);
      const uniq: string[] = [];
      for (const l of lines) if (uniq.indexOf(l.text) < 0) uniq.push(l.text);
      const headline = uniq[0] || '';
      const description = (uniq[1] && uniq[1] !== headline) ? uniq[1] : '';
      let reason = '';
      if (!headline && !landingUrl && !cta) reason = `no card-scoped metadata in this card column/band (rejected ${rejectedUi.length} UI text item(s); other text too wide/shared or absent)`;
      else if (!headline) reason = 'card-scoped CTA/link found but no card-specific headline text — headline left blank';
      else reason = `card-scoped text block (<= ${Math.round(maxElemW)}px wide) within the card column`;
      return { headline, description, cta, displayUrl, landingUrl, candidates, rejectedUi, reason };
    }, cardBBox);
  } catch {
    return { headline: '', description: '', cta: '', displayUrl: '', landingUrl: '', candidates: 0, rejectedUi: [], reason: 'extract error' };
  }
}

/**
 * Layout-aware Meta Ad Library footer extraction engine with STRICT ad-card
 * containment (reusable for VIDEO and static IMAGE; carousel keeps its column path).
 *
 * extractCardFooterRaw establishes a verified ad-card ROOT generically: it finds the
 * creative-media node and the CTA node, then their nearest shared ancestor. It then
 * harvests footer text candidates ONLY from descendants of that root, and reports the
 * scope signals (root/creative/CTA bboxes, whether they share a root, every Library ID
 * inside the root, ad-card-like count, per-candidate geometry/typography/role). All
 * safety decisions are made Node-side in decideFooter, which fails closed (blank
 * headline/description) on any contamination or unverified scope. No OCR, no inference.
 * Inline-only evaluate (anonymous arrows) to avoid the tsx/esbuild __name injection.
 */
type FooterCandidate = { text: string; x: number; y: number; w: number; h: number; fontSize: number; fontWeight: number; tag: string; role: string; insideMedia: boolean; belowCreative: boolean };
type Rect = { x: number; y: number; width: number; height: number };
type FooterHarvest = {
  rootFound: boolean;
  rootBBox: Rect | null;
  creativeBBox: Rect | null;
  ctaBBox: Rect | null;
  ctaText: string;
  creativeAndCtaShareRoot: boolean;
  libraryIds: string[];
  adCardLikeCount: number;
  candidates: FooterCandidate[];
  landingUrl: string;
};

async function extractCardFooterRaw(
  page: Page, media: BBox, adCard: BBox, adId: string,
): Promise<FooterHarvest> {
  const empty: FooterHarvest = { rootFound: false, rootBBox: null, creativeBBox: null, ctaBBox: null, ctaText: '', creativeAndCtaShareRoot: false, libraryIds: [], adCardLikeCount: 0, candidates: [], landingUrl: '' };
  try {
    return await page.evaluate((args) => {
      const media = args.media, card = args.card;
      const blocked = ['facebook.com', 'fb.com', 'fb.me', 'meta.com', 'metastatus.com', 'instagram.com', 'whatsapp.com', 'messenger.com', 'fbcdn.net', 'cdninstagram'];
      const ctaWords = ['shop now', 'learn more', 'book now', 'sign up', 'contact us', 'send message', 'get quote', 'apply now', 'download', 'subscribe', 'order now', 'get offer', 'see menu', 'watch more', 'listen now', 'get directions', 'buy now'];
      const cardMinX = card.x - 4, cardMaxX = card.x + card.width + 4, cardMinY = card.y - 4, cardMaxY = card.y + card.height + 4;
      const mediaBottom = media.y + media.height;

      // 1) creative node via point sampling, climb to nearest video/img
      let creativeNode: Element | null = document.elementFromPoint(media.x + media.width / 2, media.y + media.height / 2);
      let probe: Element | null = creativeNode;
      let hops = 0;
      while (probe && hops < 6) {
        const tn = probe.tagName ? probe.tagName.toLowerCase() : '';
        if (tn === 'video' || tn === 'img') { creativeNode = probe; break; }
        probe = probe.parentElement; hops++;
      }

      // 2) CTA node: nearest CTA-phrase button/link below the creative, inside the card
      let ctaNode: Element | null = null;
      let ctaText = '';
      let ctaBBox: { x: number; y: number; width: number; height: number } | null = null;
      let bestDy = 1e9;
      for (const el of Array.from(document.querySelectorAll('a, button, [role="button"]'))) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        if (cx < cardMinX || cx > cardMaxX || cy < cardMinY || cy > cardMaxY) continue;
        if (cy < mediaBottom - 2) continue;
        let txt = '';
        for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) txt += n.textContent || '';
        txt = txt.replace(/\s+/g, ' ').trim();
        if (!txt) txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const low = txt.toLowerCase();
        let isCta = false;
        for (const w of ctaWords) if (low === w) { isCta = true; break; }
        if (!isCta) continue;
        const dy = cy - mediaBottom;
        if (dy < bestDy) { bestDy = dy; ctaNode = el; ctaText = txt; ctaBBox = { x: r.x, y: r.y, width: r.width, height: r.height }; }
      }

      // 3) nearest shared ancestor of creative + CTA
      let root: Element | null = null;
      let shareRoot = false;
      if (creativeNode && ctaNode) {
        const anc = new Set<Element>();
        let n: Element | null = creativeNode;
        while (n) { anc.add(n); n = n.parentElement; }
        let m: Element | null = ctaNode;
        while (m) { if (anc.has(m)) { root = m; break; } m = m.parentElement; }
        shareRoot = !!root;
      }

      // landing URL: nearest non-blocked external anchor inside the card
      let landingUrl = '';
      for (const el of Array.from(document.querySelectorAll('a'))) {
        if (landingUrl) break;
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        if (cx < cardMinX || cx > cardMaxX || cy < cardMinY || cy > cardMaxY) continue;
        const href = el.getAttribute('href') || '';
        let target = href;
        const um = href.match(/[?&]u=([^&]+)/);
        if (um) { try { target = decodeURIComponent(um[1]!); } catch (e) { /* keep */ } }
        if (/^https?:\/\//.test(target)) {
          let isB = false;
          for (const d of blocked) if (target.toLowerCase().includes(d)) { isB = true; break; }
          if (!isB) landingUrl = target;
        }
      }

      const creativeBBox = creativeNode ? (function () { const r = creativeNode!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() : null;
      if (!root) {
        return { rootFound: false, rootBBox: null, creativeBBox, ctaBBox, ctaText, creativeAndCtaShareRoot: shareRoot, libraryIds: [], adCardLikeCount: 0, candidates: [], landingUrl };
      }
      const rr = root.getBoundingClientRect();
      const rootBBox = { x: rr.x, y: rr.y, width: rr.width, height: rr.height };

      // Library IDs inside the verified root
      const rootText = (root.textContent || '');
      const idMatches = rootText.match(/Library ID:\s*(\d+)/g) || [];
      const libraryIds: string[] = [];
      for (const m of idMatches) { const d = m.replace(/\D/g, ''); if (d) libraryIds.push(d); }

      // ad-card-like count: number of sizeable creative media nodes inside the root
      let adCardLikeCount = 0;
      for (const el of Array.from(root.querySelectorAll('video, img'))) {
        const r = el.getBoundingClientRect();
        const src = ((el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || '').toLowerCase();
        if (r.width >= 120 && r.height >= 120 && (src.includes('scontent') || src.includes('fbcdn') || el.tagName.toLowerCase() === 'video')) adCardLikeCount++;
      }

      // footer text candidates: descendants of the verified root only
      const candidates: { text: string; x: number; y: number; w: number; h: number; fontSize: number; fontWeight: number; tag: string; role: string; insideMedia: boolean; belowCreative: boolean }[] = [];
      const seenTxt = new Set<string>();
      for (const el of Array.from(root.querySelectorAll('a, span, div, button, [role="button"]'))) {
        if (candidates.length >= 80) break;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        let direct = '';
        for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) direct += n.textContent || '';
        direct = direct.replace(/\s+/g, ' ').trim();
        if (!direct || direct.length > 200) continue;
        const key = direct.toLowerCase() + '@' + Math.round(r.y);
        if (seenTxt.has(key)) continue;
        seenTxt.add(key);
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        const insideMedia = cx >= media.x && cx <= media.x + media.width && cy >= media.y && cy <= mediaBottom - 2;
        const belowCreative = cy >= mediaBottom - 2;
        const cs = window.getComputedStyle(el as Element);
        const fontSize = parseFloat(cs.fontSize) || 0;
        const fwRaw = cs.fontWeight;
        const fontWeight = parseInt(fwRaw, 10) || (fwRaw === 'bold' ? 700 : 400);
        candidates.push({ text: direct, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), fontSize, fontWeight, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', insideMedia, belowCreative });
      }

      return { rootFound: true, rootBBox, creativeBBox, ctaBBox, ctaText, creativeAndCtaShareRoot: shareRoot, libraryIds, adCardLikeCount, candidates, landingUrl };
    }, { media, card: adCard, adId });
  } catch {
    return empty;
  }
}

// Domain / display-URL text (e.g. "WWW.CASTLERY.COM", "castlery.com").
function isDomainText(s: string | null | undefined): boolean {
  const t = (s ?? '').trim().toLowerCase();
  return /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com\.sg|com|sg|net|org)\/?$/.test(t);
}

// Exact CTA-button phrase, reusing the quality-gate CTA list.
function isCtaPhrase(s: string | null | undefined): boolean {
  const t = (s ?? '').trim().toLowerCase();
  return CTA_PHRASES.indexOf(t) >= 0;
}

// Meta chrome / status text that must never be footer headline or description.
function isChromeText(s: string | null | undefined): boolean {
  const t = (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return true;
  if (t === '​') return true;
  const set = new Set(['active', 'inactive', 'platforms', 'open drop-down', 'open drop down', 'open drop-down menu', 'see ad details', 'see summary', 'see summary details', 'close', 'sponsored', 'see more', 'see less', 'why am i seeing this ad', 'about this advertiser']);
  if (set.has(t)) return true;
  if (/^library id\b/.test(t)) return true;
  if (/^started running\b/.test(t)) return true;
  return false;
}

function hostFromUrl(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function bboxInside(inner: Rect | null, outer: BBox | Rect | null, tol: number): boolean {
  if (!inner || !outer) return false;
  return inner.x >= outer.x - tol && inner.y >= outer.y - tol &&
    (inner.x + inner.width) <= (outer.x + outer.width) + tol &&
    (inner.y + inner.height) <= (outer.y + outer.height) + tol;
}

function bbStr(b: Rect | BBox | null): string {
  if (!b) return '(none)';
  return `${Math.round(b.width)}x${Math.round(b.height)}@(${Math.round(b.x)},${Math.round(b.y)})`;
}

type CardMeta = { headline: string; description: string; cta: string; displayUrl: string; landingUrl: string; candidates: number; rejectedUi: string[]; reason: string };

/**
 * Decide the footer fields from a harvest, FAIL-CLOSED. Allowed strategies:
 *   structured-footer       — verified root + a recognisable display-URL/link-preview anchor
 *   scoped-geometry-footer  — verified root, geometry used only within that root
 *   no-safe-footer          — root verification failed or contamination detected → blank
 * CTA / display URL / landing URL are kept (they are individually card-scoped); only the
 * headline/description are blanked on failure. No unscoped geometry is ever used.
 */
function decideFooter(
  h: FooterHarvest, adId: string, adCard: BBox | null,
): CardMeta & { found: boolean; strategy: string; contamination: string } {
  const landing = h.landingUrl || '';
  const distinctIds = Array.from(new Set((h.libraryIds || []).map((x) => x.replace(/\D/g, '')).filter(Boolean)));
  const foreignIds = distinctIds.filter((id) => id !== adId);

  const safeBlank = (strategy: string, contamination: string): CardMeta & { found: boolean; strategy: string; contamination: string } => ({
    headline: '', description: '',
    cta: (h.ctaText || '').trim(),
    displayUrl: landing ? hostFromUrl(landing) : '',
    landingUrl: landing,
    candidates: (h.candidates || []).length, rejectedUi: [],
    reason: contamination, found: false, strategy, contamination,
  });

  // ── Root verification (fail closed) ──
  if (!adCard) return safeBlank('no-safe-footer', 'unverified footer scope (no ad-card bounds)');
  if (!h.rootFound || !h.creativeAndCtaShareRoot || !h.rootBBox) return safeBlank('no-safe-footer', 'unverified footer scope');
  if (!bboxInside(h.rootBBox, adCard, 8)) return safeBlank('no-safe-footer', 'unverified footer scope (root exceeds ad-card bounds)');

  // ── Contamination tripwires ──
  if (distinctIds.length > 1) return safeBlank('no-safe-footer', 'cross-card contamination (multiple Library IDs)');
  if (foreignIds.length > 0) return safeBlank('no-safe-footer', 'cross-card contamination (foreign Library ID)');
  if ((h.adCardLikeCount || 0) > 1) return safeBlank('no-safe-footer', 'cross-card contamination (multiple ad-card structures)');

  const cand = h.candidates || [];
  const outside = cand.filter((c) => !bboxInside({ x: c.x, y: c.y, width: c.w, height: c.h }, h.rootBBox!, 6));
  if (outside.length > 0) return safeBlank('no-safe-footer', 'footer candidates outside verified root');

  // ── In-root content selection (verified, no contamination) ──
  const below = cand.filter((c) => !c.insideMedia && c.belowCreative);
  const sorted = below.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const seen = new Set<string>();
  const uniq: FooterCandidate[] = [];
  for (const it of sorted) { const k = it.text.trim().toLowerCase(); if (!k || seen.has(k)) continue; seen.add(k); uniq.push(it); }

  let displayUrl = '';
  let domainInFooter = false;
  let cta = (h.ctaText || '').trim();
  const content: FooterCandidate[] = [];
  for (const it of uniq) {
    const t = it.text.trim(); const low = t.toLowerCase();
    if (isChromeText(t)) continue;
    if (isDurationText(t)) continue;
    if (!displayUrl && isDomainText(t)) { displayUrl = t; domainInFooter = true; continue; }
    if (isDomainText(t)) continue;
    if (!cta && isCtaPhrase(low)) { cta = t; continue; }
    if (isCtaPhrase(low)) continue;
    if (/^\d+$/.test(t)) continue;
    if (t.length < 3 || t.length > 200) continue;
    content.push(it);
  }
  if (!displayUrl && landing) displayUrl = hostFromUrl(landing);

  const ordered = content.slice();
  if (ordered.length >= 2 && ordered[0]!.y === ordered[1]!.y) {
    const a = ordered[0]!, c = ordered[1]!;
    if ((c.fontSize * 1000 + c.fontWeight) > (a.fontSize * 1000 + a.fontWeight)) { ordered[0] = c; ordered[1] = a; }
  }
  const headline = ordered[0] ? ordered[0].text.trim() : '';
  const description = (ordered[1] && ordered[1].text.trim() !== headline) ? ordered[1].text.trim() : '';
  const strategy = domainInFooter ? 'structured-footer' : 'scoped-geometry-footer';
  const found = !!(displayUrl || cta || content.length);
  const reason = `${strategy} (verified ad-card root)`;
  return { headline, description, cta, displayUrl, landingUrl: landing, candidates: uniq.length, rejectedUi: [], reason, found, strategy, contamination: '' };
}

/**
 * Collect every "Library ID: <n>" within the ad-card bounds. Proves the verified footer
 * belongs to the EXACT ad (own id present, no other). Inline-only evaluate.
 */
async function collectAdCardLibraryIds(page: Page, card: BBox): Promise<string[]> {
  try {
    return await page.evaluate((c) => {
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const el of Array.from(document.querySelectorAll('span, div, a'))) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        if (cx < c.x - 4 || cx > c.x + c.width + 4 || cy < c.y - 4 || cy > c.y + c.height + 4) continue;
        let t = '';
        for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) t += n.textContent || '';
        const m = t.match(/Library ID:\s*(\d+)/);
        if (m && m[1] && !seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
      }
      return ids;
    }, card);
  } catch {
    return [];
  }
}

// Confirm the ad-card holds the exact own Library ID and no other (foreign → REJECT,
// none → REVIEW). Computed once per ad; shared by static/video and carousel paths.
async function adCardLibraryGate(page: Page): Promise<{ ok: boolean; status: GateDecision; reason: string }> {
  const adCard = captureAdCard;
  const ids = adCard ? await collectAdCardLibraryIds(page, adCard) : [];
  const distinct = Array.from(new Set(ids));
  const foreign = distinct.filter((id) => id !== captureAdId);
  const own = distinct.indexOf(captureAdId) >= 0;
  if (foreign.length > 0 || distinct.length > 1) {
    return { ok: false, status: 'REJECT', reason: `cross-card contamination — ad-card Library IDs: [${distinct.join(', ') || 'none'}] (expected only ${captureAdId})` };
  }
  if (!own) {
    return { ok: false, status: 'REVIEW', reason: `exact Library ID not confirmed inside ad-card — attribution unproven` };
  }
  return { ok: true, status: 'ACCEPT', reason: `ad-card Library ID ${captureAdId} confirmed; no foreign id` };
}

// Run the verified footer engine for one media region and gate each field independently.
async function verifyFooter(page: Page, media: BBox, cardIndex: number): Promise<FooterVerify> {
  const adCard = captureAdCard;
  const harvest = await extractCardFooterRaw(page, media, adCard ?? media, captureAdId);
  const dec = decideFooter(harvest, captureAdId, adCard);
  if (dec.strategy === 'no-safe-footer') {
    const st: GateDecision = /contamination/.test(dec.contamination) ? 'REJECT' : 'REVIEW';
    const reason = dec.contamination || 'unverified footer scope';
    return { cardIndex, strategy: dec.strategy, contamination: dec.contamination, headline: '', headlineStatus: st, headlineReason: reason, description: '', descriptionStatus: st, descriptionReason: reason, cta: dec.cta || '', displayUrl: dec.displayUrl || '', landingUrl: dec.landingUrl || '' };
  }
  const hCls = dec.headline ? classifyMetaText(dec.headline, dec.cta, captureBrand) : { decision: 'REVIEW' as GateDecision, reason: 'no headline in verified footer' };
  const dCls = dec.description ? classifyMetaText(dec.description, dec.cta, captureBrand) : { decision: 'REVIEW' as GateDecision, reason: 'no description in verified footer' };
  return { cardIndex, strategy: dec.strategy, contamination: '', headline: hCls.decision === 'ACCEPT' ? dec.headline : '', headlineStatus: hCls.decision, headlineReason: hCls.reason, description: dCls.decision === 'ACCEPT' ? dec.description : '', descriptionStatus: dCls.decision, descriptionReason: dCls.reason, cta: dec.cta || '', displayUrl: dec.displayUrl || '', landingUrl: dec.landingUrl || '' };
}

// Pure ad-level decision for a single (static/video) footer. When the exact-ad Library ID
// gate fails OR the footer scope is unverified (no-safe-footer), ALL ad-level fields —
// headline, description AND context (cta/display/landing) — are blanked. The ad-level
// verified sidecar never carries context from an unverified footer root.
function decideAdLevelSingle(
  gate: { ok: boolean; status: GateDecision; reason: string }, fv: FooterVerify,
): { hVal: string; hStatus: GateDecision; hReason: string; dVal: string; dStatus: GateDecision; dReason: string; cta: string; displayUrl: string; landingUrl: string; reason: string } {
  if (!gate.ok) {
    return { hVal: '', hStatus: gate.status, hReason: gate.reason, dVal: '', dStatus: gate.status, dReason: gate.reason, cta: '', displayUrl: '', landingUrl: '', reason: `single-footer; ALL ad-level metadata (incl. CTA/display/landing) blanked — exact Library ID unverified: ${gate.reason}` };
  }
  if (fv.strategy === 'no-safe-footer') {
    return { hVal: '', hStatus: fv.headlineStatus, hReason: fv.headlineReason, dVal: '', dStatus: fv.descriptionStatus, dReason: fv.descriptionReason, cta: '', displayUrl: '', landingUrl: '', reason: `single-footer; context blanked — unverified footer scope (${fv.contamination || 'no-safe-footer'})` };
  }
  return { hVal: fv.headlineStatus === 'ACCEPT' ? fv.headline : '', hStatus: fv.headlineStatus, hReason: fv.headlineReason, dVal: fv.descriptionStatus === 'ACCEPT' ? fv.description : '', dStatus: fv.descriptionStatus, dReason: fv.descriptionReason, cta: fv.cta, displayUrl: fv.displayUrl, landingUrl: fv.landingUrl, reason: `single-footer; ${gate.reason}` };
}

// Static-image / video: ONE individually verified footer for the whole ad (per-field).
async function recordVerifiedAdMeta(page: Page, media: BBox, dbg: DebugState): Promise<void> {
  const gate = await adCardLibraryGate(page);
  const fv = await verifyFooter(page, media, 1);
  const r = decideAdLevelSingle(gate, fv);
  pushVerifiedRow(captureAdId, r.hVal, r.hStatus, r.hReason, r.dVal, r.dStatus, r.dReason, r.cta, r.displayUrl, r.landingUrl, fv.strategy, dbg, r.reason);
}

// Carousel: accept an ad-level field ONLY when proven shared across EVERY captured card.
async function recordVerifiedCarouselMeta(page: Page, dbg: DebugState): Promise<void> {
  const gate = await adCardLibraryGate(page);
  const cards = carouselVerifiedResults.slice();
  const h = combineCarouselField(cards, 'headline', gate);
  const d = combineCarouselField(cards, 'description', gate);
  const ctx = combineCarouselContext(cards, gate);
  const strategy = cards.length ? `carousel-x${cards.length}(${cards[0]!.strategy})` : 'carousel(no-cards)';
  const reason = `carousel; captured ${cards.length} card(s)${ctx.note ? `; ${ctx.note}` : ''}; ${gate.reason}`;
  pushVerifiedRow(captureAdId, h.value, h.status, h.reason, d.value, d.status, d.reason, ctx.cta, ctx.displayUrl, ctx.landingUrl, strategy, dbg, reason);
}

/** Extract + record one card/frame metadata row to the sidecar accumulator (no DB). */
async function recordCard(page: Page, crop: BBox, cardIndex: number, assetFp: string, mediaType: string, dbg: DebugState): Promise<void> {
  const label = mediaType === 'VIDEO_FRAME' ? 'frame-01' : mediaType === 'CREATIVE_IMAGE' ? 'image-01' : `card-${String(cardIndex).padStart(2, '0')}`;
  let meta: CardMeta;
  let strategy = 'legacy-fallback';
  if (mediaType === 'VIDEO_FRAME' || mediaType === 'CREATIVE_IMAGE') {
    const adCard = captureAdCard ?? crop;
    const h = await extractCardFooterRaw(page, crop, adCard, captureAdId);
    const dec = decideFooter(h, captureAdId, captureAdCard);
    strategy = dec.strategy;
    meta = dec;
    // ── Debug: full root + scope + candidate diagnostics ──
    dbg.notes.push(`footer ${label} strategy=${dec.strategy}  contamination=${dec.contamination || 'none'}`);
    dbg.notes.push(`footer ${label} bbox root=${bbStr(h.rootBBox)} creative=${bbStr(h.creativeBBox)} cta=${bbStr(h.ctaBBox)} adCard=${bbStr(captureAdCard)}`);
    dbg.notes.push(`footer ${label} creative&CTA share root=${h.creativeAndCtaShareRoot}  libraryIds=[${(h.libraryIds || []).join(', ') || 'none'}]  adCardLike=${h.adCardLikeCount}`);
    dbg.notes.push(`footer ${label} candidates in-root: ${(h.candidates || []).length}`);
    for (const c of (h.candidates || [])) {
      dbg.notes.push(`footer-cand ${label}: "${c.text.slice(0, 50)}" x=${c.x} y=${c.y} w=${c.w} h=${c.h} ${Math.round(c.fontSize)}px/${c.fontWeight} <${c.tag}${c.role ? ' role=' + c.role : ''}> inMedia=${c.insideMedia} below=${c.belowCreative}`);
    }
    dbg.notes.push(`footer ${label} selected -> headline=${dec.headline ? '"' + dec.headline + '"' : '(blank)'} | description=${dec.description ? '"' + dec.description + '"' : '(blank)'} | cta=${dec.cta || '(blank)'} | displayUrl=${dec.displayUrl || '(blank)'} | landingUrl=${dec.landingUrl || '(blank)'}`);
    dbg.notes.push(`footer ${label} contamination verdict: ${dec.contamination || 'clean'}`);
    // ── Audit the blanked footer fields when scope is unverified / contaminated ──
    if (dec.strategy === 'no-safe-footer') {
      const decision: GateDecision = /contamination/.test(dec.contamination) ? 'REJECT' : 'REVIEW';
      for (const fld of ['headline', 'description']) {
        auditRows.push({ ad_id: captureAdId, card_index: cardIndex, media_type: mediaType, field: fld, raw_value: '(footer scope unverified)', decision, reason: dec.contamination, stored_value: '', strategy: dec.strategy });
      }
    }
  } else {
    meta = await extractCardMeta(page, crop);
    strategy = 'carousel-column';
    // Ad-level verified-footer evidence for THIS carousel card; combined later across
    // ALL captured cards into one ad-level verified-meta row (never per card).
    carouselVerifiedResults.push(await verifyFooter(page, crop, cardIndex));
  }
  const asset_path = path.relative(process.cwd(), assetFp).replace(/\\/g, '/');
  cardRows.push({
    ad_id: captureAdId, card_index: cardIndex, asset_path, media_type: mediaType,
    headline: meta.headline, description: meta.description, cta: meta.cta, display_url: meta.displayUrl, landing_url: meta.landingUrl,
    brand: captureBrand, strategy,
  });
  dbg.notes.push(`card-meta ${label} strategy: ${strategy}`);
  dbg.notes.push(`card-meta ${label} candidates: ${meta.candidates}`);
  if (meta.rejectedUi.length) dbg.notes.push(`card-meta ${label} rejected UI text: ${meta.rejectedUi.map((t) => '"' + t + '"').join(', ')}`);
  dbg.notes.push(`card-meta ${label} selected headline: ${meta.headline ? '"' + meta.headline + '"' : '(blank)'}`);
  dbg.notes.push(`card-meta ${label} selected description: ${meta.description ? '"' + meta.description + '"' : '(blank)'}`);
  dbg.notes.push(`card-meta ${label} selected CTA: ${meta.cta || '(blank)'}`);
  dbg.notes.push(`card-meta ${label} selected landingUrl: ${meta.landingUrl || '(blank)'}`);
  dbg.notes.push(`card-meta ${label} confidence reason: ${meta.reason}`);
}

/**
 * Screenshot every currently-visible card and save those that are visually distinct
 * (perceptual visualDiffRatio) from ALL already-saved cards. Returns how many new
 * cards were saved. Never saves a visual duplicate.
 */
async function saveNewVisibleCards(
  page: Page, creativeBBox: BBox, outDir: string, tmp: string,
  files: string[], savedBufs: Buffer[], seenSrc: Set<string>, dbg: DebugState, phase: string,
): Promise<number> {
  const { cards, notes } = await findVisibleCards(page, creativeBBox);
  for (const ln of notes) dbg.notes.push(`${phase}: ${ln}`);
  dbg.notes.push(`${phase}: ${cards.length} visible card candidate(s)`);
  let saved = 0;
  for (const card of cards) {
    const knownSrc = !!(card.id.src && seenSrc.has(card.id.src));
    await screenshotCreative(page, card.crop, tmp);
    const candBuf = fs.readFileSync(tmp);
    let minDiff = 1; let closest = 0;
    for (let k = 0; k < savedBufs.length; k++) {
      const dRatio = await visualDiffRatio(page, savedBufs[k]!, candBuf);
      if (dRatio < minDiff) { minDiff = dRatio; closest = k + 1; }
    }
    const isFirst = savedBufs.length === 0;
    const accept = (isFirst || minDiff >= VISUAL_DIFF_MIN) && !knownSrc;
    dbg.notes.push(
      `${phase}: candidate at (${Math.round(card.id.x)},${Math.round(card.id.y)}) src=${srcSnip(card.id.src)} ` +
      `visualDiffRatio=${isFirst ? 'n/a(first)' : minDiff.toFixed(3)}${closest ? ` (vs card-${String(closest).padStart(2, '0')})` : ''} ` +
      `knownSrc=${knownSrc ? 'yes' : 'no'} -> ${accept ? 'SAVED visible card' : 'REJECTED visible duplicate (visualDiffRatio too low)'}`,
    );
    if (!accept) continue;
    const lbl = String(files.length + 1).padStart(2, '0');
    const fp = path.join(outDir, `card-${lbl}.png`);
    fs.renameSync(tmp, fp);
    files.push(fp);
    savedBufs.push(fs.readFileSync(fp));
    if (card.id.src) seenSrc.add(card.id.src);
    dbg.notes.push(`${phase}: card-${lbl}: DECISION = SAVED visible card (crop ${Math.round(card.crop.width)}x${Math.round(card.crop.height)})`);
    console.log(`       card-${lbl}: saved`);
    await recordCard(page, card.crop, files.length, fp, 'CAROUSEL_CARD', dbg);
    saved++;
  }
  return saved;
}

async function captureCarousel(
  page: Page, outDir: string, creativeBBox: BBox, dbg: DebugState,
): Promise<string[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  const savedBufs: Buffer[] = [];
  const seenSrc = new Set<string>();
  const tmp = path.join(outDir, '.tmp-card.png');

  dbg.notes.push(`carousel viewport: ${Math.round(creativeBBox.width)}x${Math.round(creativeBBox.height)} at (${Math.round(creativeBBox.x)},${Math.round(creativeBBox.y)})`);

  // ── Phase 1: capture ALL currently-visible distinct cards (left→right) ──
  await page.waitForTimeout(600);
  const firstPass = await saveNewVisibleCards(page, creativeBBox, outDir, tmp, files, savedBufs, seenSrc, dbg, 'initial');
  dbg.notes.push(`initial visible-card pass saved ${firstPass} card(s)`);

  // Fallback: no visible-card candidate detectable → save the central card once.
  if (files.length === 0) {
    const c1 = await findCentralCard(page, creativeBBox);
    for (const ln of c1.notes) dbg.notes.push(`card-01 ${ln}`);
    const crop1 = c1.bbox ?? creativeBBox;
    const first = path.join(outDir, 'card-01.png');
    await screenshotCreative(page, crop1, first);
    files.push(first);
    savedBufs.push(fs.readFileSync(first));
    if (c1.identity?.src) seenSrc.add(c1.identity.src);
    dbg.notes.push(`card-01: DECISION = SAVED central card (no visible-card candidates; crop ${Math.round(crop1.width)}x${Math.round(crop1.height)})`);
    console.log('       card-01: saved');
    await recordCard(page, crop1, 1, first, 'CAROUSEL_CARD', dbg);
  }

  // ── Phase 2: try movement methods; after each, save any NEW distinct visible cards ──
  const methods = ['next-button', 'mouse-right-edge', 'arrow-right', 'wheel', 'swipe'];
  for (let round = 0; round < CAROUSEL_MAX && files.length < CAROUSEL_MAX; round++) {
    let savedThisRound = 0;
    for (const m of methods) {
      let used = m;
      if (m === 'next-button') used = await clickNextControl(page, creativeBBox);
      else if (m === 'mouse-right-edge') await moveMouseRightEdge(page, creativeBBox);
      else if (m === 'arrow-right') await pressArrowRightOnCarousel(page, creativeBBox);
      else if (m === 'wheel') await wheelCarousel(page, creativeBBox);
      else if (m === 'swipe') await swipeCarousel(page, creativeBBox);
      dbg.carouselNextBtn = used;
      await page.waitForTimeout(700);
      const n = await saveNewVisibleCards(page, creativeBBox, outDir, tmp, files, savedBufs, seenSrc, dbg, `after-${used}`);
      if (n > 0) { savedThisRound += n; break; } // new card(s) revealed — start a fresh movement round
    }
    if (savedThisRound === 0) {
      dbg.notes.push(`movement round ${round + 1}: NO MOVEMENT — no new distinct cards after all methods`);
      break;
    }
  }

  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best-effort */ }

  if (!dbg.stopReason) {
    dbg.stopReason = files.length <= 1
      ? 'only card-01 captured — no further distinct cards found'
      : `END REACHED — ${files.length} distinct card(s) captured`;
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

  // ── Verified-meta safety: never clobber existing valid metadata on a rerun ──
  // 1) Abort on duplicate READY ad_id in the source CSV (would create a sidecar that
  //    preview/ingest later invalidate).
  const dupReady = duplicateReadyAdIds(rows);
  if (dupReady.length > 0) {
    console.error(`\n❌ Duplicate READY ad_id(s) in source CSV: ${dupReady.join(', ')}`);
    console.error('   Refusing to capture — split/clean the CSV so each ad_id is unique before re-running.');
    process.exit(1);
  }
  // 2) Load and strictly validate any existing verified sidecar; seed the merge map.
  const verifiedFilePath = verifiedMetaPath(inputFile);
  const existingVerified = loadExistingVerifiedRows(verifiedFilePath);
  if (existingVerified.status === 'unreadable' || existingVerified.status === 'malformed' || existingVerified.status === 'duplicates') {
    console.error(`\n❌ Existing verified sidecar is ${existingVerified.status}: ${existingVerified.message}`);
    console.error(`   ${verifiedFilePath}`);
    console.error('   Refusing to capture so the existing file is NOT overwritten. Repair it, or delete it to deliberately regenerate.');
    process.exit(1);
  }
  for (const [k, v] of existingVerified.map) verifiedMetaMap.set(k, v);
  console.log(`  Verified sidecar: ${existingVerified.status.toUpperCase()} — ${existingVerified.message} (preserved + merged)`);

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

    // Test-only: process only the requested ad_id (BROWSER_ONLY_AD_ID).
    if (ONLY_AD_ID && adId !== ONLY_AD_ID) { skipped++; continue; }

    // H.3b: tag any sidecar card rows recorded during this ad with its ad_id.
    captureAdId = adId;
    captureBrand = name;   // advertiser/brand identity for the source-aware quality gate

    console.log(`\n  Row ${rowNum} [${adId}] ${mt}`);
    console.log(`  URL: ${url}`);

    if (!url) {
      console.log('    ❌ ad_library_url is blank — skipping');
      failed++;
      continue;
    }

    if (row.creative_asset_path?.trim() && !FORCE_RECAPTURE) {
      console.log(`    ↳ Already populated: ${row.creative_asset_path.trim()}`);
      captured++;
      continue;
    }

    const outDir  = assetDir(name, adId);
    if (FORCE_RECAPTURE) {
      // Recapture into the SAME folder: remove only this script's generated files.
      cleanGeneratedAssets(outDir);
      console.log(`    ↻ FORCE_RECAPTURE — cleaned old generated files, recapturing into ${path.relative(process.cwd(), outDir).replace(/\\/g, '/')}`);
    }
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
      captureAdCard = adCardBBox;   // verified ad-card root bounds for the footer engine
      carouselVerifiedResults.length = 0;   // reset per-ad carousel verified-footer evidence

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

      // Per-card footer metadata (no DB). Carousel cards are recorded inside
      // captureCarousel. Video -> one VIDEO_FRAME row; static image -> one
      // CREATIVE_IMAGE row, both via the layout-aware footer engine.
      if (mt === 'IMAGE') {
        await recordCard(page, creativeBBox, 1, savedFiles[0]!, 'CREATIVE_IMAGE', dbg);
      } else if (mt !== 'CAROUSEL') {
        await recordCard(page, creativeBBox, 1, savedFiles[0]!, 'VIDEO_FRAME', dbg);
      }

      // Ad-level VERIFIED metadata (separate sidecar). One proven row per ad. Carousel
      // requires the SAME verified footer proven across every captured card; static/video
      // use one individually verified footer.
      if (mt === 'CAROUSEL') {
        await recordVerifiedCarouselMeta(page, dbg);
      } else {
        await recordVerifiedAdMeta(page, creativeBBox, dbg);
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

  // H.3b: write per-card metadata sidecar (CSV only — NO DB writes). First blank
  // any metadata repeated across visually-distinct cards, to avoid false attribution.
  // H.3f.1: snapshot raw captured metadata BEFORE any blanking, for the quality-gate audit.
  const rawMeta = cardRows.map((r) => ({ headline: r.headline, description: r.description }));
  dedupeSharedCardMeta(cardRows);
  sanitizeVideoFrameMeta(cardRows);
  applyMetadataQualityGate(cardRows, rawMeta);
  const cardsFile = cardsCsvPath(inputFile);
  fs.writeFileSync(cardsFile, serializeCardsCsv(cardRows), 'utf-8');
  const auditFile = auditCsvPath(inputFile);
  fs.writeFileSync(auditFile, serializeAuditCsv(auditRows), 'utf-8');
  const verifiedFile = verifiedMetaPath(inputFile);
  const verifiedAll = Array.from(verifiedMetaMap.values());
  fs.writeFileSync(verifiedFile, serializeVerifiedMetaCsv(verifiedAll), 'utf-8');

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
  console.log(`  Cards CSV:        ${cardsFile} (${cardRows.length} card row(s))`);
  console.log(`  Cards audit:      ${auditFile} (${auditRows.length} field decision(s))`);
  console.log(`  Verified meta:    ${verifiedFile} (${verifiedAll.length} ad row(s) merged, ${verifiedAll.filter((r) => r.verification_status === 'ACCEPT').length} ACCEPT)`);
  printCoverageReport(cardRows, auditRows);
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
