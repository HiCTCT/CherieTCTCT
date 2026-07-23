/**
 * Review-candidate persistence contract (Phase 2, Checkpoint 2.2B) — PURE
 *
 * The dependency-light contract that a persisted `ReviewCandidate` row is bound by:
 * a canonical identity key, the promotion status/outcome vocabularies, the verified-
 * metadata disposition vocabulary, and ONE schema-versioned promotion-payload
 * envelope with deterministic hashing, validation and completeness derivation.
 *
 * STRUCTURAL GUARANTEES — enforced by the import list, not by comments:
 *   - No Prisma, no `@prisma/client`, no database, no ingestion script, no API route,
 *     no query, no analyser, no scorer, no Anthropic, no Playwright, no capture code.
 *   - The ONLY imports are `node:crypto` and TYPE/const references to the existing
 *     Ad/AdAnalysis write contract (`browserIngestBundleMapping`), which is itself a
 *     pure module. Nothing here reads or writes anything; every function is pure.
 *
 * DESIGN INVARIANTS (do NOT weaken):
 *   - Collection source is provenance, never identity. Both `meta_api` and
 *     `browser_collected` observations of the same Meta ad produce ONE `candidateKey`.
 *   - Completeness is DERIVED by validating the stored payload; there is no trusted
 *     free-standing `hasCompleteAnalysis`/`payloadStatus` boolean.
 *   - Immutable Ad content EXCLUDES the three transaction-bound relational ids
 *     (competitorId/clientId/industryId) and the two lifecycle fields
 *     (reviewStatus/qualified). Those are bound only at promotion.
 *   - Copy-honesty is PER FIELD: a headline/description may be non-null ONLY when that
 *     field's own verified status is ACCEPT. An accepted field is never erased because
 *     the other is under REVIEW; NONE/REVIEW authorise neither.
 *   - qualification_recommendation is copied verbatim from the validated frozen
 *     mapping (IngestPayload.ad.qualified); it is NEVER re-derived from a score here.
 */

import { createHash } from 'node:crypto';
import type { AdWritePayload, AdAnalysisWritePayload } from './browserIngestBundleMapping';
import { REQUIRED_AD_ANALYSIS_FIELDS } from './browserIngestBundleMapping';
// Phase 1 analysis invariants, reused so the payload cannot diverge from them.
import { ANALYSIS_IMPROVEMENT_ENTRIES } from './benchmarkContract';

/** Upper bound on an analysis string list — mirrors Phase 1's MAX_LIST_ITEMS. */
const MAX_ANALYSIS_LIST_ITEMS = 50;

// ─── Promotion status & outcome vocabularies ──────────────────────────────────
// There is deliberately NO persisted in-flight ("PROMOTING") state — the promotion
// is one atomic transaction, so a durable in-flight claim would need a two-phase
// recovery design this first version does not require.
export const PROMOTION_STATUSES = ['NOT_PROMOTED', 'PROMOTED', 'FAILED'] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

export const PROMOTION_OUTCOMES = ['SUCCESS', 'ALREADY_EXISTS', 'FAILED'] as const;
export type PromotionOutcome = (typeof PROMOTION_OUTCOMES)[number];

// ─── Verified-metadata (per-field) ────────────────────────────────────────────
// Grounded in the current loader (`loadVerifiedMetaSidecar`), which carries per-field
// `headline_status`/`description_status` (uppercased) plus a row-level
// `verification_status`, and the mapping's `acceptedOnly`: a field's copy is
// authorised ONLY when its own status is exactly `ACCEPT`. There is NO distinct
// REJECTED status in the code, so these vocabularies omit it. Checkpoint 1's sidecar
// row for `3831676167136939` was REVIEW — represented truthfully, never as NONE.
//
// Authorisation is PER FIELD: an ACCEPTED headline is never erased because the
// description is under REVIEW, and vice versa.
export const VERIFIED_META_DISPOSITIONS = ['NONE', 'ACCEPTED', 'REVIEW'] as const;
export type VerifiedMetaDisposition = (typeof VERIFIED_META_DISPOSITIONS)[number];

