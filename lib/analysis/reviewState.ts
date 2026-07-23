/**
 * Source-neutral review & exception-state contract (Phase 2, Checkpoint 2.1) — PURE
 *
 * A single, dependency-free state contract shared by BOTH ad sources
 * (`meta_api` and `browser_collected`). It exists so the review lifecycle can be
 * reasoned about and tested with plain in-memory values, before any persistence
 * design is chosen.
 *
 * STRUCTURAL GUARANTEES — enforced by the (empty) import list, not by comments:
 *   - No Prisma, no `Ad`/`AdAnalysis` shape, no database, no ingestion script, no
 *     API route, no analyser, no Anthropic, no Playwright, no capture code.
 *   - Nothing here reads or writes anything. Every function is pure and returns a
 *     NEW value; no input is mutated.
 *
 * PERSISTENCE-NEUTRALITY (deliberate — do NOT remove):
 *   A `ReviewCandidate` is an abstract value with no assumed table, column or
 *   identity. This checkpoint does NOT decide where review data lives. The same
 *   contract supports either future design:
 *     (1) the candidate is first persisted in a HELD state on the eventual Ad record
 *         and later promoted; or
 *     (2) a separate review-candidate record exists before the final Ad insert.
 *   The optional `candidateRef` is an opaque handle for whichever design 2.2 picks;
 *   this module never interprets it.
 *
 * SEPARATION OF CONCERNS (a required design correction):
 *   - A NOTE is optional free text. It is metadata only and, on its own, NEVER
 *     accepts, excludes or makes a candidate eligible. `addNote` cannot change the
 *     state or the decision.
 *   - A DECISION is an explicit ACCEPT or EXCLUDE. "No decision yet" is the ABSENCE
 *     of a decision (`null`), not a third decision value.
 *   - A STATE is the lifecycle position (PENDING / HELD / ACCEPTED / EXCLUDED).
 *   - An EXCEPTION REASON is a typed explanation of why a candidate is held or is
 *     non-ingestible.
 */

// ─── Sources ──────────────────────────────────────────────────────────────────
// Mirror the `Ad.adSource` values already used in the repository so the same
// contract covers both. The point of this module is that behaviour does NOT
// branch on the source; the field exists only for attribution/routing.
export const REVIEW_SOURCES = ['meta_api', 'browser_collected'] as const;
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

