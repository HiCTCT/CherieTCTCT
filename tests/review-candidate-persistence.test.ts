/**
 * Tracked tests for the Phase 2 Checkpoint 2.2B review-candidate persistence contract.
 *
 * Runner: Node's built-in `node:test` through tsx.
 *   npm run test:review-candidate-persistence
 *
 * Pure and offline: no database, no Prisma, no ingestion, no AI, no network. Each
 * test is written so it can only fail for the single rule it names. Negative tests
 * that target a specific rule RECOMPUTE the payload hash first, so the failure is the
 * named rule and not an incidental hash mismatch; tamper-detection tests deliberately
 * keep the stale hash.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  PROMOTION_STATUSES, PROMOTION_OUTCOMES, VERIFIED_META_DISPOSITIONS, VERIFIED_FIELD_STATUSES,
  PROMOTION_PAYLOAD_SCHEMA_VERSION,
  AD_CONTENT_KEYS, FORBIDDEN_AD_CONTENT_KEYS,
  buildCandidateKey, buildMetaCandidateKey, canonicalJson, sha256Hex, computePayloadSha256,
  validatePromotionPayload, derivePayloadCompleteness, isSha256,
} from '../lib/analysis/reviewCandidatePersistence';
import type { PromotionPayloadV1 } from '../lib/analysis/reviewCandidatePersistence';

// ─── Fixture ──────────────────────────────────────────────────────────────────

const HEX = 'a'.repeat(64);
const HEX2 = 'b'.repeat(64);
const ISO = '2026-07-23T06:10:19.356Z';

function validPayload(): PromotionPayloadV1 {
  return {
    payload_schema_version: 1,
    candidate_key: buildMetaCandidateKey('meta', '3831676167136939'),
    platform: 'meta',
    external_ad_id: '3831676167136939',
    advertiser_identity: '104958372910', // Meta page id (informational for Meta-id'd ads)
    expected_competitor_id: 'cmp23o62c000p2fn63ut08wrn',
    first_collection_source: 'browser_collected',
    verified_metadata: { disposition: 'REVIEW', headline_status: 'REVIEW', description_status: 'REVIEW' },
    creative_source: 'ASSET',
    captured_asset_type: 'VIDEO_FRAME',
    visual_confidence: 'HIGH',
    qualification_recommendation: false, // score 6.1 < 7.0
    ad_content: {
      productOrService: 'Castlery',
      adFormat: 'VIDEO',
      adLink: 'https://www.facebook.com/ads/library/?id=3831676167136939',
      activeSince: null,
      primaryCopy: 'Shop the sale',
      headline: null,
      description: null,
      metaAdId: '3831676167136939',
      adSource: 'browser_collected',
      score: 6.1,
      firstSeenAt: ISO,
      lastSeenAt: ISO,
      lastSeenActiveAt: ISO,
      adStatus: 'ACTIVE',
      capturedAssetPath: 'data/creative-assets/castlery/3831676167136939',
      capturedAssetType: 'VIDEO_FRAME',
      competitorBenchmarkScore: 6.1,
      benchmarkTier: 'WEAK',
      benchmarkConfidence: 'HIGH',
      evidenceSource: 'VISION',
      creativeSource: 'ASSET',
      benchmarkScoredAt: ISO,
    },
    ad_analysis: {
      creativeAnalysis: 'creative', copyAnalysis: 'copy', headlineAnalysis: 'headline',
      descriptionAnalysis: 'description', strengthsJson: '["s"]', weaknessesJson: '["w"]',
      improvementsJson: '["i1","i2","i3"]', rubricScoresJson: '{"hookStopScroll":6}',
      overallScore: 6.1,
    } as PromotionPayloadV1['ad_analysis'],
    provenance: {
      bundle_schema_version: 3,
      bundle_sha256: HEX,
      source_csv_sha256: HEX,
      source_row_number: 8,
      bundle_row_ad_id: '3831676167136939',
      media_type: 'VIDEO',
      creative_asset_path: 'data/creative-assets/castlery/3831676167136939',
      creative_asset_sha256: HEX,
      copy_sha256: null,
      prompt_version: 'v3-prompt',
      planner_version: 'v3-planner',
      analysis_model: 'claude',
      bundle_created_at: ISO,
    },
    created_at: ISO,
  };
}

/** A payload + a hash that MATCHES it (recomputed). */
function signed(p: PromotionPayloadV1): { payload: PromotionPayloadV1; sha: string } {
  return { payload: p, sha: computePayloadSha256(p) };
}
function clone(p: PromotionPayloadV1): PromotionPayloadV1 {
  return structuredClone(p);
}
function firstError(payload: unknown, sha: string | null): string {
  const res = validatePromotionPayload(payload, { expectedSha256: sha, expectedSchemaVersion: 1 });
  assert.equal(res.ok, false, 'expected validation to fail but it passed');
  if (res.ok) throw new Error('unreachable');
  return res.errors.join(' | ');
}

