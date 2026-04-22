import type { RaceStage, FunnelStage } from '@/lib/analysis/types';

export const QUALIFICATION_SCORE = 7.0;

export function clampScore(value: number): number {
  return Number(Math.max(0, Math.min(10, value)).toFixed(2));
}

export function scoreBySignals(text: string, positiveSignals: RegExp[], base = 6.0, increment = 0.9): number {
  let score = base;

  if (text.length > 120) {
    score += 0.4;
  }

  for (const signal of positiveSignals) {
    if (signal.test(text)) {
      score += increment;
    }
  }

  return clampScore(score);
}

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

export function deriveOverallScore(scores: number[]): number {
  const sum = scores.reduce((total, value) => total + value, 0);
  return clampScore(sum / scores.length);
}

export function qualifies(score: number): boolean {
  return score >= QUALIFICATION_SCORE;
}
