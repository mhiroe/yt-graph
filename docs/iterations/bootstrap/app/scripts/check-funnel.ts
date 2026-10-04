// Connectivity check for the staged funnel (fixture-only, stub ports — no
// live transcript/frame/VLM/LLM calls). Exercises: tier0 decide/escalate,
// transcript escalation, unwired-port stop, profile nudge vs neutral.
import { StagedJudge } from "../server/judgment/funnel.js";
import { createProfileAdapter } from "../server/profile/index.js";
import type { JudgmentInput, JudgmentResult } from "../server/judgment/types.js";

const seed = { id: "FIXSEED001", title: "Curious Kitchen Lab", fingerprint: ["fermentation", "science", "kitchen", "physics"] };

const mk = (id: string, title: string, description = "", sources = ["fixture"], subs = 0, vids = 0): JudgmentInput => ({
  candidate: { id, title, description, subscriberCount: subs, videoCount: vids },
  seed,
  sources,
});

const show = (label: string, r: JudgmentResult) => {
  const trace = (r.criteria.tiers as { tier: string; action: string; detail: string }[])
    .map((t) => `${t.tier}:${t.action}`)
    .join(" -> ");
  console.log(`${label}: ${r.verdict} score=${r.score.toFixed(2)} [${trace}]`);
};

// --- no ports wired, absent profile (auto -> off) ---
const bare = new StagedJudge();
show("strong overlap", await bare.judge(mk("A", "Fermentation science deep dive", "koji physics")));
show("no overlap", await bare.judge(mk("B", "Daily vlog", "lifestyle")));
show("review band, no ports", await bare.judge(mk("C", "Miso Lab", "home fermentation")));

// --- fixture profile nudge (topics match profile interests) ---
const withProfile = new StagedJudge({ profile: createProfileAdapter("fixture") });
show("profile fit (matching dna)", await withProfile.judge(mk("P1", "Everyday Chemistry", "safe chemistry experiments", ["fixture"], 780000, 200)));
show("profile fit (off-dna)", await withProfile.judge(mk("P2", "Crypto Hype Daily", "coin picks", ["fixture"], 410000, 600)));

// --- stub transcript port: borderline candidate escalates ---
const stubTranscript = {
  name: "stub-transcript",
  transcript: async () => "In this episode we test kitchen vacuum physics and yeast science.",
};
const withT1 = new StagedJudge({ transcript: stubTranscript });
show("escalate tier1 -> pass", await withT1.judge(mk("C", "Miso Lab", "home fermentation")));

// --- transcript empty -> climbs to unwired tier2 and stops ---
const emptyT1 = { name: "stub-empty", transcript: async () => null };
show("empty transcript", await new StagedJudge({ transcript: emptyT1 }).judge(mk("C", "Miso Lab", "home fermentation")));

// --- all ports stubbed: tier3 strong decides ---
const strong = {
  name: "stub-strong",
  judge: async () => ({ score: 0.9, verdict: "pass" as const, criteria: { by: "stub" }, judge: "stub-strong" }),
};
const full = new StagedJudge({
  transcript: { name: "t", transcript: async () => null },
  frames: { name: "f", frames: async () => ["frame1.png"] },
  vlm: { name: "v", describe: async () => null },
  strong,
});
show("full funnel -> tier3", await full.judge(mk("C", "Miso Lab", "home fermentation")));

// --- selection seam: staged resolves through YTG_JUDGE ---
const { createJudgeAdapter } = await import("../server/judgment/index.js");
console.log(`YTG_JUDGE seam: ${createJudgeAdapter("staged").name}`);