// ─── Candidate identity ───────────────────────────────────────────────────────

test('identity: Meta key is meta:ad:sha256:<hash>, deterministic and route-independent', () => {
  // The builder takes no collection-source argument; identical inputs regardless of route.
  const a = buildCandidateKey({ platform: 'meta', externalAdId: '3831676167136939' });
  const b = buildCandidateKey({ platform: 'meta', externalAdId: '3831676167136939' });
  assert.equal(a, b);
  assert.match(a, /^meta:ad:sha256:[a-f0-9]{64}$/);
  // Shared builder produces the same value.
  assert.equal(a, buildMetaCandidateKey('meta', '3831676167136939'));
});

test('identity: delimiter-bearing components cannot collide (SHA-256 identity, not concatenation)', () => {
  // Old concatenation `${platform}:ad:${ext}` would make ("a:b","c") and ("a","b:c")
  // both look like "a:ad:b:c"-ish once the ':' leaks. Hashing a canonical object prevents it.
  const k1 = buildMetaCandidateKey('meta:x', 'y');
  const k2 = buildMetaCandidateKey('meta', 'x:y');
  assert.notEqual(k1, k2);
  // And an ad id that contains the ':ad:' marker cannot impersonate another key.
  assert.notEqual(buildMetaCandidateKey('meta', 'ad:sha256:deadbeef'), buildMetaCandidateKey('meta', 'other'));
});

test('identity: different externalAdIds → different keys; competitor/source never enter', () => {
  assert.notEqual(
    buildCandidateKey({ platform: 'meta', externalAdId: '111' }),
    buildCandidateKey({ platform: 'meta', externalAdId: '222' }),
  );
  // No competitorId or collectionSource parameter exists on the builder at all.
  assert.equal(
    buildCandidateKey({ platform: 'meta', externalAdId: '999' }),
    buildMetaCandidateKey('meta', '999'),
  );
});

test('identity: surrounding whitespace is normalised identically (trim only, no case folding)', () => {
  // Trim is applied consistently, so padded input yields the same key as trimmed input.
  assert.equal(buildMetaCandidateKey('  meta  ', '  999  '), buildMetaCandidateKey('meta', '999'));
  // No case folding: differing case is a DISTINCT identity.
  assert.notEqual(buildMetaCandidateKey('meta', 'Abc'), buildMetaCandidateKey('meta', 'abc'));
});

test('identity: blank platform or blank external ad id is rejected', () => {
  assert.throws(() => buildMetaCandidateKey('   ', '999'), /platform is required/);
  assert.throws(() => buildMetaCandidateKey('meta', '   '), /external ad id is required/);
});

test('identity: payload validation recomputes via the shared builder and accepts it', () => {
  const { payload, sha } = signed(validPayload());
  // The fixture's candidate_key was produced by buildMetaCandidateKey; validation recomputes it.
  const res = validatePromotionPayload(payload, { expectedSha256: sha, expectedSchemaVersion: 1 });
  assert.equal(res.ok, true, res.ok ? '' : res.errors.join(' | '));
});

test('identity: payload validation rejects a key from different normalised inputs', () => {
  const p = clone(validPayload());
  p.candidate_key = buildMetaCandidateKey('meta', 'DIFFERENT');
  assert.match(firstError(p, computePayloadSha256(p)), /candidate_key mismatch/);
});

