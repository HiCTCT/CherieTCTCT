import { analyseStaticAd } from '@/lib/analysis/staticAnalyser';
import { analyseVideoAd } from '@/lib/analysis/videoAnalyser';
import type { AnalysisOutput } from '@/lib/analysis/types';
import type { ExampleRow } from '@/lib/data/manualExamples';

export function analyseAdRow(row: ExampleRow, format: 'STATIC' | 'VIDEO'): AnalysisOutput {
  if (format === 'VIDEO') {
    return analyseVideoAd({ row, format });
  }

  return analyseStaticAd({ row, format });
}
