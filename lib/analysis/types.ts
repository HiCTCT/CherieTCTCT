export type AdFormat = 'STATIC' | 'VIDEO';

export type FunnelStage = 'TOFU' | 'MOFU' | 'BOFU';

export type RaceStage = 'REACH' | 'ACT' | 'CONVERT' | 'ENGAGE';

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

export type AidaMapping = {
  attention: string;
  interest: string;
  desire: string;
  action: string;
};

export type AnalysisOutput = {
  overallScore: number;
  qualified: boolean;
  subScores: SubScores;
  creativeAnalysis: string;
  copyAnalysis: string;
  headlineAnalysis: string;
  descriptionAnalysis: string;
  aida: AidaMapping;
  funnelStage: FunnelStage;
  raceStage: RaceStage;
  strengths: string[];
  weaknesses: string[];
  improvements: string[];
};