const AD_A = 'advertiser-A';
const AD_B = 'advertiser-B';
function fallbackKey(over: Partial<{ advertiserIdentity: string; mediaType: string; creativeAssetSha256: string; copySha256: string }> = {}) {
  return buildCandidateKey({
    platform: 'meta', externalAdId: null,
    fallback: { advertiserIdentity: AD_A, mediaType: 'VIDEO', creativeAssetSha256: HEX2, ...over },
  });
}

test('identity: same advertiser + same content across routes → same fallback key (CSV/row/path excluded)', () => {
  // No CSV-checksum, row-number or path input exists at all, so re-export from a
  // different CSV/row/path cannot change the key.
  assert.equal(fallbackKey(), fallbackKey());
  assert.match(fallbackKey(), /^local:[a-f0-9]{64}$/);
});

test('identity: different advertisers with identical content → different fallback keys', () => {
  const kA = fallbackKey({ advertiserIdentity: AD_A });
  const kB = fallbackKey({ advertiserIdentity: AD_B });
  assert.notEqual(kA, kB);
});

test('identity: fallback keys differ when the durable content hash differs', () => {
  assert.notEqual(fallbackKey({ creativeAssetSha256: HEX }), fallbackKey({ creativeAssetSha256: HEX2 }));
});

test('identity: fallback accepts a canonical copy hash when no asset hash exists', () => {
  const k = buildCandidateKey({ platform: 'meta', externalAdId: null, fallback: { advertiserIdentity: AD_A, mediaType: 'IMAGE', copySha256: HEX } });
  assert.match(k, /^local:[a-f0-9]{64}$/);
});

test('identity: fallback rejects insufficient identity', () => {
  // No durable content hash.
  assert.throws(() => buildCandidateKey({ platform: 'meta', externalAdId: null, fallback: { advertiserIdentity: AD_A, mediaType: 'VIDEO' } }), /creative asset SHA-256 or copy SHA-256/);
  // Missing media type.
  assert.throws(() => buildCandidateKey({ platform: 'meta', externalAdId: null, fallback: { advertiserIdentity: AD_A, creativeAssetSha256: HEX } }), /media type/);
  // Blank advertiser identity.
  assert.throws(() => buildCandidateKey({ platform: 'meta', externalAdId: null, fallback: { advertiserIdentity: '  ', mediaType: 'VIDEO', creativeAssetSha256: HEX } }), /advertiser identity/);
});

test('identity: no random or timestamp component — repeated builds are identical', () => {
  const keys = new Set<string>();
  for (let i = 0; i < 50; i++) keys.add(buildCandidateKey({ platform: 'meta', externalAdId: 'x' }));
  assert.equal(keys.size, 1);
});

// ─── Canonical payload and hash ───────────────────────────────────────────────

test('canonical: identical payloads produce identical canonical JSON and SHA-256', () => {
  const a = validPayload();
  const b = validPayload();
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(computePayloadSha256(a), computePayloadSha256(b));
});

test('canonical: object key insertion order does not change the hash', () => {
  const p = validPayload();
  // Rebuild the same object with keys inserted in reverse order.
  const reordered = Object.fromEntries(
    Object.entries(p as unknown as Record<string, unknown>).reverse(),
  ) as unknown as PromotionPayloadV1;
  assert.equal(computePayloadSha256(p), computePayloadSha256(reordered));
});

test('canonical: a Date object anywhere is rejected (never silently serialised)', () => {
  const p = validPayload() as unknown as Record<string, unknown>;
  (p.ad_content as Record<string, unknown>).firstSeenAt = new Date();
  assert.throws(() => canonicalJson(p), /Date objects are not allowed/);
});

test('a fully valid payload passes validation', () => {
  const { payload, sha } = signed(validPayload());
  const res = validatePromotionPayload(payload, { expectedSha256: sha, expectedSchemaVersion: 1 });
  assert.equal(res.ok, true, res.ok ? '' : res.errors.join(' | '));
});

