export type AdFormat = 'STATIC' | 'VIDEO';

export type FunnelStage = 'TOFU' | 'MOFU' | 'BOFU';

export type RaceStage = 'REACH' | 'ACT' | 'CONVERT' | 'ENGAGE';

// Trust Funnel stages (Schwartz awareness ladder)
export type TrustFunnelStage =
  | 'UNAWARE'
  | 'PROBLEM_AWARE'
  | 'SOLUTION_AWARE'
  | 'PRODUCT_AWARE'
  | 'READY_TO_BUY';

export type TriggerStrength = 'STRONG' | 'MODERATE' | 'WEAK' | 'MISSING';

export type BehaviouralTrigger = {
  name: string;
  strength: TriggerStrength;
};

export type AidaScores = {
  attention: number;
  interest: number;
  desire: number;
  action: number;
};

export type AidaExplanations = {
  attention: string;
  interest: string;
  desire: string;
  action: string;
};

export type Recommendations = {
  copy: string;
  headline: string;
  description: string;
  creative: string;
  conversionStrength: string;
};

export type RewriteDirection = {
  hook: string;
  body: string;
  cta: string;
  creativeDirection: string;
} | null;

export type FinalVerdict =
  | 'STRONG_READY_TO_TEST'
  | 'GOOD_NEEDS_SHARPENING'
  | 'CLEAR_IDEA_WEAK_SIGNALS'
  | 'TOO_VAGUE_MAJOR_REWORK'
  | 'INSUFFICIENT_INFORMATION';

export type ExampleRow = {
  Product: string;
  'Ad Link'?: string;
  Ad?: string;
  Copy?: string;
  Headline?: string;
  Description?: string;
  Analysis?: string;
  Improvement?: string;
  'Creative Analysis'?: string;
  'Creative Improvements'?: string;
  'Active Since'?: string;
  'Other Feedbacks'?: string;
};

// Kept for backwards compatibility — existing Prisma fields still use these keys
export type SubScores = {
  // Shared (both static and video)
  hookStopScroll: number;
  audienceRelevance: number;
  valueClarity: number;
  trustProofStrength: number;
  ctaClarity: number;

  // Static-specific (undefined for video)
  visualHierarchy?: number;
  productClarity?: number;
  offerClarity?: number;
  headlineStrength?: number;
  descriptionUsefulness?: number;
  ctaVisibility?: number;
  trustSignals?: number;

  // Video-specific (undefined for static)
  firstThreeSeconds?: number;
  soundOffDesign?: number;
  soundOnEnhancement?: number;
  onScreenText?: number;
  storyFlow?: number;
  authenticity?: number;
  platformNativeFeel?: number;
};

// Kept for backwards compatibility
export type AidaMapping = {
  attention: string;
  interest: string;
  desire: string;
  action: string;
};

export type AnalysisOutput = {
  // --- Backwards-compatible fields (kept, not removed) ---
  overallScore: number;
  qualified: boolean;
  subScores: SubScores;
  creativeAnalysis: string;
  copyAnalysis: string;
  headlineAnalysis: string;
  descriptionAnalysis: string;
  /** @deprecated Use aidaExplanations instead. Kept for backwards compatibility. */
  aida: AidaMapping;
  funnelStage: FunnelStage;
  raceStage: RaceStage;
  strengths: string[];
  weaknesses: string[];
  improvements: string[];

  // --- Phase 3.5: Conversion-focused scoring fields ---
  copyScore: number;
  headlineScore: number | null;       // null = headline not provided
  descriptionScore: number | null;    // null = description not provided
  creativeScore: number;

  aidaScores: AidaScores;
  aidaExplanations: AidaExplanations;

  clarityScore: number;
  connectionScore: number;
  convictionScore: number;

  trustFunnelStage: TrustFunnelStage;
  behaviouralTriggers: BehaviouralTrigger[];
  recommendations: Recommendations;
  rewriteDirection: RewriteDirection;  // null when all component scores >= 7
  finalVerdict: FinalVerdict;
};
