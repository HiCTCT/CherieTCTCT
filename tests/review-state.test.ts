/**
 * Tracked tests for the Phase 2 Checkpoint 2.1 review-state contract.
 *
 * Runner: Node's built-in `node:test` through tsx.
 *   npm run test:review-state
 *
 * Pure and offline: no database, no ingestion, no AI, no browser, no filesystem.
 * Every test is written so it can only fail for the single rule it names.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REVIEW_SOURCES, REVIEW_STATES, REVIEW_DECISIONS, EXCEPTION_REASONS,
  TERMINAL_EXCEPTIONS, HOLDING_EXCEPTIONS,
  RESOLUTION_REQUIRED_EXCEPTIONS, REVIEW_OVERRIDABLE_EXCEPTIONS,
  createCandidate, initialReviewState, applyDecision, reopenForReview, addNote,
  resolveException, evaluateIngestionEligibility, canProceedToIngestion,
  hasTerminalException, hasResolutionRequiredException,
} from '../lib/analysis/reviewState';
import type {
  ReviewCandidate, ReviewSource, ExceptionReason, ResolvableExceptionReason,
} from '../lib/analysis/reviewState';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const REVIEWER = { reviewer: 'operator', reviewedAt: new Date('2026-07-23T00:00:00.000Z') };

/** A clean, analysis-complete, exception-free candidate for the given source. */
function clean(source: ReviewSource = 'browser_collected'): ReviewCandidate {
  return createCandidate({ source, hasCompleteAnalysis: true });
}

/** A candidate holding exactly one exception (analysis complete unless MISSING_ANALYSIS). */
function withException(reason: ExceptionReason, source: ReviewSource = 'browser_collected'): ReviewCandidate {
  return createCandidate({
    source,
    exceptions: [reason],
    hasCompleteAnalysis: reason !== 'MISSING_ANALYSIS',
  });
}

function accept(candidate: ReviewCandidate) {
  return applyDecision(candidate, 'ACCEPT', REVIEWER);
}
function exclude(candidate: ReviewCandidate) {
  return applyDecision(candidate, 'EXCLUDE', REVIEWER);
}

/** Assert a transition succeeded and return the resulting candidate. */
function ok(result: ReturnType<typeof applyDecision>): ReviewCandidate {
  assert.equal(result.ok, true, `expected transition to succeed, got: ${result.ok ? '' : result.error}`);
  // narrow
  if (!result.ok) throw new Error('unreachable');
  return result.candidate;
}

// ─── Taxonomy sanity ──────────────────────────────────────────────────────────

test('taxonomy: constants are the agreed, non-overlapping sets', () => {
  assert.deepEqual([...REVIEW_SOURCES], ['meta_api', 'browser_collected']);
  assert.deepEqual([...REVIEW_STATES], ['PENDING', 'HELD', 'ACCEPTED', 'EXCLUDED']);
  assert.deepEqual([...REVIEW_DECISIONS], ['ACCEPT', 'EXCLUDE']);
  assert.deepEqual([...EXCEPTION_REASONS], [
    'NEEDS_REVIEW', 'LOW_VISUAL_CONFIDENCE', 'ASSET_COPY_MISMATCH', 'COMPETITOR_CONFLICT',
    'MISSING_ANALYSIS', 'UNAVAILABLE',
  ]);
  // The three categories partition the exception taxonomy exactly.
  const terminal = new Set<string>(TERMINAL_EXCEPTIONS);
  const resolution = new Set<string>(RESOLUTION_REQUIRED_EXCEPTIONS);
  const overridable = new Set<string>(REVIEW_OVERRIDABLE_EXCEPTIONS);
  for (const r of EXCEPTION_REASONS) {
    const inCount = [terminal.has(r), resolution.has(r), overridable.has(r)].filter(Boolean).length;
    assert.equal(inCount, 1, `${r} must be in exactly one exception category`);
  }
  assert.deepEqual([...TERMINAL_EXCEPTIONS], ['UNAVAILABLE']);
  assert.deepEqual([...RESOLUTION_REQUIRED_EXCEPTIONS], ['COMPETITOR_CONFLICT', 'MISSING_ANALYSIS']);
  assert.deepEqual([...REVIEW_OVERRIDABLE_EXCEPTIONS], ['NEEDS_REVIEW', 'LOW_VISUAL_CONFIDENCE', 'ASSET_COPY_MISMATCH']);
  assert.equal((REVIEW_OVERRIDABLE_EXCEPTIONS as readonly string[]).includes('MISSING_ANALYSIS'), false);
  // HOLDING = review-overridable ∪ resolution-required (for queue/UI use).
  assert.deepEqual([...HOLDING_EXCEPTIONS], [...REVIEW_OVERRIDABLE_EXCEPTIONS, ...RESOLUTION_REQUIRED_EXCEPTIONS]);
});

