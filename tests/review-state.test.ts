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
  createCandidate, initialReviewState, applyDecision, reopenForReview, addNote,
  evaluateIngestionEligibility, canProceedToIngestion, hasTerminalException,
} from '../lib/analysis/reviewState';
import type {
  ReviewCandidate, ReviewSource, ExceptionReason,
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
    'NEEDS_REVIEW', 'LOW_VISUAL_CONFIDENCE', 'ASSET_COPY_MISMATCH', 'MISSING_ANALYSIS', 'UNAVAILABLE',
  ]);
  // Terminal and holding partition the exception taxonomy with no overlap.
  const terminal = new Set<string>(TERMINAL_EXCEPTIONS);
  const holding = new Set<string>(HOLDING_EXCEPTIONS);
  for (const r of EXCEPTION_REASONS) {
    assert.equal(terminal.has(r) !== holding.has(r), true, `${r} must be exactly one of terminal/holding`);
  }
  assert.deepEqual([...TERMINAL_EXCEPTIONS], ['UNAVAILABLE']);
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

// ─── MISSING_ANALYSIS ─────────────────────────────────────────────────────────

test('MISSING_ANALYSIS cannot be ingested even once ACCEPTED, until analysis is complete', () => {
  // ACCEPT is a legal decision for a holding exception, but eligibility still fails
  // because the analysis requirement is not satisfied.
  const held = withException('MISSING_ANALYSIS');
  assert.equal(held.hasCompleteAnalysis, false);
  const accepted = ok(accept(held));
  assert.equal(accepted.state, 'ACCEPTED');
  assert.equal(canProceedToIngestion(accepted), false);
  assert.deepEqual(evaluateIngestionEligibility(accepted).blockers, [
    'analysis is incomplete (MISSING_ANALYSIS)',
  ]);
});

test('once the analysis requirement is satisfied, an accepted candidate is eligible', () => {
  // Same shape, but the repository requirement for a complete analysis is met.
  const held = createCandidate({
    source: 'browser_collected', exceptions: ['MISSING_ANALYSIS'], hasCompleteAnalysis: true,
  });
  const accepted = ok(accept(held));
  assert.equal(canProceedToIngestion(accepted), true);
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