test('tampering with Ad content is detected (stale hash → mismatch)', () => {
  const { payload, sha } = signed(validPayload());
  const tampered = clone(payload);
  tampered.ad_content.primaryCopy = 'CHANGED';
  assert.match(firstError(tampered, sha), /SHA-256 mismatch/);
});

test('tampering with analysis is detected (stale hash → mismatch)', () => {
  const { payload, sha } = signed(validPayload());
  const tampered = clone(payload);
  tampered.ad_analysis.creativeAnalysis = 'CHANGED';
  assert.match(firstError(tampered, sha), /SHA-256 mismatch/);
});

test('tampering with provenance is detected (stale hash → mismatch)', () => {
  const { payload, sha } = signed(validPayload());
  const tampered = clone(payload);
  tampered.provenance.analysis_model = 'CHANGED';
  assert.match(firstError(tampered, sha), /SHA-256 mismatch/);
});

test('a mismatched SHA-256 fails', () => {
  const { payload } = signed(validPayload());
  assert.match(firstError(payload, HEX2), /SHA-256 mismatch/);
});

test('a missing payload hash fails', () => {
  const { payload } = signed(validPayload());
  assert.match(firstError(payload, null), /valid payload SHA-256 is required/);
});

test('an unsupported payload schema version fails', () => {
  const p = clone(validPayload());
  (p as unknown as Record<string, unknown>).payload_schema_version = 2;
  assert.match(firstError(p, computePayloadSha256(p)), /unsupported payload_schema_version/);
});

// ─── Data honesty ─────────────────────────────────────────────────────────────

test('every required AdAnalysis field must be present and non-null', () => {
  const p = clone(validPayload());
  delete (p.ad_analysis as Record<string, unknown>).rubricScoresJson;
  assert.match(firstError(p, computePayloadSha256(p)), /ad_analysis is missing required field "rubricScoresJson"/);
});

test('analysis: a null required AdAnalysis field is rejected', () => {
  const p = clone(validPayload());
  (p.ad_analysis as Record<string, unknown>).strengthsJson = null;
  assert.match(firstError(p, computePayloadSha256(p)), /ad_analysis is missing required field "strengthsJson"/);
});

test('analysis: empty prose is rejected', () => {
  const p = clone(validPayload());
  p.ad_analysis.creativeAnalysis = '';
  assert.match(firstError(p, computePayloadSha256(p)), /ad_analysis.creativeAnalysis must be a non-empty string/);
});

test('analysis: whitespace-only prose is rejected', () => {
  const p = clone(validPayload());
  p.ad_analysis.copyAnalysis = '   ';
  assert.match(firstError(p, computePayloadSha256(p)), /ad_analysis.copyAnalysis must be a non-empty string/);
});

test('analysis: malformed JSON in a JSON-string field is rejected', () => {
  const p = clone(validPayload());
  p.ad_analysis.strengthsJson = '[not valid json';
  assert.match(firstError(p, computePayloadSha256(p)), /ad_analysis.strengthsJson is not valid JSON/);
});

test('analysis: valid JSON with the wrong top-level type is rejected', () => {
  const p = clone(validPayload());
  p.ad_analysis.weaknessesJson = '{"a":1}'; // object, not an array
  assert.match(firstError(p, computePayloadSha256(p)), /ad_analysis.weaknessesJson must be a JSON array of strings/);
});

test('analysis: wrong nested element shape (non-string entries) is rejected', () => {
  const p = clone(validPayload());
  p.ad_analysis.strengthsJson = '[1,2,3]';
  assert.match(firstError(p, computePayloadSha256(p)), /ad_analysis.strengthsJson must be a JSON array of strings/);
});

test('analysis: empty placeholder array is rejected', () => {
  const p = clone(validPayload());
  p.ad_analysis.strengthsJson = '[]';
  assert.match(firstError(p, computePayloadSha256(p)), /ad_analysis.strengthsJson must not be an empty array/);
});

test('analysis: a blank list entry is rejected as a placeholder', () => {
  const p = clone(validPayload());
  p.ad_analysis.weaknessesJson = '["  "]';
  assert.match(firstError(p, computePayloadSha256(p)), /ad_analysis.weaknessesJson\[0\] is blank/);
});