/** Per-field verification status as the loader records it (`ACCEPT` authorises copy). */
export const VERIFIED_FIELD_STATUSES = ['NONE', 'ACCEPT', 'REVIEW'] as const;
export type VerifiedFieldStatus = (typeof VERIFIED_FIELD_STATUSES)[number];

export type VerifiedMetadata = {
  disposition: VerifiedMetaDisposition;
  headline_status: VerifiedFieldStatus;
  description_status: VerifiedFieldStatus;
};

export const VISUAL_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type VisualConfidence = (typeof VISUAL_CONFIDENCES)[number];

/** The single supported promotion-payload schema version. */
export const PROMOTION_PAYLOAD_SCHEMA_VERSION = 1;

// ─── Ad-content boundary ──────────────────────────────────────────────────────
// Immutable Ad content = AdWritePayload MINUS the transaction-bound relational ids
// and the lifecycle fields. Dates are exact ISO strings (no Date objects in JSON).
export const AD_CONTENT_KEYS = [
  'productOrService', 'adFormat', 'adLink', 'activeSince', 'primaryCopy', 'headline',
  'description', 'metaAdId', 'adSource', 'score', 'firstSeenAt', 'lastSeenAt',
  'lastSeenActiveAt', 'adStatus', 'capturedAssetPath', 'capturedAssetType',
  'competitorBenchmarkScore', 'benchmarkTier', 'benchmarkConfidence', 'evidenceSource',
  'creativeSource', 'benchmarkScoredAt',
] as const;

/** Keys that must NEVER appear inside immutable Ad content — bound at promotion instead. */
export const FORBIDDEN_AD_CONTENT_KEYS = [
  'competitorId', 'clientId', 'industryId', 'reviewStatus', 'qualified',
] as const;

/** Ad-content date keys that must be exact ISO strings (activeSince may also be null). */
const AD_CONTENT_DATE_KEYS = [
  'activeSince', 'firstSeenAt', 'lastSeenAt', 'lastSeenActiveAt', 'benchmarkScoredAt',
] as const;
const AD_CONTENT_NULLABLE_DATE_KEYS = new Set<string>(['activeSince']);

// ─── JSON-safe payload types ──────────────────────────────────────────────────
// AdContentJson is AdWritePayload with the excluded keys removed and every Date
// represented as an exact ISO string. Compile-time drift guard below.
//
// TIMESTAMP SEMANTICS (locked):
//   - `firstSeenAt` / `lastSeenAt` / `lastSeenActiveAt` / `activeSince` /
//     `benchmarkScoredAt` are VALIDATED OBSERVATION times captured when the candidate
//     was created. Promotion writes them VERBATIM — it does NOT rebind them to
//     promotion time.
//   - The actual final promotion INSERT time is recorded by the database itself via
//     `Ad.createdAt @default(now())` — never carried in this payload.
//   - Promotion recomputes NO timestamp except its own transaction/audit fields
//     (e.g. `ReviewCandidate.lastPromotionAttemptAt`).
type IsoString = string;

export type AdContentJson =
  Omit<AdWritePayload, (typeof FORBIDDEN_AD_CONTENT_KEYS)[number]
    | 'activeSince' | 'firstSeenAt' | 'lastSeenAt' | 'lastSeenActiveAt' | 'benchmarkScoredAt'>
  & {
    activeSince: IsoString | null;
    firstSeenAt: IsoString;
    lastSeenAt: IsoString;
    lastSeenActiveAt: IsoString;
    benchmarkScoredAt: IsoString;
  };

/** AdAnalysisWritePayload carries no Date fields, so its JSON form is identical. */
export type AdAnalysisJson = AdAnalysisWritePayload;

export type PromotionProvenance = {
  bundle_schema_version: number | null;
  bundle_sha256: string | null;
  source_csv_sha256: string | null;
  source_row_number: number | null;
  bundle_row_ad_id: string | null;
  media_type: string | null;
  /** Evidence only — never used as identity. */
  creative_asset_path: string | null;
  creative_asset_sha256: string | null;
  copy_sha256: string | null;
  prompt_version: string | null;
  planner_version: string | null;
  analysis_model: string | null;
  bundle_created_at: IsoString | null;
};

