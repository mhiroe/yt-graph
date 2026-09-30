import type { SourceChannel } from "../sources/index.js";

/** Context a judge scores a candidate against. */
export type JudgmentInput = {
  candidate: SourceChannel;
  seed: { id: string; title: string; fingerprint: string[] };
  /** provenance sources the candidate arrived through */
  sources: string[];
};

export type Verdict = "pass" | "review" | "drop";

export type JudgmentResult = {
  score: number;             // interestingness — heuristic is 0..1, jev may exceed 1
  verdict: Verdict;
  criteria: Record<string, unknown>; // per-criterion detail from the judge
  judge: string;             // adapter name — stored on the judgment row
};

/** Swappable judgment layer (jev CLI / heuristic / future). */
export interface JudgeAdapter {
  readonly name: string;
  judge(input: JudgmentInput): Promise<JudgmentResult>;
}

/** The four user-confirmed interestingness criteria (2026-09-28). */
export const CRITERIA = [
  "relevance: topical overlap with the seed channel",
  "novelty: brings something new vs the seed",
  "signal_density: dense useful content, not noise",
  "distinctiveness: distinct voice or niche, not generic",
] as const;

export function verdictFor(score: number): Verdict {
  if (score >= 0.5) return "pass";
  if (score >= 0.3) return "review";
  return "drop";
}