test('analysis: improvements must contain exactly 3 entries (Phase 1 cardinality)', () => {
  const p = clone(validPayload());
  p.ad_analysis.improvementsJson = '["only-one"]';
  assert.match(firstError(p, computePayloadSha256(p)), /ad_analysis.improvementsJson must contain exactly 3 entries/);
});

test('analysis: rubric must be a non-empty object of finite numbers', () => {
  const empty = clone(validPayload());
  empty.ad_analysis.rubricScoresJson = '{}';
  assert.match(firstError(empty, computePayloadSha256(empty)), /ad_analysis.rubricScoresJson must not be an empty object/);

  const wrongType = clone(validPayload());
  wrongType.ad_analysis.rubricScoresJson = '{"hookStopScroll":"high"}';
  assert.match(firstError(wrongType, computePayloadSha256(wrongType)), /ad_analysis.rubricScoresJson.hookStopScroll must be a finite number/);
});

test('relational ids inside Ad content are rejected', () => {
  for (const k of ['competitorId', 'clientId', 'industryId'] as const) {
    const p = clone(validPayload());
    (p.ad_content as Record<string, unknown>)[k] = 'x';
    assert.match(firstError(p, computePayloadSha256(p)), new RegExp(`ad_content must NOT contain "${k}"`));
  }
});

test('reviewStatus inside Ad content is rejected', () => {
  const p = clone(validPayload());
  (p.ad_content as Record<string, unknown>).reviewStatus = 'PENDING';
  assert.match(firstError(p, computePayloadSha256(p)), /ad_content must NOT contain "reviewStatus"/);
});

test('qualified inside Ad content is rejected', () => {
  const p = clone(validPayload());
  (p.ad_content as Record<string, unknown>).qualified = true;
  assert.match(firstError(p, computePayloadSha256(p)), /ad_content must NOT contain "qualified"/);
});

test('per-field: headline ACCEPT + description REVIEW — accepted headline kept, description stays null', () => {
  const p = clone(validPayload());
  p.verified_metadata = { disposition: 'ACCEPTED', headline_status: 'ACCEPT', description_status: 'REVIEW' };
  p.ad_content.headline = 'Verified headline';
  p.ad_content.description = null;
  const res = validatePromotionPayload(p, { expectedSha256: computePayloadSha256(p), expectedSchemaVersion: 1 });
  assert.equal(res.ok, true, res.ok ? '' : res.errors.join(' | '));

  const bad = clone(p);
  bad.ad_content.description = 'Leaked description';
  assert.match(firstError(bad, computePayloadSha256(bad)), /description must be null unless description_status is ACCEPT/);
});

test('per-field: headline REVIEW + description ACCEPT — accepted description kept, headline stays null', () => {
  const p = clone(validPayload());
  p.verified_metadata = { disposition: 'ACCEPTED', headline_status: 'REVIEW', description_status: 'ACCEPT' };
  p.ad_content.headline = null;
  p.ad_content.description = 'Verified description';
  const res = validatePromotionPayload(p, { expectedSha256: computePayloadSha256(p), expectedSchemaVersion: 1 });
  assert.equal(res.ok, true, res.ok ? '' : res.errors.join(' | '));

  const bad = clone(p);
  bad.ad_content.headline = 'Leaked headline';
  assert.match(firstError(bad, computePayloadSha256(bad)), /headline must be null unless headline_status is ACCEPT/);
});

test('per-field: both ACCEPT — both fields may carry verified copy', () => {
  const p = clone(validPayload());
  p.verified_metadata = { disposition: 'ACCEPTED', headline_status: 'ACCEPT', description_status: 'ACCEPT' };
  p.ad_content.headline = 'Verified H';
  p.ad_content.description = 'Verified D';
  const res = validatePromotionPayload(p, { expectedSha256: computePayloadSha256(p), expectedSchemaVersion: 1 });
  assert.equal(res.ok, true, res.ok ? '' : res.errors.join(' | '));
});