export type PromotionPayloadV1 = {
  payload_schema_version: 1;
  candidate_key: string;
  platform: string;
  external_ad_id: string | null;
  /**
   * Durable advertiser scope for the fallback identity: a platform advertiser/page id
   * when available (e.g. Meta page id), else the internal competitor id. Always stored
   * so the fallback candidate_key can be recomputed; unused in the key for Meta-id'd ads.
   */
  advertiser_identity: string;
  expected_competitor_id: string;
  first_collection_source: string;
  verified_metadata: VerifiedMetadata;
  creative_source: string;
  captured_asset_type: string | null;
  visual_confidence: VisualConfidence | null;
  /** Score-based qualification recommendation; bound to Ad.qualified at promotion. */
  qualification_recommendation: boolean;
  ad_content: AdContentJson;
  ad_analysis: AdAnalysisJson;
  provenance: PromotionProvenance;
  created_at: IsoString;
};

const PROVENANCE_KEYS = [
  'bundle_schema_version', 'bundle_sha256', 'source_csv_sha256', 'source_row_number',
  'bundle_row_ad_id', 'media_type', 'creative_asset_path', 'creative_asset_sha256',
  'copy_sha256', 'prompt_version', 'planner_version', 'analysis_model', 'bundle_created_at',
] as const;

// ─── Primitive helpers ────────────────────────────────────────────────────────

const SHA256_RE = /^[a-f0-9]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isSha256(v: unknown): v is string {
  return typeof v === 'string' && SHA256_RE.test(v);
}
function isExactIso(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_RE.test(v)) return false;
  const t = Date.parse(v);
  return !Number.isNaN(t) && new Date(t).toISOString() === v;
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deterministic canonical JSON: object keys sorted recursively, arrays kept in order,
 * `undefined` dropped, and Date/function/bigint/symbol/non-finite rejected so the
 * serialisation (and therefore the hash) can never depend on key order or hide a Date.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}
function canonicalise(v: unknown): unknown {
  if (v === null) return null;
  if (v instanceof Date) {
    throw new Error('canonicalJson: Date objects are not allowed — serialise as exact ISO strings');
  }
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'number') {
    if (!Number.isFinite(v as number)) throw new Error('canonicalJson: non-finite number');
    return v;
  }
  if (Array.isArray(v)) return v.map(canonicalise);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const val = v[k];
      if (val === undefined) continue;
      out[k] = canonicalise(val);
    }
    return out;
  }
  throw new Error(`canonicalJson: unsupported value type ${t}`);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Hash over the canonical serialisation of the whole envelope. */
export function computePayloadSha256(payload: PromotionPayloadV1): string {
  return sha256Hex(canonicalJson(payload));
}

// ─── Canonical candidate-key builder ──────────────────────────────────────────

export type CandidateKeyInput = {
  platform: string;
  externalAdId?: string | null;
  fallback?: {
    /** Advertiser scope: platform advertiser/page id if known, else internal competitor id. */
    advertiserIdentity?: string | null;
    mediaType?: string | null;
    creativeAssetSha256?: string | null;
    copySha256?: string | null;
  };
};

/** Normalise an identity component: trim only. See the case-folding rule below. */
function normaliseIdentityComponent(v: string | null | undefined): string {
  return (v ?? '').trim();
}

/**
 * The SHARED canonical Meta identity key. BOTH initial creation (`buildCandidateKey`)
 * and payload recomputation (`candidateKeyForPayload`) call this one function, so the
 * serialisation is defined in exactly one place.
 *
 * The identity portion is a SHA-256 over a canonical object `{ platform, external_ad_id }`,
 * NEVER delimiter concatenation — so no component can collide by containing the ':'
 * delimiter (e.g. platform `"a:b"` + id `"c"` vs platform `"a"` + id `"b:c"`).
 *
 * NORMALISATION: platform and external_ad_id are TRIMMED (leading/trailing whitespace),
 * then rejected if blank. **No case folding is applied** — the platform contract does
 * not define its values as case-insensitive, so two ids differing only in case are
 * treated as DISTINCT. Collection source, competitor id, advertiser identity, row
 * number, CSV checksum, paths, filenames and timestamps are never part of this key.
 */
