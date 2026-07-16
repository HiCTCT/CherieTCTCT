import type {
  AidaScores,
  BehaviouralTrigger,
  FinalVerdict,
  FunnelStage,
  RaceStage,
  Recommendations,
  RewriteDirection,
  TriggerStrength,
  TrustFunnelStage,
} from '@/lib/analysis/types';

export const QUALIFICATION_SCORE = 7.0;

export function clampScore(value: number): number {
  return Number(Math.max(0, Math.min(10, value)).toFixed(2));
}

// --- Kept for backwards compatibility with SubScores generation ---
// Base reduced from 6.0 to 4.0 to prevent inflation. Increment adjusted.
export function scoreBySignals(
  text: string,
  positiveSignals: RegExp[],
  base = 4.0,
  increment = 1.2,
): number {
  let score = base;

  for (const signal of positiveSignals) {
    if (signal.test(text)) {
      score += increment;
    }
  }

  return clampScore(score);
}

export function deriveOverallScore(scores: number[]): number {
  if (scores.length === 0) return 0;
  const sum = scores.reduce((total, value) => total + value, 0);
  return clampScore(sum / scores.length);
}

export function qualifies(score: number): boolean {
  return score >= QUALIFICATION_SCORE;
}

// --- Framework mapping (backwards compatible) ---
export function mapFunnelStage(copy: string): FunnelStage {
  if (/buy|book|start now|register|trial|sign up|enrol/i.test(copy)) return 'BOFU';
  if (/learn|discover|compare|why|how/i.test(copy)) return 'MOFU';
  return 'TOFU';
}

export function mapRaceStage(copy: string): RaceStage {
  if (/buy|checkout|book|register|start/i.test(copy)) return 'CONVERT';
  if (/community|follow|review|loyal|share/i.test(copy)) return 'ENGAGE';
  if (/learn|compare|explore|guide|demo/i.test(copy)) return 'ACT';
  return 'REACH';
}

// --- Phase 3.5: Conversion-focused scoring helpers ---

/**
 * Extracts numeric AIDA scores from human-written analysis text.
 * Looks for patterns like "Attention 9.2/10", "Interest 9/10", "Desire 9.3/10", "Action 8.5/10".
 * Returns null if all four scores cannot be reliably extracted.
 * These are the human analyst's own ratings — authoritative evidence.
 */
export function extractAnalysisAidaScores(analysisNotes: string): AidaScores | null {
  if (!analysisNotes || analysisNotes.trim().length < 20) return null;

  const extract = (label: string): number | null => {
    const pattern = new RegExp(`${label}\\s+(\\d+(?:\\.\\d+)?)\\s*/\\s*10`, 'i');
    const match = analysisNotes.match(pattern);
    if (match) return clampScore(parseFloat(match[1]));
    return null;
  };

  const attention = extract('Attention');
  const interest = extract('Interest');
  const desire = extract('Desire');
  const action = extract('Action');

  if (attention !== null && interest !== null && desire !== null && action !== null) {
    return { attention, interest, desire, action };
  }
  return null;
}

/**
 * Scores copy on conversion signals.
 * Starts at 2.0. Each confirmed signal adds points.
 * Works with or without human-written analysis notes.
 */