test('per-field: both REVIEW — neither field may carry copy', () => {
  const p = clone(validPayload());
  p.verified_metadata = { disposition: 'REVIEW', headline_status: 'REVIEW', description_status: 'REVIEW' };
  p.ad_content.headline = 'Leaked';
  assert.match(firstError(p, computePayloadSha256(p)), /headline must be null unless headline_status is ACCEPT/);
});

test('per-field: NONE authorises neither field', () => {
  const p = clone(validPayload());
  p.verified_metadata = { disposition: 'NONE', headline_status: 'NONE', description_status: 'NONE' };
  p.ad_content.description = 'Leaked';
  assert.match(firstError(p, computePayloadSha256(p)), /description must be null unless description_status is ACCEPT/);
});

test('defence-in-depth: row-level ACCEPTED with field-level REVIEW does NOT authorise copy', () => {
  // The row-level disposition is independent (the loader stores it separately) and can
  // never weaken the per-field gate. ACCEPTED at the row level with both fields under
  // REVIEW must still reject non-null copy.
  const p = clone(validPayload());
  p.verified_metadata = { disposition: 'ACCEPTED', headline_status: 'REVIEW', description_status: 'REVIEW' };
  p.ad_content.headline = 'Leaked despite row-level ACCEPTED';
  assert.match(firstError(p, computePayloadSha256(p)), /headline must be null unless headline_status is ACCEPT/);
});

test('advertiser_identity must be non-blank', () => {
  const p = clone(validPayload());
  (p as unknown as Record<string, unknown>).advertiser_identity = '   ';
  assert.match(firstError(p, computePayloadSha256(p)), /advertiser_identity must be a non-empty string/);
});

test('exact ISO date handling is deterministic — a non-ISO date is rejected', () => {
  const p = clone(validPayload());
  (p.ad_content as Record<string, unknown>).firstSeenAt = '2026-07-23';
  assert.match(firstError(p, computePayloadSha256(p)), /ad_content\.firstSeenAt must be an exact ISO string/);
});

test('qualification: a stored false recommendation stays false even when score is high', () => {
  const p = clone(validPayload());
  p.ad_content.score = 9.5;               // high score — but the mapping is authoritative
  p.qualification_recommendation = false; // copied verbatim from IngestPayload.ad.qualified
  const res = validatePromotionPayload(p, { expectedSha256: computePayloadSha256(p), expectedSchemaVersion: 1 });
  assert.equal(res.ok, true, res.ok ? '' : res.errors.join(' | ')); // no threshold rescoring
});

test('qualification: a stored true recommendation stays true without scoring logic', () => {
  const p = clone(validPayload());
  p.ad_content.score = 2.0;              // low score — still honoured verbatim
  p.qualification_recommendation = true;
  const res = validatePromotionPayload(p, { expectedSha256: computePayloadSha256(p), expectedSchemaVersion: 1 });
  assert.equal(res.ok, true, res.ok ? '' : res.errors.join(' | '));
});

test('qualification: tampering with the recommendation invalidates the payload hash', () => {
  const { payload, sha } = signed(validPayload());
  const tampered = clone(payload);
  tampered.qualification_recommendation = !tampered.qualification_recommendation;
  assert.match(firstError(tampered, sha), /SHA-256 mismatch/);
});

test('qualification: a non-boolean recommendation is rejected', () => {
  const p = clone(validPayload());
  (p as unknown as Record<string, unknown>).qualification_recommendation = 'yes';
  assert.match(firstError(p, computePayloadSha256(p)), /qualification_recommendation must be a boolean/);
});

test('qualification: the module hard-codes no qualification threshold', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib/analysis/reviewCandidatePersistence.ts'), 'utf8');
  assert.equal(/QUALIFY_THRESHOLD/.test(src), false, 'QUALIFY_THRESHOLD must not exist');
  assert.equal(/>=\s*7(\.0)?\b/.test(src), false, 'no ">= 7" score threshold may exist');
});

test('a candidate_key inconsistent with the payload identity is rejected', () => {
  const p = clone(validPayload());
  p.candidate_key = 'meta:ad:WRONG';
  assert.match(firstError(p, computePayloadSha256(p)), /candidate_key mismatch/);
});