export function buildMetaCandidateKey(
  platform: string | null | undefined,
  externalAdId: string | null | undefined,
): string {
  const p = normaliseIdentityComponent(platform);
  const ext = normaliseIdentityComponent(externalAdId);
  if (p === '') throw new Error('candidateKey: platform is required');
  if (ext === '') throw new Error('candidateKey: external ad id is required');
  return `meta:ad:sha256:${sha256Hex(canonicalJson({ platform: p, external_ad_id: ext }))}`;
}

/**
 * Canonical, collection-source- and competitor-INDEPENDENT identity key.
 *   - Meta-identified ad → `buildMetaCandidateKey` → `meta:ad:sha256:<hash>`.
 *   - No external ad id  → `local:${sha256(canonicalJson({ platform, advertiser_identity,
 *     media_type, creative_asset_sha256, copy_sha256 }))}`.
 *
 * The fallback identity is DURABLE ADVERTISER SCOPE + DURABLE CONTENT. `advertiserIdentity`
 * scopes the content to one advertiser so two DIFFERENT advertisers reusing the same
 * creative never collide. Provenance that can differ between exports of the same ad —
 * source CSV checksum, source row number, absolute/relative paths, filenames,
 * timestamps — is deliberately EXCLUDED, so re-exporting the same creative from a
 * different CSV or row yields the same key. `advertiserIdentity` must be non-blank and
 * at least one durable content hash (creative asset SHA-256 or canonical copy SHA-256)
 * is required; otherwise the fallback is rejected rather than producing a weak key.
 * Nulls are represented consistently as JSON `null` inside the canonical envelope.
 */
export function buildCandidateKey(input: CandidateKeyInput): string {
  const platform = normaliseIdentityComponent(input.platform);
  if (platform === '') throw new Error('candidateKey: platform is required');

  const ext = normaliseIdentityComponent(input.externalAdId);
  if (ext !== '') {
    return buildMetaCandidateKey(platform, ext);
  }

  const fb = input.fallback ?? {};
  const advertiser = (fb.advertiserIdentity ?? '').trim();
  const media = (fb.mediaType ?? '').trim();
  const asset = (fb.creativeAssetSha256 ?? '').trim().toLowerCase();
  const copy = (fb.copySha256 ?? '').trim().toLowerCase();

  const missing: string[] = [];
  if (advertiser === '') missing.push('advertiser identity');
  if (media === '') missing.push('media type');
  if (!isSha256(asset) && !isSha256(copy)) missing.push('creative asset SHA-256 or copy SHA-256');
  if (missing.length > 0) {
    throw new Error(`candidateKey: insufficient fallback identity — missing/invalid: ${missing.join(', ')}`);
  }

  const envelope = canonicalJson({
    platform,
    advertiser_identity: advertiser,
    media_type: media,
    creative_asset_sha256: isSha256(asset) ? asset : null,
    copy_sha256: isSha256(copy) ? copy : null,
  });
  return `local:${sha256Hex(envelope)}`;
}

/** Recompute the key a payload's own identity fields imply (for validation). */
function candidateKeyForPayload(p: PromotionPayloadV1): string {
  const ext = normaliseIdentityComponent(p.external_ad_id);
  // Same shared builder as creation — no duplicated serialisation.
  if (ext !== '') return buildMetaCandidateKey(p.platform, ext);
  return buildCandidateKey({
    platform: p.platform,
    externalAdId: null,
    fallback: {
      advertiserIdentity: p.advertiser_identity,
      mediaType: p.provenance.media_type,
      creativeAssetSha256: p.provenance.creative_asset_sha256,
      copySha256: p.provenance.copy_sha256,
    },
  });
}