test('initial state: no exceptions → PENDING; any exception → HELD', () => {
  assert.equal(initialReviewState([]), 'PENDING');
  for (const r of EXCEPTION_REASONS) {
    assert.equal(initialReviewState([r]), 'HELD', `${r} should start HELD`);
  }
  assert.equal(clean().state, 'PENDING');
});

// ─── Core eligibility rules ───────────────────────────────────────────────────

test('pending candidates cannot proceed to final ingestion', () => {
  const c = clean();
  assert.equal(c.state, 'PENDING');
  assert.equal(canProceedToIngestion(c), false);
  assert.deepEqual(evaluateIngestionEligibility(c).blockers, [
    'state is PENDING, not ACCEPTED', 'no explicit ACCEPT decision is recorded',
  ]);
});

test('held candidates cannot proceed to final ingestion', () => {
  const c = withException('NEEDS_REVIEW');
  assert.equal(c.state, 'HELD');
  assert.equal(canProceedToIngestion(c), false);
});

test('accepted candidates can proceed to final ingestion', () => {
  const c = ok(accept(clean()));
  assert.equal(c.state, 'ACCEPTED');
  assert.equal(c.decision, 'ACCEPT');
  assert.equal(canProceedToIngestion(c), true);
  assert.deepEqual(evaluateIngestionEligibility(c).blockers, []);
});

test('excluded candidates cannot proceed to final ingestion', () => {
  const c = ok(exclude(clean()));
  assert.equal(c.state, 'EXCLUDED');
  assert.equal(canProceedToIngestion(c), false);
});

test('a note alone does not make a candidate eligible', () => {
  const noted = addNote(clean(), 'looks promising, still deciding');
  // State and decision are untouched by the note.
  assert.equal(noted.state, 'PENDING');
  assert.equal(noted.decision, null);
  assert.equal(noted.note, 'looks promising, still deciding');
  assert.equal(canProceedToIngestion(noted), false);
});

test('a note never overwrites an existing decision or state', () => {
  const accepted = ok(accept(clean()));
  const noted = addNote(accepted, 'approved after manual check');
  assert.equal(noted.state, 'ACCEPTED');
  assert.equal(noted.decision, 'ACCEPT');
  assert.equal(noted.note, 'approved after manual check');
  assert.equal(canProceedToIngestion(noted), true);
});

// ─── Holding exceptions require an explicit decision ──────────────────────────

test('LOW_VISUAL_CONFIDENCE stays held until explicitly accepted or excluded', () => {
  const held = withException('LOW_VISUAL_CONFIDENCE');
  assert.equal(held.state, 'HELD');
  assert.equal(canProceedToIngestion(held), false);

  const accepted = ok(accept(held));
  assert.equal(accepted.state, 'ACCEPTED');
  assert.equal(canProceedToIngestion(accepted), true);

  const excluded = ok(exclude(held));
  assert.equal(excluded.state, 'EXCLUDED');
  assert.equal(canProceedToIngestion(excluded), false);
});