test('malformed provenance is rejected', () => {
  const p = clone(validPayload());
  (p.provenance as Record<string, unknown>).source_csv_sha256 = 'not-a-hash';
  assert.match(firstError(p, computePayloadSha256(p)), /provenance\.source_csv_sha256 must be a 64-char SHA-256 or null/);
});

// ─── Lifecycle contract ───────────────────────────────────────────────────────

test('promotion status and outcome values are exact and contain no PROMOTING', () => {
  assert.deepEqual([...PROMOTION_STATUSES], ['NOT_PROMOTED', 'PROMOTED', 'FAILED']);
  assert.deepEqual([...PROMOTION_OUTCOMES], ['SUCCESS', 'ALREADY_EXISTS', 'FAILED']);
  assert.equal((PROMOTION_STATUSES as readonly string[]).includes('PROMOTING'), false);
  assert.equal((PROMOTION_OUTCOMES as readonly string[]).includes('PROMOTING'), false);
});

test('ALREADY_EXISTS is a distinct outcome from FAILED', () => {
  assert.notEqual('ALREADY_EXISTS', 'FAILED');
  assert.equal((PROMOTION_OUTCOMES as readonly string[]).includes('ALREADY_EXISTS'), true);
  assert.equal((PROMOTION_OUTCOMES as readonly string[]).includes('FAILED'), true);
});

test('disposition and field-status vocabularies are grounded in the loader (no REJECTED)', () => {
  assert.deepEqual([...VERIFIED_META_DISPOSITIONS], ['NONE', 'ACCEPTED', 'REVIEW']);
  assert.deepEqual([...VERIFIED_FIELD_STATUSES], ['NONE', 'ACCEPT', 'REVIEW']);
  assert.equal((VERIFIED_META_DISPOSITIONS as readonly string[]).includes('REJECTED'), false);
  assert.equal((VERIFIED_FIELD_STATUSES as readonly string[]).includes('REJECTED'), false);
});

test('completeness: all three payload fields null → incomplete', () => {
  const r = derivePayloadCompleteness({ promotionPayloadJson: null, payloadSchemaVersion: null, payloadSha256: null });
  assert.equal(r.complete, false);
  assert.match(r.reason, /no payload/);
});

test('completeness: partial payload fields → invalid (all-or-none)', () => {
  const { payload } = signed(validPayload());
  const r = derivePayloadCompleteness({ promotionPayloadJson: JSON.stringify(payload), payloadSchemaVersion: null, payloadSha256: null });
  assert.equal(r.complete, false);
  assert.match(r.reason, /all-or-none/);
});

test('completeness: a valid complete payload is complete (derived, not a trusted boolean)', () => {
  const { payload, sha } = signed(validPayload());
  const r = derivePayloadCompleteness({
    promotionPayloadJson: JSON.stringify(payload), payloadSchemaVersion: 1, payloadSha256: sha,
  });
  assert.equal(r.complete, true);
  assert.ok(r.payload);
});

test('completeness: a present-but-invalid payload is incomplete', () => {
  const { payload } = signed(validPayload());
  const bad = clone(payload);
  bad.ad_content.primaryCopy = 'CHANGED'; // stale hash below → invalid
  const r = derivePayloadCompleteness({
    promotionPayloadJson: JSON.stringify(bad), payloadSchemaVersion: 1, payloadSha256: computePayloadSha256(payload),
  });
  assert.equal(r.complete, false);
  assert.match(r.reason, /invalid payload/);
});

// ─── Boundary sanity ──────────────────────────────────────────────────────────

test('AD_CONTENT_KEYS and FORBIDDEN_AD_CONTENT_KEYS do not overlap', () => {
  const forbidden = new Set<string>(FORBIDDEN_AD_CONTENT_KEYS);
  for (const k of AD_CONTENT_KEYS) assert.equal(forbidden.has(k), false, `${k} must not be both content and forbidden`);
  assert.equal(PROMOTION_PAYLOAD_SCHEMA_VERSION, 1);
  assert.equal(isSha256(HEX), true);
  assert.equal(sha256Hex('x').length, 64);
});
