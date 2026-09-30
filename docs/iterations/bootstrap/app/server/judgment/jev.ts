import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CRITERIA, verdictFor, type JudgeAdapter, type JudgmentInput, type JudgmentResult } from "./types.js";

type JevResponse = {
  answers?: Record<string, {
    type: string;
    score?: number;
    legend?: Record<string, string>;
    probabilities?: Record<string, number>;
    confidence?: number;
  }>;
  error?: { message?: string };
};

function jevAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY) ||
    existsSync(join(homedir(), ".config", "openrouter", "key"));
}

function callJev(request: unknown, timeoutMs = 25000): Promise<JevResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn("jev", ["--nolog", "--tag", "yt-graph"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("jev timeout"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`jev exited ${code}: ${err.trim()}`));
      try {
        resolve(JSON.parse(out) as JevResponse);
      } catch {
        reject(new Error(`jev: bad json: ${out.slice(0, 200)}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** jev CLI adapter — one score call per candidate, four user criteria. */
export class JevJudge implements JudgeAdapter {
  readonly name = "jev";

  static available(): boolean {
    return jevAvailable();
  }

  async judge(input: JudgmentInput): Promise<JudgmentResult> {
    const c = input.candidate;
    const state = [
      `Seed channel: ${input.seed.title} (fingerprint: ${input.seed.fingerprint.join(", ") || "n/a"})`,
      `Candidate: ${c.title}${c.handle ? ` ${c.handle}` : ""} — ${c.description ?? "no description"}` +
        (c.subscriberCount ? `, ${c.subscriberCount} subscribers` : ""),
      `Arrived via: ${input.sources.join(", ")}`,
    ].join("\n");
    const res = await callJev({
      state,
      questions: {
        interesting: {
          type: "score",
          instructions: "Score how interesting this candidate channel is for a viewer of the seed channel.",
          criteria: [...CRITERIA],
        },
      },
    });
    const a = res.answers?.interesting;
    if (a?.score === undefined) {
      throw new Error(`jev: no score in response: ${JSON.stringify(res).slice(0, 200)}`);
    }
    const legend = a.legend ?? {};
    const criteria: Record<string, unknown> = { confidence: a.confidence };
    for (const [idx, prob] of Object.entries(a.probabilities ?? {})) {
      const name = legend[idx]?.split(":")[0] ?? `criterion_${idx}`;
      criteria[name] = prob;
    }
    return { score: a.score, verdict: verdictFor(a.score), criteria, judge: this.name };
  }
}