test('ASSET_COPY_MISMATCH stays held until explicitly accepted or excluded', () => {
  const held = withException('ASSET_COPY_MISMATCH');
  assert.equal(held.state, 'HELD');
  assert.equal(canProceedToIngestion(held), false);

  const accepted = ok(accept(held));
  assert.equal(accepted.state, 'ACCEPTED');
  assert.equal(canProceedToIngestion(accepted), true);

  const excluded = ok(exclude(held));
  assert.equal(excluded.state, 'EXCLUDED');
  assert.equal(canProceedToIngestion(excluded), false);
});

// ─── COMPETITOR_CONFLICT ──────────────────────────────────────────────────────

test('COMPETITOR_CONFLICT starts HELD and is not terminal but is resolution-required', () => {
  const held = withException('COMPETITOR_CONFLICT');
  assert.equal(held.state, 'HELD');
  assert.equal(hasTerminalException(held), false);          // not terminal like UNAVAILABLE
  assert.equal(hasResolutionRequiredException(held), true); // but stricter than a plain hold
  assert.equal(canProceedToIngestion(held), false);
});

test('COMPETITOR_CONFLICT: ACCEPT fails while the conflict remains; EXCLUDE stays legal', () => {
  const held = withException('COMPETITOR_CONFLICT');
  const res = accept(held);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /cannot ACCEPT while a resolution-required exception \(COMPETITOR_CONFLICT\)/);
  // EXCLUDE remains available.
  assert.equal(ok(exclude(held)).state, 'EXCLUDED');
});

test('COMPETITOR_CONFLICT: resolving the conflict does not accept, and still needs an explicit ACCEPT', () => {
  const held = withException('COMPETITOR_CONFLICT');
  const resolved = ok(resolveException(held, 'COMPETITOR_CONFLICT'));
  // Removal is not a decision.
  assert.equal(resolved.decision, null);
  assert.equal(resolved.state, 'PENDING'); // no other exceptions remained
  assert.equal(hasResolutionRequiredException(resolved), false);
  assert.equal(canProceedToIngestion(resolved), false); // still needs ACCEPT

  // Only now can it be accepted.
  const accepted = ok(accept(resolved));
  assert.equal(accepted.state, 'ACCEPTED');
  assert.equal(canProceedToIngestion(accepted), true);
});

test('COMPETITOR_CONFLICT: resolving leaves other exceptions in place (stays HELD)', () => {
  const held = createCandidate({
    source: 'browser_collected',
    exceptions: ['COMPETITOR_CONFLICT', 'LOW_VISUAL_CONFIDENCE'],
    hasCompleteAnalysis: true,
  });
  const resolved = ok(resolveException(held, 'COMPETITOR_CONFLICT'));
  assert.equal(resolved.state, 'HELD'); // LOW_VISUAL_CONFIDENCE remains
  assert.deepEqual([...resolved.exceptions], ['LOW_VISUAL_CONFIDENCE']);
});

test('COMPETITOR_CONFLICT: resolving a non-present or decided candidate is rejected', () => {
  const notPresent = resolveException(clean(), 'COMPETITOR_CONFLICT');
  assert.equal(notPresent.ok, false);
  if (!notPresent.ok) assert.match(notPresent.error, /does not carry the exception COMPETITOR_CONFLICT/);

  // A decided candidate cannot have exceptions silently resolved.
  const decided = ok(exclude(withException('COMPETITOR_CONFLICT')));
  const res = resolveException(decided, 'COMPETITOR_CONFLICT');
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /only be resolved on an undecided/);
});

test('COMPETITOR_CONFLICT: eligibility rejects a hand-constructed ACCEPTED candidate still carrying it', () => {
  const forced: ReviewCandidate = {
    source: 'browser_collected', state: 'ACCEPTED', decision: 'ACCEPT',
    exceptions: ['COMPETITOR_CONFLICT'], hasCompleteAnalysis: true,
    reviewer: 'x', reviewedAt: null, note: null, candidateRef: null,
  };
  assert.equal(canProceedToIngestion(forced), false);
  assert.deepEqual(evaluateIngestionEligibility(forced).blockers, [
    'a resolution-required exception (COMPETITOR_CONFLICT) is present',
  ]);
});

