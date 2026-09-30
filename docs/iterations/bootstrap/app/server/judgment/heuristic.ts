import type { JudgeAdapter, JudgmentInput, JudgmentResult } from "./types.js";
import { verdictFor } from "./types.js";

/**
 * Deterministic credential-free fallback: fingerprint-keyword overlap plus a
 * small provenance bonus. Keeps the funnel moving when jev has no key/network.
 */
export class HeuristicJudge implements JudgeAdapter {
  readonly name = "heuristic";

  async judge(input: JudgmentInput): Promise<JudgmentResult> {
    const text = `${input.candidate.title} ${input.candidate.description ?? ""}`.toLowerCase();
    const overlap = input.seed.fingerprint.filter((t) => text.includes(t));
    // 1 hit ~0.4, 2 ~0.7, 3+ ~0.95; multi-source provenance adds a small bonus.
    const score = Math.min(1, overlap.length * 0.4 + (input.sources.length > 1 ? 0.15 : 0));
    return {
      score,
      verdict: verdictFor(score),
      criteria: { fingerprint_overlap: overlap, multi_source: input.sources.length > 1 },
      judge: this.name,
    };
  }
}