// ─── Phase-1-faithful analysis-content checks ─────────────────────────────────
// These mirror the authoritative Phase 1 bundle rules (textField / stringListField /
// rubric) for the SERIALISED AdAnalysis JSON strings this payload stores, so a hash
// can never make blank prose, an empty/wrong-shape list, or malformed JSON "complete".

/** A required prose field: a string with content after trimming (Phase 1 `textField`). */
function proseField(v: unknown, at: string, errors: string[]): void {
  if (typeof v !== 'string' || v.trim() === '') {
    errors.push(`${at} must be a non-empty string — a truthful AdAnalysis record cannot be written without it`);
  }
}

/**
 * A required JSON-string list field (Phase 1 `stringListField`): the stored string
 * must parse to an array of non-blank strings, non-empty (or exactly `exact`), and no
 * more than MAX_ANALYSIS_LIST_ITEMS. `[]` and `["  "]` are rejected as placeholders.
 */
function jsonStringListField(raw: unknown, at: string, errors: string[], exact?: number): void {
  if (typeof raw !== 'string' || raw.trim() === '') { errors.push(`${at} must be a non-empty JSON string`); return; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { errors.push(`${at} is not valid JSON`); return; }
  if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
    errors.push(`${at} must be a JSON array of strings`); return;
  }
  const list = parsed as string[];
  if (exact !== undefined) {
    if (list.length !== exact) errors.push(`${at} must contain exactly ${exact} entries (got ${list.length})`);
  } else if (list.length === 0) {
    errors.push(`${at} must not be an empty array — an empty list asserts "nothing found", which is not a real result`);
  }
  if (list.length > MAX_ANALYSIS_LIST_ITEMS) errors.push(`${at} exceeds ${MAX_ANALYSIS_LIST_ITEMS} entries`);
  list.forEach((s, i) => { if (s.trim() === '') errors.push(`${at}[${i}] is blank — a placeholder entry is not a real result`); });
}