test('COMPETITOR_CONFLICT behaves identically for meta_api and browser_collected', () => {
  const meta = withException('COMPETITOR_CONFLICT', 'meta_api');
  const browser = withException('COMPETITOR_CONFLICT', 'browser_collected');
  assert.equal(meta.state, browser.state);
  assert.equal(hasResolutionRequiredException(meta), hasResolutionRequiredException(browser));
  // ACCEPT is blocked for both.
  assert.equal(accept(meta).ok, accept(browser).ok);
  // After identical resolution, both become acceptable identically.
  const rm = ok(resolveException(meta, 'COMPETITOR_CONFLICT'));
  const rb = ok(resolveException(browser, 'COMPETITOR_CONFLICT'));
  assert.equal(canProceedToIngestion(ok(accept(rm))), canProceedToIngestion(ok(accept(rb))));
});

// ─── MISSING_ANALYSIS (resolution-required) ───────────────────────────────────

test('MISSING_ANALYSIS begins HELD and is resolution-required, not review-overridable', () => {
  const held = withException('MISSING_ANALYSIS');
  assert.equal(held.state, 'HELD');
  assert.equal(hasResolutionRequiredException(held), true);
  assert.equal(hasTerminalException(held), false);
  assert.equal(canProceedToIngestion(held), false);
});

test('MISSING_ANALYSIS blocks ACCEPT while the exception remains', () => {
  const held = withException('MISSING_ANALYSIS');
  const res = accept(held);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /cannot ACCEPT while a resolution-required exception/);
});

test('MISSING_ANALYSIS allows EXCLUDE', () => {
  const excluded = ok(exclude(withException('MISSING_ANALYSIS')));
  assert.equal(excluded.state, 'EXCLUDED');
  assert.equal(canProceedToIngestion(excluded), false);
});

test('resolving MISSING_ANALYSIS does not accept the candidate', () => {
  const held = withException('MISSING_ANALYSIS');
  const resolved = ok(resolveException(held, 'MISSING_ANALYSIS'));
  assert.equal(resolved.decision, null);        // not a decision
  assert.equal(resolved.reviewer, null);        // no attribution created
  assert.equal(resolved.reviewedAt, null);
  assert.equal(resolved.state, 'PENDING');      // undecided (no other exceptions)
  assert.deepEqual([...resolved.exceptions], []); // only MISSING_ANALYSIS removed
  assert.equal(canProceedToIngestion(resolved), false); // still needs an explicit ACCEPT

  // A later explicit ACCEPT is required and now succeeds.
  const accepted = ok(accept(resolved));
  assert.equal(accepted.state, 'ACCEPTED');
});

test('resolving MISSING_ANALYSIS leaves other exceptions in place (stays HELD)', () => {
  const held = createCandidate({
    source: 'browser_collected',
    exceptions: ['MISSING_ANALYSIS', 'NEEDS_REVIEW'],
    hasCompleteAnalysis: false,
  });
  const resolved = ok(resolveException(held, 'MISSING_ANALYSIS'));
  assert.equal(resolved.state, 'HELD');
  assert.deepEqual([...resolved.exceptions], ['NEEDS_REVIEW']);
});

test('an accepted candidate with MISSING_ANALYSIS is ineligible (defence in depth)', () => {
  const forced: ReviewCandidate = {
    source: 'browser_collected', state: 'ACCEPTED', decision: 'ACCEPT',
    exceptions: ['MISSING_ANALYSIS'], hasCompleteAnalysis: false,
    reviewer: 'x', reviewedAt: null, note: null, candidateRef: null,
  };
  assert.equal(canProceedToIngestion(forced), false);
  // Both the resolution-required guard and the completeness guard fire.
  const blockers = evaluateIngestionEligibility(forced).blockers;
  assert.ok(blockers.includes('a resolution-required exception (COMPETITOR_CONFLICT) is present') === false);
  assert.ok(blockers.some((b) => /resolution-required exception/.test(b)));
  assert.ok(blockers.includes('analysis is incomplete (MISSING_ANALYSIS)'));
});