export function scoreCopyStrength(copy: string, analysisNotes: string): number {
  if (!copy || copy.trim().length < 10) return 1.0;

  const all = `${copy} ${analysisNotes}`;
  let score = 2.0;

  // Hook clarity
  if (/\?|stop|imagine|what if|you're|are you|tired|struggling|finally|instantly|immediately|irresistible/i.test(copy)) score += 0.7;

  // Audience specificity
  if (/for\s+(business|owner|manager|parent|marketer|brand|team|women|men|anyone who|company|companies|enterprise|startup|founder|creator|seller)/i.test(all) ||
      /if you|when you|you (want|need|have|feel|are)/i.test(copy)) score += 0.7;

  // Pain-point sharpness
  if (/problem|struggle|frustrat|fail|waste|miss|overwhelm|stress|pain|challeng/i.test(all)) score += 0.7;

  // Benefit clarity — specific, tangible outcome
  if (/save|increase|grow|boost|reduce|improve|get more|earn|double|results in|scale|expand|generate|convert|revenue|optimis|optimiz/i.test(all)) score += 0.7;

  // Offer clarity
  if (/free|trial|discount|% off|limited|bonus|includ|guarantee|no risk/i.test(all)) score += 0.6;

  // Proof or social evidence
  if (/\d+[\w\s]*(client|customer|brand|business|user|review|result|company|companies)|trusted|award|certified|case study|testimonial|Fortune|fortune 100|fortune 500|leader|leading|authority|industry/i.test(all)) score += 0.7;

  // Urgency or scarcity
  if (/today|now|limited|expir|last chance|only \d+|deadline|before/i.test(all)) score += 0.5;

  // CTA strength — specific action
  if (/book|start|get started|sign up|try|claim|register|shop now|learn more|download|apply/i.test(copy)) score += 0.7;

  // Objection handling
  if (/no (contract|commitment|risk|credit card)|cancel anytime|money.back|guaranteed/i.test(all)) score += 0.5;

  // Emotional pull
  if (/feel|transform|confidence|proud|peace|freedom|joy|excited|relief|imagine/i.test(copy)) score += 0.4;

  return clampScore(score);
}

/**
 * Scores headline on conversion intent.
 * Returns null if no headline is provided.
 */
export function scoreHeadlineStrength(headline: string | undefined): number | null {
  if (!headline || headline.trim().length < 3) return null;

  let score = 2.0;

  // Length sweet spot
  if (headline.length > 15 && headline.length < 100) score += 0.8;

  // Pain or desire hook
  if (/\?|stop|tired|finally|how to|why|secret|proven|the truth/i.test(headline)) score += 1.0;

  // Offer or outcome stated
  if (/save|get|boost|grow|earn|free|results|more|faster|better|smarter|scale|revenue/i.test(headline)) score += 1.0;

  // Specificity with numbers or named outcomes
  if (/\d+%|\d+x|\d+\s*(day|week|month|hour)|step|way/i.test(headline)) score += 0.8;

  // Conversion intent
  if (/start|try|book|claim|discover|learn|find out|see how/i.test(headline)) score += 0.8;

  // Audience relevance
  if (/you|your|for (business|team|brand|owner|parent|marketer|company|enterprise)/i.test(headline)) score += 0.6;

  return clampScore(score);
}

/**
 * Scores description on conversion support.
 * Returns null if no description is provided.
 */
export function scoreDescriptionStrength(description: string | undefined): number | null {
  if (!description || description.trim().length < 3) return null;

  let score = 2.0;

  // Adds benefit or detail beyond the headline
  if (description.length > 20) score += 0.6;

  // Proof or trust element
  if (/testimonial|review|trusted|\d+[\w\s]*(client|customer)|guarantee|certif/i.test(description)) score += 1.2;

  // Urgency or scarcity reinforcement
  if (/limited|today|now|expir|last chance|only/i.test(description)) score += 0.8;

  // Risk reducer
  if (/no (risk|commitment|contract)|cancel|money.back|free trial/i.test(description)) score += 1.0;

  // CTA support
  if (/click|tap|swipe|book|start|learn|get|apply/i.test(description)) score += 0.8;

  // Funnel-stage reinforcement
  if (/why|how|what you get|here.s what|includes/i.test(description)) score += 0.6;

  return clampScore(score);
}

/**
 * Scores creative on conversion signals from creative analysis text.
 * Falls back to analysisNotes when creativeAnalysis is absent — common when
 * Creative Analysis CSV column is empty but Analysis column has rich content.
 */
export function scoreCreativeStrength(
  creativeAnalysis: string,
  format: 'STATIC' | 'VIDEO',
  analysisNotes = '',
): number {
  // Use creativeAnalysis if present; fall back to analysisNotes
  const source = (creativeAnalysis && creativeAnalysis.trim().length >= 10)
    ? creativeAnalysis
    : analysisNotes;

  if (!source || source.trim().length < 10) return 2.5;

  const text = source.toLowerCase();
  let score = 2.0;

  // First-frame / stopping power
  if (/hook|stop.scroll|first.frame|attention|bold|striking|pattern interrupt|opening|commands|instantly|immediately|pop/i.test(text)) score += 0.7;

  // Visual clarity
  if (/clear|clean|simple|readable|legible|contrast|hierarchy|focal point|minimalist|polished|crisp|sharp/i.test(text)) score += 0.6;

  // Message-creative alignment
  if (/align|consistent|reinforce|support|match|reflect/i.test(text)) score += 0.6;

  // Audience recognition
  if (/relatable|recogni|audience|resonate|speak to|persona|target|engaging|vibrant|dynamic/i.test(text)) score += 0.6;

  // Emotional trigger in creative
  if (/emotion|feel|warm|trust|fear|excite|aspir|desire|transform|joy|laughter|authentic|genuine/i.test(text)) score += 0.6;

  // Proof and trust signals visible
  if (/logo|badge|testimonial|before.after|result|rating|proof|certif|social proof/i.test(text)) score += 0.7;

  // Offer visibility
  if (/offer|price|discount|free|cta|button|value|irresistible/i.test(text)) score += 0.6;

  if (format === 'VIDEO') {
    if (/reels|stories|ugc|vertical|native|authentic|real person|face|montage|sequence/i.test(text)) score += 0.6;
    if (/caption|subtitle|text overlay|sound.off|muted|on.screen|text on/i.test(text)) score += 0.6;
  } else {
    if (/cta|call to action|button|click|tap|swipe up/i.test(text)) score += 0.6;
    if (/frictionless|easy|simple|one.click|instant/i.test(text)) score += 0.4;
  }

  return clampScore(score);
}

/**
 * Derives AIDA scores from available ad inputs.
 * When analysisNotes contains explicit numeric AIDA scores written by a human analyst
 * (e.g. "Attention 9.2/10"), those scores are returned directly as authoritative evidence.
 * Otherwise, scores are computed from conversion signal patterns.
 */
export function scoreAida(
  copy: string,
  headline: string,
  creativeAnalysis: string,
  analysisNotes = '',
): AidaScores {
  // Use human analyst scores when available — more reliable than regex
  const extracted = extractAnalysisAidaScores(analysisNotes);
  if (extracted) return extracted;

  const all = `${copy} ${headline} ${creativeAnalysis} ${analysisNotes}`;

  let attention = 2.0;
  if (/\?|stop|imagine|finally|you're|are you|tired|hook|bold|striking|first frame|instantly|immediately|commands/i.test(all)) attention += 1.2;
  if (/pattern interrupt|contrast|unexpected|surprising/i.test(all)) attention += 0.8;
  if (headline && headline.trim().length > 10) attention += 0.8;
  if (/visual|creative|image|video|colour|color|design/i.test(all)) attention += 0.7;

  let interest = 2.0;
  if (/for\s+(business|owner|marketer|parent|brand|team|company|companies|enterprise|startup|founder)/i.test(all)) interest += 1.0;
  if (/if you|when you/i.test(all)) interest += 0.7;
  if (/problem|struggle|frustrat|challeng|pain point/i.test(all)) interest += 1.0;
  if (/product|service|solution|what (we|it) (does|offers|provides)/i.test(all)) interest += 0.8;
  if (/detail|explain|how it works|what you get/i.test(all)) interest += 0.7;

  let desire = 2.0;
  if (/save|grow|earn|boost|increase|reduce|improve|results|scale|revenue|generate/i.test(all)) desire += 1.0;
  if (/testimonial|proof|\d+\s*(client|customer|brand|result)|case study|Fortune|fortune 100|authority|leading/i.test(all)) desire += 1.0;
  if (/transform|freedom|confidence|peace|imagine|feel|joy|excitement/i.test(all)) desire += 0.7;
  if (/free|discount|bonus|guarantee|offer|trial/i.test(all)) desire += 0.8;

  let action = 2.0;
  if (/book|start|get started|sign up|try|claim|register|shop now|download|apply/i.test(all)) action += 1.2;
  if (/today|now|limited|expir|last chance|before/i.test(all)) action += 0.8;
  if (/no (risk|commitment|contract)|cancel|money.back|free trial/i.test(all)) action += 0.8;
  if (/one click|easy|simple|instant|quick/i.test(all)) action += 0.5;

  return {
    attention: clampScore(attention),
    interest: clampScore(interest),
    desire: clampScore(desire),
    action: clampScore(action),
  };
}

/**
 * Scores Clarity, Connection, and Conviction.
 * analysisNotes is included so that rich human analysis enriches the signal pool.
 */
export function scoreClarityConnectionConviction(
  copy: string,
  headline: string,
  description: string,
  analysisNotes = '',
): { clarity: number; connection: number; conviction: number } {
  const all = `${copy} ${headline} ${description} ${analysisNotes}`;

  let clarity = 2.0;
  if (copy.trim().length > 30) clarity += 0.8;
  if (/one (thing|benefit|offer|outcome|step)|simply|clearly|specifically|direct|straightforward|immediate|instantly|obvious|focused|concise|minimalist/i.test(all)) clarity += 0.8;
  if (headline && headline.trim().length > 10) clarity += 0.8;
  if (/what (you get|we do|it does|this means)|cta|call to action/i.test(all)) clarity += 0.8;

  let connection = 2.0;
  if (/you|your/i.test(copy)) connection += 0.8;
  if (/feel|struggle|tired|frustrated|overwhelm|problem|challenge|emotion|empathy/i.test(all)) connection += 1.0;
  if (/for (business owner|marketer|parent|team|anyone who|company|companies|enterprise|founder)/i.test(all)) connection += 0.8;
  if (/we (know|understand|get it)|been there/i.test(all)) connection += 0.8;
  if (/story|journey|before|after|relatable|resonat|authentic|joy|laughter|fun|experience|community|warm/i.test(all)) connection += 0.6;

  let conviction = 2.0;
  if (/\d+[\w\s]*(client|customer|brand|result|review)|testimonial|case study|Fortune|fortune 100|authority|leading|trusted by/i.test(all)) conviction += 1.2;
  if (/guarantee|certif|award|trusted|proven|data|study|strong|excellent|compelling|effective|perfectly|credible|exceptional|superior/i.test(all)) conviction += 1.0;
  if (/specific result|\d+%|\d+x|in \d+ (day|week|month)/i.test(all)) conviction += 0.8;
  if (/no (risk|commitment)|money.back|cancel anytime/i.test(all)) conviction += 0.7;

  return {
    clarity: clampScore(clarity),
    connection: clampScore(connection),
    conviction: clampScore(conviction),
  };
}

/**
 * Maps copy signals to Trust Funnel stage.
 */
export function mapTrustFunnelStage(copy: string, headline: string): TrustFunnelStage {
  const all = `${copy} ${headline}`;

  if (/buy now|get started|book|register|claim|checkout|start your|sign up today/i.test(all)) return 'READY_TO_BUY';
  if (/why (choose|us|this)|compare|vs\.|versus|better than|switch|alternative/i.test(all)) return 'PRODUCT_AWARE';
  if (/how (to|we|it works)|solution|result|what (you get|we offer)/i.test(all)) return 'SOLUTION_AWARE';
  if (/problem|struggle|frustrated|tired|challenge|do you feel|are you/i.test(all)) return 'PROBLEM_AWARE';
  return 'UNAWARE';
}

/**
 * Detects behavioural triggers in the ad.
 * analysisNotes is included so the human analyst's language can surface triggers.
 */
export function detectBehaviouralTriggers(
  copy: string,
  headline: string,
  creativeAnalysis: string,
  analysisNotes = '',
): BehaviouralTrigger[] {
  const all = `${copy} ${headline} ${creativeAnalysis} ${analysisNotes}`;

  function strength(pattern: RegExp): TriggerStrength {
    const matches = (all.match(new RegExp(pattern.source, `g${pattern.flags.replace('g', '')}`)) ?? []).length;
    if (matches >= 2) return 'STRONG';
    if (matches === 1) return 'MODERATE';
    return 'MISSING';
  }

  return [
    { name: 'FOMO', strength: strength(/miss out|limited|running out|last chance|only \d+|expir|before it.s gone/i) },
    // "now" alone is NOT urgency — "Shop now" is a CTA and "now available" is not
    // time pressure. Bare "today"/"this week" are equally weak. Require an explicit
    // deadline / time-pressure construction; otherwise report MISSING.
    { name: 'Urgency', strength: strength(/\b(?:deadline|hurry|act fast|act now|limited time|last day|final hours|closing soon|order by|today only|this week only|ends (?:today|tonight|soon))\b/i) },
    { name: 'Social proof', strength: strength(/\d+[\w\s]*(client|customer|brand|business|review|user)|trusted by|as seen|Fortune|testimonial/i) },
    { name: 'Authority', strength: strength(/award|certif|expert|proven|industry|leader|accredited|recognised|fortune 100|fortune 500|authority/i) },
    // A lone "before" (or "after") is NOT a before/after claim. Require BOTH sides of
    // a genuine comparison in proximity, or an explicit transformation construction.
    { name: 'Before and after', strength: strength(/\bbefore\b[\s\S]{0,60}\bafter\b|\bafter\b[\s\S]{0,60}\bbefore\b|\bused to\b[\s\S]{0,60}\b(?:now|today)\b|\bwas\b[\s\S]{0,40}\bnow\b|\btransform(?:s|ed|ing|ation)?\b/i) },
    { name: 'Risk reduction', strength: strength(/no (risk|commitment|contract)|money.back|guarantee|cancel anytime|free trial/i) },
    { name: 'Convenience', strength: strength(/easy|simple|one.click|instant|quick|no hassle|effortless|done for you/i) },
    { name: 'Value', strength: strength(/save|free|bonus|value|included|worth|\$ off|% off|discount/i) },
    // Unanchored "lose"/"miss"/"fail" also matched INSIDE ordinary words ("close",
    // "mission", "dismiss", "failure"). Require a word-bounded construction that names
    // actual loss, risk, harm, cost or a missed opportunity. Bare "don't let" is NOT
    // evidence ("don't let the paint dry"), and bare "don't miss" is ambiguous.
    { name: 'Fear of loss', strength: strength(/\b(?:miss(?:ing)? out|don.t lose|lose (?:your|out|access)|losing (?:your|out|access)|risk losing|at risk|falling behind|left behind|costly mistake|avoid (?:a |an )?costly|protect your \w+|before you lose)\b/i) },
    { name: 'Curiosity', strength: strength(/secret|discover|find out|what (most|nobody)|you didn.t know|surprising/i) },
    // "premium"/"top"/"best"/"leading" are ordinary product styling, not status
    // signalling — and unanchored "top" matched inside "stop"/"scroll-stopping"/"laptop".
    // Require an explicit, word-bounded status cue.
    { name: 'Status', strength: strength(/\b(?:exclusive|exclusively|elite|vip|first class|members only|invitation only|prestige)\b/i) },
    // "join"/"together"/"network"/"members" alone are not belonging, and a generic
    // "join us/our/the <anything>" CTA ("join us today", "join our newsletter",
    // "join the waitlist") is not evidence either. Require an explicit community /
    // membership construction. Missing an ambiguous phrase is safer than asserting one.
    { name: 'Belonging', strength: strength(/(?:\bjoin (?:us|our|the)\s+(?:community|family|club|tribe|movement|circle)\b|\bwelcome to the (?:family|community|club|tribe)\b|\byou belong (?:here|with us)\b|\bbecome (?:a |an )?member of (?:our|the) \w+|\bmembers only\b|\bour (?:community|club|tribe)\b|\blike.minded\b|\bpart of (?:our|the) (?:community|family|club|tribe)\b)/i) },
    { name: 'Relief', strength: strength(/relief|finally|no more|stop (worrying|struggling)|peace of mind|stress.free/i) },
    { name: 'Instant gratification', strength: strength(/instantly|immediately|right now|in minutes|today|same day/i) },
    { name: 'Contrast', strength: strength(/vs\.|versus|unlike|compared to|instead of|better than|while others/i) },
  ];
}

/**
 * Derives the final conversion verdict.
 *
 * Rules (in evaluation order):
 * 1. INSUFFICIENT_INFORMATION — both copy AND creative are near-zero (<3.0). Not enough to judge.
 * 2. TOO_VAGUE_MAJOR_REWORK   — either core signal (copy or creative) is broken (<3.0),
 *                               OR overall is very weak (<5.5). Ad needs fundamental rebuilding.
 * 3. STRONG_READY_TO_TEST     — overall ≥8.0 AND every component score ≥7.0.
 * 4. GOOD_NEEDS_SHARPENING    — overall ≥7.0 and core signals are intact. Qualifiable ad.
 * 5. CLEAR_IDEA_WEAK_SIGNALS  — overall 5.5–6.99, core signals intact. Concept present,
 *                               conversion evidence insufficient to qualify.
 * 6. TOO_VAGUE_MAJOR_REWORK   — fallthrough for overall <5.5 with intact core signals.
 *
 * Consistency guarantee: an ad with overallScore ≥7.0 will NEVER receive
 * TOO_VAGUE_MAJOR_REWORK unless a core signal is broken.
 */
export function deriveFinalVerdict(
  copyScore: number,
  headlineScore: number | null,
  descriptionScore: number | null,
  creativeScore: number,
  overallScore: number,
): FinalVerdict {
  // Rule 1: neither primary signal carries usable information
  if (copyScore < 3.0 && creativeScore < 3.0) return 'INSUFFICIENT_INFORMATION';

  // Rule 2a: a core signal is fundamentally broken — copy or creative near-zero
  const coreSignalBroken = copyScore < 3.0 || creativeScore < 3.0;
  if (coreSignalBroken) return 'TOO_VAGUE_MAJOR_REWORK';

  // From here, both copy and creative are functional (≥3.0)
  const componentScores = [copyScore, creativeScore];
  if (headlineScore !== null) componentScores.push(headlineScore);
  if (descriptionScore !== null) componentScores.push(descriptionScore);

  const allAbove7 = componentScores.every((s) => s >= 7.0);

  // Rule 3: all elements are strong
  if (overallScore >= 8.0 && allAbove7) return 'STRONG_READY_TO_TEST';

  // Rule 4: overall qualifies — some elements need work but foundation is real
  if (overallScore >= 7.0) return 'GOOD_NEEDS_SHARPENING';

  // Rule 5: concept is there but conversion evidence falls short of threshold
  if (overallScore >= 5.5) return 'CLEAR_IDEA_WEAK_SIGNALS';

  // Rule 2b: overall too weak even with functional core signals
  return 'TOO_VAGUE_MAJOR_REWORK';
}

/**
 * Derives per-element recommendations. Specific, not generic.
 */
export function deriveRecommendations(
  copyScore: number,
  headlineScore: number | null,
  descriptionScore: number | null,
  creativeScore: number,
  improvementNotes: string,
  creativeImprovementNotes: string,
): Recommendations {
  const copyRec =
    improvementNotes && improvementNotes.trim().length > 10
      ? improvementNotes
      : copyScore < 5
        ? 'Rewrite the hook to open with a sharp pain point or bold outcome statement. Add one specific proof element (number, client count, or named result). End with a single, direct CTA tied to the offer.'
        : copyScore < 7
          ? 'Strengthen the hook and add proof. Make the benefit statement more specific with numbers or named outcomes. Ensure the CTA names the exact next step.'
          : 'Sharpen urgency. Add one objection handler. Test a pain-led vs. outcome-led opening.';

  const headlineRec =
    headlineScore === null
      ? 'Headline not captured from the Meta Ad Library page.'
      : headlineScore < 5
        ? 'The headline lacks clarity and conversion intent. Rewrite to lead with the single most important outcome or pain point. Use numbers or specifics where possible.'
        : headlineScore < 7
          ? 'The headline is present but not sharp enough. Test a more specific benefit-led version with a number, a timeframe, or a named outcome.'
          : 'Headline is working. Test one alternative that leads with a question or named pain to compare engagement rates.';

  const descriptionRec =
    descriptionScore === null
      ? 'No description provided. Add 1–2 sentences that reinforce the offer, add proof, or reduce hesitation.'
      : descriptionScore < 5
        ? 'Description is weak. Rewrite to add something the headline and copy did not — proof, a risk reducer, or a secondary benefit.'
        : descriptionScore < 7
          ? 'Description supports the ad but could be stronger. Add one trust signal or urgency element.'
          : 'Description is functional. Test adding a specific number or testimonial snippet.';

  const creativeRec =
    creativeImprovementNotes && creativeImprovementNotes.trim().length > 10
      ? creativeImprovementNotes
      : creativeScore < 5
        ? 'Creative lacks conversion signals. Ensure the first frame communicates the offer immediately. Add visible trust signals and a clear CTA overlay.'
        : creativeScore < 7
          ? 'Creative is adequate but not conversion-optimised. Improve visual hierarchy so the offer is dominant. Test a before/after or result-focused visual.'
          : 'Creative is functional. Test a UGC-style or face-forward variant to compare authenticity against polished creative.';

  return {
    copy: copyRec,
    headline: headlineRec,
    description: descriptionRec,
    creative: creativeRec,
    conversionStrength:
      'To strengthen conversion: (1) Ensure one clear offer is visible in copy and creative. (2) Add a specific proof element. (3) Make the CTA name the exact action and outcome. (4) Reduce friction with a risk reducer. (5) Test urgency against benefit-led framing.',
  };
}

/**
 * Derives rewrite direction when any component score is below 7.
 * Returns null when all components score >= 7.
 */
export function deriveRewriteDirection(
  copyScore: number,
  headlineScore: number | null,
  descriptionScore: number | null,
  creativeScore: number,
  copy: string,
  funnelStage: string,
): RewriteDirection {
  const scoresBelow7 = [
    copyScore < 7,
    headlineScore !== null && headlineScore < 7,
    descriptionScore !== null && descriptionScore < 7,
    creativeScore < 7,
  ].some(Boolean);

  if (!scoresBelow7) return null;

  const stageLabel =
    funnelStage === 'BOFU'
      ? 'bottom-of-funnel (conversion)'
      : funnelStage === 'MOFU'
        ? 'middle-of-funnel (consideration)'
        : 'top-of-funnel (awareness)';

  const hasProof = /\d+[\w\s]*(client|customer)|testimonial|case study|Fortune/i.test(copy);
  const hasBenefit = /save|grow|earn|boost|increase|results|scale|revenue/i.test(copy);
  const hasUrgency = /today|now|limited|expir/i.test(copy);

  return {
    hook: `Open with a sharp, specific pain point or bold outcome for a ${stageLabel} audience. The first line must earn the scroll.`,
    body: `${hasBenefit ? 'Build on the benefit already present — make it more specific with a number or timeframe.' : 'Add a clear, specific benefit statement with a measurable outcome.'} ${hasProof ? 'Amplify the existing proof with more specificity.' : 'Add at least one proof element: a client count, result, or testimonial snippet.'} ${hasUrgency ? 'Urgency is present — ensure it is tied to a real reason.' : 'Add a time-bound or scarcity-based reason to act now.'}`,
    cta: `Use a single, direct CTA naming the exact action and outcome. Match the strength to the ${stageLabel} stage.`,
    creativeDirection:
      'Ensure the first frame or dominant visual states the core offer or outcome immediately. Add a visible trust signal. If video, ensure it works sound-off. If static, ensure the offer and CTA are dominant visual elements.',
  };
}