/** The rubric JSON string must parse to a non-empty object of finite numbers. */
function jsonRubricField(raw: unknown, at: string, errors: string[]): void {
  if (typeof raw !== 'string' || raw.trim() === '') { errors.push(`${at} must be a non-empty JSON string`); return; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { errors.push(`${at} is not valid JSON`); return; }
  if (!isPlainObject(parsed)) { errors.push(`${at} must be a JSON object of scores`); return; }
  const keys = Object.keys(parsed);
  if (keys.length === 0) { errors.push(`${at} must not be an empty object`); return; }
  for (const k of keys) {
    const val = (parsed as Record<string, unknown>)[k];
    if (typeof val !== 'number' || !Number.isFinite(val)) errors.push(`${at}.${k} must be a finite number`);
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

export type ValidatePromotionPayloadOptions = {
  expectedSha256: string | null;
  expectedSchemaVersion: number | null;
  candidateKey?: string;
  externalAdId?: string | null;
};

export function validatePromotionPayload(
  payload: unknown,
  opts: ValidatePromotionPayloadOptions,
): ValidationResult {
  const e: string[] = [];
  const push = (m: string) => e.push(m);

  if (!isPlainObject(payload)) return { ok: false, errors: ['payload is not an object'] };
  const p = payload as Record<string, unknown>;

  // ── schema version ──
  if (p.payload_schema_version !== PROMOTION_PAYLOAD_SCHEMA_VERSION) {
    push(`unsupported payload_schema_version ${JSON.stringify(p.payload_schema_version)} (supported: ${PROMOTION_PAYLOAD_SCHEMA_VERSION})`);
  }
  if (opts.expectedSchemaVersion !== null && opts.expectedSchemaVersion !== PROMOTION_PAYLOAD_SCHEMA_VERSION) {
    push(`stored payloadSchemaVersion ${opts.expectedSchemaVersion} is unsupported`);
  }

  // ── top-level scalar shape ──
  if (typeof p.candidate_key !== 'string' || p.candidate_key.trim() === '') push('candidate_key must be a non-empty string');
  if (typeof p.platform !== 'string' || p.platform.trim() === '') push('platform must be a non-empty string');
  if (!(p.external_ad_id === null || (typeof p.external_ad_id === 'string' && p.external_ad_id.trim() !== ''))) push('external_ad_id must be a non-empty string or null');
  if (typeof p.advertiser_identity !== 'string' || p.advertiser_identity.trim() === '') push('advertiser_identity must be a non-empty string');
  if (typeof p.expected_competitor_id !== 'string' || p.expected_competitor_id.trim() === '') push('expected_competitor_id must be a non-empty string');
  if (typeof p.first_collection_source !== 'string' || p.first_collection_source.trim() === '') push('first_collection_source must be a non-empty string');
  if (!isPlainObject(p.verified_metadata)) {
    push('verified_metadata must be an object { disposition, headline_status, description_status }');
  } else {
    const vm = p.verified_metadata as Record<string, unknown>;
    if (!(VERIFIED_META_DISPOSITIONS as readonly string[]).includes(vm.disposition as string)) push(`verified_metadata.disposition must be one of ${VERIFIED_META_DISPOSITIONS.join('/')}`);
    if (!(VERIFIED_FIELD_STATUSES as readonly string[]).includes(vm.headline_status as string)) push(`verified_metadata.headline_status must be one of ${VERIFIED_FIELD_STATUSES.join('/')}`);
    if (!(VERIFIED_FIELD_STATUSES as readonly string[]).includes(vm.description_status as string)) push(`verified_metadata.description_status must be one of ${VERIFIED_FIELD_STATUSES.join('/')}`);
  }
  if (typeof p.creative_source !== 'string' || p.creative_source.trim() === '') push('creative_source must be a non-empty string');
  if (!(p.captured_asset_type === null || typeof p.captured_asset_type === 'string')) push('captured_asset_type must be a string or null');
  if (!(p.visual_confidence === null || (VISUAL_CONFIDENCES as readonly string[]).includes(p.visual_confidence as string))) push(`visual_confidence must be one of ${VISUAL_CONFIDENCES.join('/')} or null`);
  if (typeof p.qualification_recommendation !== 'boolean') push('qualification_recommendation must be a boolean');
  if (!isExactIso(p.created_at)) push('created_at must be an exact ISO instant');

  // If the top-level shape is already broken, deeper checks would be noise.
  if (e.length > 0) return { ok: false, errors: e };

  const full = p as unknown as PromotionPayloadV1;

  // ── candidate-key consistency ──
  let expectedKey: string | null = null;
  try {
    expectedKey = candidateKeyForPayload(full);
  } catch (err) {
    push(`candidate_key cannot be recomputed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (expectedKey !== null && full.candidate_key !== expectedKey) {
    push(`candidate_key mismatch — stored ${JSON.stringify(full.candidate_key)} != canonical ${JSON.stringify(expectedKey)}`);
  }
  if (opts.candidateKey !== undefined && full.candidate_key !== opts.candidateKey) {
    push('candidate_key does not match the candidate row it belongs to');
  }
  if (opts.externalAdId !== undefined && (full.external_ad_id ?? null) !== (opts.externalAdId ?? null)) {
    push('external_ad_id does not match the candidate row it belongs to');
  }

  // ── ad_content ──
  if (!isPlainObject(full.ad_content)) {
    push('ad_content must be an object');
  } else {
    const ac = full.ad_content as Record<string, unknown>;
    for (const k of FORBIDDEN_AD_CONTENT_KEYS) {
      if (k in ac) push(`ad_content must NOT contain "${k}" — it is bound at promotion, not stored`);
    }
    for (const k of AD_CONTENT_KEYS) {
      if (!(k in ac)) push(`ad_content is missing required field "${k}"`);
    }
    for (const k of AD_CONTENT_DATE_KEYS) {
      const val = ac[k];
      if (AD_CONTENT_NULLABLE_DATE_KEYS.has(k) && val === null) continue;
      if (!isExactIso(val)) push(`ad_content.${k} must be an exact ISO string${AD_CONTENT_NULLABLE_DATE_KEYS.has(k) ? ' or null' : ''}`);
    }
    if (typeof ac.score !== 'number' || !Number.isFinite(ac.score)) push('ad_content.score must be a finite number');

    // Copy-honesty is PER FIELD: a field's copy may be non-null ONLY when that field's
    // own verified status is ACCEPT. An accepted field is never erased because the
    // other field is under review; NONE/REVIEW authorise neither.
    const hStatus = full.verified_metadata?.headline_status;
    const dStatus = full.verified_metadata?.description_status;
    if (hStatus !== 'ACCEPT') {
      if (ac.headline !== null) push(`ad_content.headline must be null unless headline_status is ACCEPT (is ${hStatus})`);
    } else if (!(ac.headline === null || typeof ac.headline === 'string')) {
      push('ad_content.headline must be a string or null');
    }
    if (dStatus !== 'ACCEPT') {
      if (ac.description !== null) push(`ad_content.description must be null unless description_status is ACCEPT (is ${dStatus})`);
    } else if (!(ac.description === null || typeof ac.description === 'string')) {
      push('ad_content.description must be a string or null');
    }

    // qualification_recommendation is copied verbatim from the validated frozen
    // mapping (IngestPayload.ad.qualified). It is NEVER re-derived from score here —
    // the only check is that it is a boolean (done in the top-level shape section).
  }

  // ── ad_analysis ──
  //
  // Every required AdAnalysis field must not just be present and typed — it must be a
  // REAL result under the Phase 1 contract. Hash verification alone can never make
  // blank prose, an empty/wrong-shape list, or malformed JSON "complete".
  if (!isPlainObject(full.ad_analysis)) {
    push('ad_analysis must be an object');
  } else {
    const an = full.ad_analysis as Record<string, unknown>;
    for (const k of REQUIRED_AD_ANALYSIS_FIELDS) {
      if (!(k in an) || an[k] === null || an[k] === undefined) {
        push(`ad_analysis is missing required field "${k}"`);
      }
    }
    if ('overallScore' in an && (typeof an.overallScore !== 'number' || !Number.isFinite(an.overallScore))) {
      push('ad_analysis.overallScore must be a finite number');
    }
    // Required prose columns — non-empty strings (Phase 1 textField).
    if ('creativeAnalysis' in an) proseField(an.creativeAnalysis, 'ad_analysis.creativeAnalysis', e);
    if ('copyAnalysis' in an) proseField(an.copyAnalysis, 'ad_analysis.copyAnalysis', e);
    if ('headlineAnalysis' in an) proseField(an.headlineAnalysis, 'ad_analysis.headlineAnalysis', e);
    if ('descriptionAnalysis' in an) proseField(an.descriptionAnalysis, 'ad_analysis.descriptionAnalysis', e);
    // Required JSON-string columns — parse + Phase 1 shape/cardinality.
    if ('strengthsJson' in an) jsonStringListField(an.strengthsJson, 'ad_analysis.strengthsJson', e);
    if ('weaknessesJson' in an) jsonStringListField(an.weaknessesJson, 'ad_analysis.weaknessesJson', e);
    if ('improvementsJson' in an) jsonStringListField(an.improvementsJson, 'ad_analysis.improvementsJson', e, ANALYSIS_IMPROVEMENT_ENTRIES);
    if ('rubricScoresJson' in an) jsonRubricField(an.rubricScoresJson, 'ad_analysis.rubricScoresJson', e);
  }

  // ── provenance ──
  if (!isPlainObject(full.provenance)) {
    push('provenance must be an object');
  } else {
    const pr = full.provenance as Record<string, unknown>;
    for (const k of PROVENANCE_KEYS) {
      if (!(k in pr)) push(`provenance is missing field "${k}"`);
    }
    const numOrNull = (k: string) => { if (pr[k] !== null && (typeof pr[k] !== 'number' || !Number.isFinite(pr[k] as number))) push(`provenance.${k} must be a number or null`); };
    const strOrNull = (k: string) => { if (pr[k] !== null && typeof pr[k] !== 'string') push(`provenance.${k} must be a string or null`); };
    const shaOrNull = (k: string) => { if (pr[k] !== null && !isSha256(pr[k])) push(`provenance.${k} must be a 64-char SHA-256 or null`); };
    numOrNull('bundle_schema_version'); numOrNull('source_row_number');
    shaOrNull('bundle_sha256'); shaOrNull('source_csv_sha256'); shaOrNull('creative_asset_sha256'); shaOrNull('copy_sha256');
    strOrNull('bundle_row_ad_id'); strOrNull('media_type'); strOrNull('creative_asset_path');
    strOrNull('prompt_version'); strOrNull('planner_version'); strOrNull('analysis_model');
    if (pr.bundle_created_at !== null && !isExactIso(pr.bundle_created_at)) push('provenance.bundle_created_at must be an exact ISO string or null');
  }

  // ── hash ──
  if (!isSha256(opts.expectedSha256)) {
    push('a valid payload SHA-256 is required to validate the payload');
  } else {
    let computed: string | null = null;
    try {
      computed = computePayloadSha256(full);
    } catch (err) {
      push(`payload could not be canonically hashed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (computed !== null && computed !== opts.expectedSha256) {
      push('payload SHA-256 mismatch — stored hash does not match the canonical payload');
    }
  }

  return e.length === 0 ? { ok: true } : { ok: false, errors: e };
}

// ─── Completeness derivation (no trusted boolean) ─────────────────────────────

export type PayloadFields = {
  promotionPayloadJson: string | null;
  payloadSchemaVersion: number | null;
  payloadSha256: string | null;
};

export type CompletenessResult = {
  complete: boolean;
  reason: string;
  payload?: PromotionPayloadV1;
};

/**
 * Completeness is derived ONLY by validating the three payload columns under the
 * application-level all-or-none rule. There is no stored completeness flag.
 * `MISSING_ANALYSIS` is exactly "not complete".
 *
 * RESOLUTION RULE (contract): the `MISSING_ANALYSIS` exception (a RESOLUTION-REQUIRED
 * exception in reviewState.ts) may only be resolved — i.e. removed via
 * `resolveException` so the candidate can later be explicitly ACCEPTed — AFTER a
 * COMPLETE promotion payload has validated successfully here (this function returns
 * `complete: true`). Resolving it without a validated complete payload is not
 * permitted; the payload-completeness gate and the resolution-required decision guard
 * are two independent defences.
 */
export function derivePayloadCompleteness(fields: PayloadFields): CompletenessResult {
  const present = [
    fields.promotionPayloadJson !== null && fields.promotionPayloadJson !== undefined,
    fields.payloadSchemaVersion !== null && fields.payloadSchemaVersion !== undefined,
    fields.payloadSha256 !== null && fields.payloadSha256 !== undefined,
  ];
  if (present.every((x) => !x)) return { complete: false, reason: 'no payload (all three payload fields are null)' };
  if (!present.every((x) => x)) return { complete: false, reason: 'partial payload fields — the all-or-none rule is violated' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(fields.promotionPayloadJson as string);
  } catch {
    return { complete: false, reason: 'promotionPayloadJson is not valid JSON' };
  }
  const res = validatePromotionPayload(parsed, {
    expectedSha256: fields.payloadSha256,
    expectedSchemaVersion: fields.payloadSchemaVersion,
  });
  if (!res.ok) return { complete: false, reason: `invalid payload: ${res.errors[0]}` };
  return { complete: true, reason: 'valid complete payload', payload: parsed as PromotionPayloadV1 };
}

// ─── Compile-time drift guards (no runtime effect) ────────────────────────────
// AdContentJson must be assignable from AdWritePayload with only the excluded keys
// removed and dates as strings. If AdWritePayload changes shape, tsc fails here.
type _AdContentKeysAreSubset = (typeof AD_CONTENT_KEYS)[number] extends keyof AdContentJson ? true : never;
const _adContentKeysAreSubset: _AdContentKeysAreSubset = true;
void _adContentKeysAreSubset;
