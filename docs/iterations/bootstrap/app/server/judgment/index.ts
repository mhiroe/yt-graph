import type { JudgeAdapter } from "./types.js";
import { JevJudge } from "./jev.js";
import { HeuristicJudge } from "./heuristic.js";
import { StagedJudge } from "./funnel.js";

/**
 * Judge selection seam: YTG_JUDGE=jev | heuristic | staged | auto (default).
 * auto uses jev when a key is configured, else the deterministic heuristic —
 * the night run must not stall on a missing credential.
 * staged runs the Tier0-3 funnel (funnel.ts): metadata first, upper tiers
 * escalate only while inconclusive; no upper-tier ports are wired by default.
 */
export function createJudgeAdapter(name = process.env.YTG_JUDGE ?? "auto"): JudgeAdapter {
  switch (name) {
    case "jev":
      return new JevJudge();
    case "heuristic":
      return new HeuristicJudge();
    case "staged":
      return new StagedJudge();
    case "auto":
      return JevJudge.available() ? new JevJudge() : new HeuristicJudge();
    default:
      throw new Error(`unknown judge adapter: ${name} (auto | jev | heuristic | staged)`);
  }
}

export type { JudgeAdapter, JudgmentInput, JudgmentResult, Verdict } from "./types.js";
export { CRITERIA } from "./types.js";