test('MISSING_ANALYSIS rules are source-neutral', () => {
  const meta = withException('MISSING_ANALYSIS', 'meta_api');
  const browser = withException('MISSING_ANALYSIS', 'browser_collected');
  assert.equal(meta.state, browser.state);
  assert.equal(hasResolutionRequiredException(meta), hasResolutionRequiredException(browser));
  assert.equal(accept(meta).ok, accept(browser).ok); // both blocked
  const rm = ok(resolveException(meta, 'MISSING_ANALYSIS'));
  const rb = ok(resolveException(browser, 'MISSING_ANALYSIS'));
  assert.equal(ok(accept(rm)).state, ok(accept(rb)).state);
});

// ─── UNAVAILABLE — terminal, never accidentally ingestible ────────────────────

test('UNAVAILABLE cannot be ACCEPTED (illegal transition)', () => {
  const held = withException('UNAVAILABLE');
  assert.equal(held.state, 'HELD');
  assert.equal(hasTerminalException(held), true);
  const res = accept(held);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /cannot ACCEPT a candidate carrying a terminal exception \(UNAVAILABLE\)/);
  }
});

test('UNAVAILABLE can still be explicitly EXCLUDED (surfaced, not silently skipped)', () => {
  const excluded = ok(exclude(withException('UNAVAILABLE')));
  assert.equal(excluded.state, 'EXCLUDED');
  assert.equal(canProceedToIngestion(excluded), false);
});

test('UNAVAILABLE cannot accidentally become ingestible even if forced into ACCEPTED', () => {
  // Defence in depth: a hand-constructed, internally inconsistent candidate (as a
  // future persistence layer might rehydrate) is still blocked by eligibility.
  const forced: ReviewCandidate = {
    source: 'browser_collected', state: 'ACCEPTED', decision: 'ACCEPT',
    exceptions: ['UNAVAILABLE'], hasCompleteAnalysis: true,
    reviewer: 'x', reviewedAt: null, note: null, candidateRef: null,
  };
  assert.equal(canProceedToIngestion(forced), false);
  assert.deepEqual(evaluateIngestionEligibility(forced).blockers, [
    'a terminal exception (UNAVAILABLE) is present',
  ]);
});

// A caller that bypasses the narrowed TypeScript param must still be rejected at runtime.
const asResolvable = (r: string) => r as unknown as ResolvableExceptionReason;

test('resolving UNAVAILABLE throws for meta_api (terminal is never resolvable)', () => {
  const held = withException('UNAVAILABLE', 'meta_api');
  assert.throws(() => resolveException(held, asResolvable('UNAVAILABLE')), /terminal exception \(UNAVAILABLE\) can never be resolved/);
});

test('resolving UNAVAILABLE throws for browser_collected', () => {
  const held = withException('UNAVAILABLE', 'browser_collected');
  assert.throws(() => resolveException(held, asResolvable('UNAVAILABLE')), /terminal exception \(UNAVAILABLE\) can never be resolved/);
});

test('resolving UNAVAILABLE leaves the input candidate deeply unchanged', () => {
  const held = withException('UNAVAILABLE');
  const snapshot = JSON.stringify(held);
  assert.throws(() => resolveException(held, asResolvable('UNAVAILABLE')));
  assert.equal(JSON.stringify(held), snapshot); // rejection fired before any state change
});

