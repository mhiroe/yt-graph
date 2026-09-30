import type { JudgeAdapter } from "./types.js";
import { JevJudge } from "./jev.js";
import { HeuristicJudge } from "./heuristic.js";

/**
 * Judge selection seam: YTG_JUDGE=jev | heuristic | auto (default).
 * auto uses jev when a key is configured, else the deterministic heuristic —
 * the night run must not stall on a missing credential.
 */
export function createJudgeAdapter(name = process.env.YTG_JUDGE ?? "auto"): JudgeAdapter {
  switch (name) {
    case "jev":
      return new JevJudge();
    case "heuristic":
      return new HeuristicJudge();
    case "auto":
      return JevJudge.available() ? new JevJudge() : new HeuristicJudge();
    default:
      throw new Error(`unknown judge adapter: ${name} (auto | jev | heuristic)`);
  }
}

export type { JudgeAdapter, JudgmentInput, JudgmentResult, Verdict } from "./types.js";
export { CRITERIA } from "./types.js";