// ─── Review states ────────────────────────────────────────────────────────────
// PENDING  — awaiting a first look; no blocking exception recorded.
// HELD     — surfaced for review because at least one exception applies; needs an
//            explicit decision (or, for a terminal exception, can only be excluded
//            or annotated — never accepted).
// ACCEPTED — an explicit ACCEPT decision has been recorded.
// EXCLUDED — an explicit EXCLUDE decision has been recorded.
export const REVIEW_STATES = ['PENDING', 'HELD', 'ACCEPTED', 'EXCLUDED'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** The two pre-decision states. A candidate here still needs an explicit decision. */
export const UNDECIDED_STATES = ['PENDING', 'HELD'] as const;
/** The two post-decision states. Reaching either requires an explicit decision. */
export const DECIDED_STATES = ['ACCEPTED', 'EXCLUDED'] as const;

// ─── Decisions ────────────────────────────────────────────────────────────────
// Exactly two explicit decisions. "No decision yet" is `null`, never a member.
export const REVIEW_DECISIONS = ['ACCEPT', 'EXCLUDE'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

// ─── Exception reasons ────────────────────────────────────────────────────────
// A typed taxonomy of why a candidate is held or non-ingestible.
export const EXCEPTION_REASONS = [
  'NEEDS_REVIEW',          // technical/uncertain capture outcome (CSV `NEEDS_REVIEW` today)
  'LOW_VISUAL_CONFIDENCE', // VIDEO visual confidence resolved to LOW (bundle-carried today)
  'ASSET_COPY_MISMATCH',   // captured asset and scoring copy disagree (detector is future work)
  'MISSING_ANALYSIS',      // no complete, validated analysis exists for this candidate
  'UNAVAILABLE',           // positive evidence the ad ended / is not in the library
] as const;
export type ExceptionReason = (typeof EXCEPTION_REASONS)[number];

/**
 * TERMINAL, non-ingestible exceptions.
 *
 * UNAVAILABLE decision (see the checkpoint report): the repository writes
 * UNAVAILABLE only on POSITIVE ad-specific evidence that the ad ended or is not in
 * the library (§6 state matrix; the 3A dry run held `1227977176029398` this way).
 * That is not a live library ad, so it must NEVER become ingestible — but §6 also
 * requires it be shown "as an exception, not a silent skip". This contract honours
 * both: an UNAVAILABLE candidate is HELD (visible, reviewable, annotatable, and
 * may be explicitly EXCLUDED) but ACCEPT is an illegal transition, so it can never
 * reach ACCEPTED. It is therefore a terminal non-ingestible disposition that is
 * still surfaced for review — visibility is not ingestibility.
 */
export const TERMINAL_EXCEPTIONS = ['UNAVAILABLE'] as const;

/**
 * HOLDING exceptions: reviewable holds that CAN be resolved by an explicit ACCEPT
 * or EXCLUDE. (MISSING_ANALYSIS is a hold that additionally can never satisfy
 * ingestion eligibility until complete analysis exists — enforced separately by the
 * eligibility gate, not by blocking the ACCEPT decision itself.)
 */
export const HOLDING_EXCEPTIONS = [
  'NEEDS_REVIEW', 'LOW_VISUAL_CONFIDENCE', 'ASSET_COPY_MISMATCH', 'MISSING_ANALYSIS',
] as const;

// ─── The candidate value ──────────────────────────────────────────────────────

/** Optional attribution recorded alongside a decision. Data concepts only. */
export type ReviewAttribution = {
  reviewer: string | null;
  reviewedAt: Date | null;
};

/**
 * A persistence-neutral review candidate. See the module header: this is an
 * abstract value, not a database row, and must stay that way in this checkpoint.
 */
export type ReviewCandidate = {
  /** Which ad source produced this candidate. Never used to branch behaviour. */
  source: ReviewSource;
  /** Lifecycle position. */
  state: ReviewState;
  /** The explicit decision, or `null` when none has been made yet. */
  decision: ReviewDecision | null;
  /** Typed reasons this candidate is held / non-ingestible. May be empty. */
  exceptions: readonly ExceptionReason[];
  /**
   * Whether the repository's requirements for a COMPLETE analysis are satisfied
   * (in Phase 1 terms: a validated schema-v3 SUCCESS analysis exists). This is the
   * authoritative ingestion precondition; `MISSING_ANALYSIS` is its exception face.
   */
  hasCompleteAnalysis: boolean;
  /** Who recorded the current decision, if anyone. */
  reviewer: string | null;
  /** When the current decision was recorded, if ever. */
  reviewedAt: Date | null;
  /** Optional free-text note. Metadata only — NEVER a decision. */
  note: string | null;
  /** Opaque handle for whichever persistence design 2.2 chooses. Never interpreted here. */
  candidateRef: string | null;
};

// ─── Result type for transitions ──────────────────────────────────────────────
// Transitions return a discriminated result so callers (and tests) can assert the
// exact reason a transition was rejected, rather than catching a thrown error.
export type TransitionResult =
  | { ok: true; candidate: ReviewCandidate }
  | { ok: false; error: string };

// ─── Small membership helpers ─────────────────────────────────────────────────

export function isTerminalException(reason: ExceptionReason): boolean {
  return (TERMINAL_EXCEPTIONS as readonly ExceptionReason[]).includes(reason);
}

export function hasTerminalException(candidate: ReviewCandidate): boolean {
  return candidate.exceptions.some(isTerminalException);
}

function isUndecided(state: ReviewState): boolean {
  return (UNDECIDED_STATES as readonly ReviewState[]).includes(state);
}

function isDecided(state: ReviewState): boolean {
  return (DECIDED_STATES as readonly ReviewState[]).includes(state);
}

// ─── Construction ─────────────────────────────────────────────────────────────

/**
 * The initial lifecycle state implied by a candidate's exceptions: any exception
 * (holding OR terminal) means it must be surfaced and cannot silently proceed, so
 * it starts HELD; otherwise PENDING.
 */
export function initialReviewState(exceptions: readonly ExceptionReason[]): ReviewState {
  return exceptions.length > 0 ? 'HELD' : 'PENDING';
}

export type CreateCandidateInput = {
  source: ReviewSource;
  exceptions?: readonly ExceptionReason[];
  hasCompleteAnalysis: boolean;
  note?: string | null;
  candidateRef?: string | null;
};

/**
 * Build a fresh, undecided candidate with a consistent initial state. A new
 * candidate never carries a decision or decision attribution; a note may be
 * supplied up front (it is still metadata only).
 */
export function createCandidate(input: CreateCandidateInput): ReviewCandidate {
  const exceptions = input.exceptions ? [...input.exceptions] : [];
  return {
    source: input.source,
    state: initialReviewState(exceptions),
    decision: null,
    exceptions,
    hasCompleteAnalysis: input.hasCompleteAnalysis,
    reviewer: null,
    reviewedAt: null,
    note: input.note ?? null,
    candidateRef: input.candidateRef ?? null,
  };
}

// ─── Transitions ──────────────────────────────────────────────────────────────

/**
 * Apply an explicit ACCEPT or EXCLUDE decision.
 *
 * Legal ONLY from an undecided state (PENDING or HELD). Deciding on an already
 * decided candidate is rejected — an ACCEPTED or EXCLUDED candidate can NEVER
 * switch straight to the opposite decision; it must be explicitly reopened first
 * (see `reopenForReview`). This is what stops a silent ACCEPTED⇄EXCLUDED flip.
 *
 * ACCEPT is additionally illegal when a terminal exception (UNAVAILABLE) is
 * present, so a non-ingestible ad can never reach ACCEPTED. EXCLUDE stays legal
 * for terminal-exception candidates.
 */
export function applyDecision(
  candidate: ReviewCandidate,
  decision: ReviewDecision,
  attribution: ReviewAttribution = { reviewer: null, reviewedAt: null },
): TransitionResult {
  if (!isUndecided(candidate.state)) {
    return {
      ok: false,
      error: `ILLEGAL_TRANSITION: cannot record a decision on an already ${candidate.state} candidate; reopen it first`,
    };
  }
  if (decision === 'ACCEPT' && hasTerminalException(candidate)) {
    return {
      ok: false,
      error: 'ILLEGAL_TRANSITION: cannot ACCEPT a candidate carrying a terminal exception (UNAVAILABLE)',
    };
  }
  const nextState: ReviewState = decision === 'ACCEPT' ? 'ACCEPTED' : 'EXCLUDED';
  return {
    ok: true,
    candidate: {
      ...candidate,
      state: nextState,
      decision,
      reviewer: attribution.reviewer,
      reviewedAt: attribution.reviewedAt,
    },
  };
}

/**
 * The ONLY explicit path out of a decided state. Returns a decided candidate to an
 * undecided state (HELD if any exception remains, else PENDING), clearing the
 * decision and its attribution. Notes and exceptions are preserved. A fresh
 * `applyDecision` can then run. Reopening an undecided candidate is illegal.
 */
export function reopenForReview(candidate: ReviewCandidate): TransitionResult {
  if (!isDecided(candidate.state)) {
    return {
      ok: false,
      error: `ILLEGAL_TRANSITION: only a decided (ACCEPTED/EXCLUDED) candidate can be reopened; this one is ${candidate.state}`,
    };
  }
  return {
    ok: true,
    candidate: {
      ...candidate,
      state: initialReviewState(candidate.exceptions),
      decision: null,
      reviewer: null,
      reviewedAt: null,
    },
  };
}

/**
 * Attach (or clear, with `null`) a note. Metadata only: the state, decision and
 * attribution are untouched, so a note can never make a candidate eligible.
 */
export function addNote(candidate: ReviewCandidate, note: string | null): ReviewCandidate {
  return { ...candidate, note };
}

// ─── Ingestion eligibility ────────────────────────────────────────────────────

export type EligibilityResult = {
  eligible: boolean;
  /** Human-readable blockers; empty iff `eligible` is true. */
  blockers: string[];
};

/**
 * The pure gate deciding whether a candidate may proceed to FINAL ingestion.
 *
 * Eligible iff ALL hold:
 *   1. state === 'ACCEPTED';
 *   2. an explicit ACCEPT decision is recorded;
 *   3. no terminal exception (UNAVAILABLE) is present;
 *   4. a complete analysis exists (guards MISSING_ANALYSIS).
 *
 * Checks 3 and 4 are redundant for candidates built only through this module's
 * transitions, but they are kept as defence in depth so a hand-constructed or
 * future-persisted candidate can never slip through.
 */
export function evaluateIngestionEligibility(candidate: ReviewCandidate): EligibilityResult {
  const blockers: string[] = [];
  if (candidate.state !== 'ACCEPTED') {
    blockers.push(`state is ${candidate.state}, not ACCEPTED`);
  }
  if (candidate.decision !== 'ACCEPT') {
    blockers.push('no explicit ACCEPT decision is recorded');
  }
  if (hasTerminalException(candidate)) {
    blockers.push('a terminal exception (UNAVAILABLE) is present');
  }
  if (!candidate.hasCompleteAnalysis) {
    blockers.push('analysis is incomplete (MISSING_ANALYSIS)');
  }
  return { eligible: blockers.length === 0, blockers };
}

/** Convenience boolean form of {@link evaluateIngestionEligibility}. */
export function canProceedToIngestion(candidate: ReviewCandidate): boolean {
  return evaluateIngestionEligibility(candidate).eligible;
}