test('UNAVAILABLE resolve-then-ACCEPT cannot occur, so it stays permanently ineligible', () => {
  const held = withException('UNAVAILABLE');
  // The resolve step throws, so there is no path to a resolved-then-accepted state.
  assert.throws(() => resolveException(held, asResolvable('UNAVAILABLE')));
  // And ACCEPT on the still-UNAVAILABLE candidate remains illegal.
  assert.equal(accept(held).ok, false);
  assert.equal(canProceedToIngestion(held), false);
});

test('non-terminal resolution flows still work after the terminal guard', () => {
  // COMPETITOR_CONFLICT and MISSING_ANALYSIS remain resolvable.
  assert.equal(ok(resolveException(withException('COMPETITOR_CONFLICT'), 'COMPETITOR_CONFLICT')).state, 'PENDING');
  assert.equal(ok(resolveException(withException('MISSING_ANALYSIS'), 'MISSING_ANALYSIS')).state, 'PENDING');
});

// ─── Illegal transitions & no silent switching ───────────────────────────────

test('deciding on an already-decided candidate is rejected', () => {
  const accepted = ok(accept(clean()));
  const reDecide = applyDecision(accepted, 'ACCEPT', REVIEWER);
  assert.equal(reDecide.ok, false);
  if (!reDecide.ok) assert.match(reDecide.error, /already ACCEPTED candidate/);
});

test('ACCEPTED cannot silently switch to EXCLUDED; only an explicit reopen permits it', () => {
  const accepted = ok(accept(clean()));
  // Direct switch is refused.
  const direct = applyDecision(accepted, 'EXCLUDE', REVIEWER);
  assert.equal(direct.ok, false);
  if (!direct.ok) assert.match(direct.error, /reopen it first/);

  // The only permitted path: reopen, then decide again.
  const reopened = ok(reopenForReview(accepted));
  assert.equal(reopened.state, 'PENDING'); // no exceptions on a clean candidate
  assert.equal(reopened.decision, null);
  assert.equal(reopened.reviewer, null);
  const nowExcluded = ok(exclude(reopened));
  assert.equal(nowExcluded.state, 'EXCLUDED');
});

test('reopen returns a HELD candidate to HELD (exceptions preserved), not PENDING', () => {
  const excluded = ok(exclude(withException('LOW_VISUAL_CONFIDENCE')));
  const reopened = ok(reopenForReview(excluded));
  assert.equal(reopened.state, 'HELD');
  assert.deepEqual([...reopened.exceptions], ['LOW_VISUAL_CONFIDENCE']);
});

test('reopening an undecided candidate is rejected', () => {
  const res = reopenForReview(clean());
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /only a decided .* candidate can be reopened/);
});

// ─── Source-neutrality ────────────────────────────────────────────────────────

test('meta_api and browser_collected use the identical state contract', () => {
  for (const reason of EXCEPTION_REASONS) {
    const meta = withException(reason, 'meta_api');
    const browser = withException(reason, 'browser_collected');

    // Identical initial states and terminal classification.
    assert.equal(meta.state, browser.state, `initial state differs for ${reason}`);
    assert.equal(hasTerminalException(meta), hasTerminalException(browser));

    // Identical decision outcomes.
    const metaAccept = applyDecision(meta, 'ACCEPT', REVIEWER);
    const browserAccept = applyDecision(browser, 'ACCEPT', REVIEWER);
    assert.equal(metaAccept.ok, browserAccept.ok, `ACCEPT legality differs for ${reason}`);

    // Identical eligibility after an EXCLUDE.
    assert.equal(
      canProceedToIngestion(ok(exclude(meta))),
      canProceedToIngestion(ok(exclude(browser))),
      `EXCLUDE eligibility differs for ${reason}`,
    );
  }
});

// ─── Immutability ─────────────────────────────────────────────────────────────

test('transitions never mutate their input candidate', () => {
  const base = clean();
  const snapshot = JSON.stringify(base);
  accept(base);
  exclude(base);
  addNote(base, 'note');
  assert.equal(JSON.stringify(base), snapshot, 'input candidate was mutated');
});
