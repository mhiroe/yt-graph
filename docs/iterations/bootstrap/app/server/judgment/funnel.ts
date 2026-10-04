import { verdictFor, type JudgeAdapter, type JudgmentInput, type JudgmentResult } from "./types.js";
import { channelDna, type ChannelDna } from "./dna.js";
import {
  createProfileAdapter,
  profileFit,
  PROFILE_FIT_NEUTRAL,
  type ProfileAdapter,
} from "../profile/index.js";

/**
 * Upper-tier ports — the funnel's boundary to material it cannot fetch
 * itself. Every port is optional: an unwired or empty port means the funnel
 * stops at the last decisive tier, never stalls. Real transcript/frame/VLM/
 * LLM implementations live behind these and are not exercised by default
 * wiring (YTG_JUDGE=staged wires none of them).
 */

/** Tier 1: transcript text of a channel's representative uploads. */
export interface TranscriptPort {
  readonly name: string;
  /** Transcript text, or null when none is obtainable. */
  transcript(channelId: string): Promise<string | null>;
}

/** Tier 2: sampled frames from representative uploads (refs, not pixels). */
export interface FramePort {
  readonly name: string;
  frames(channelId: string): Promise<string[]>;
}

/** Tier 2: a VLM summarizing sampled frames into text. */
export interface VlmPort {
  readonly name: string;
  describe(frames: string[]): Promise<string | null>;
}

/** Tier 3: a strong LLM/VLM making the final call with the trace so far. */
export interface StrongJudgePort {
  readonly name: string;
  judge(input: JudgmentInput, prior: TierRecord[]): Promise<JudgmentResult>;
}

export type TierName = "tier0_metadata" | "tier1_transcript" | "tier2_vlm" | "tier3_strong";

/** One tier's outcome in the funnel trace (recorded into criteria.tiers). */
export type TierRecord = {
  tier: TierName;
  score: number;
  verdict: string;
  /** "final" = funnel stopped here; "escalated" = inconclusive, moved up */
  action: "final" | "escalated";
  detail: string;
};

export type StagedJudgeDeps = {
  /** Curiosity-profile source (t-01M3RZVV3E seam); absent profile = neutral. */
  profile?: ProfileAdapter;
  transcript?: TranscriptPort;
  frames?: FramePort;
  vlm?: VlmPort;
  strong?: StrongJudgePort;
};

/** Weight of the profile nudge at tier 0: fit 1 -> +0.2, fit 0 -> -0.2. */
const PROFILE_NUDGE = 0.4;
/** Each extra seed-fingerprint term confirmed in upper-tier material. */
const TIER_HIT_BONUS = 0.15;

function countHits(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((t) => lower.includes(t));
}

/**
 * Staged evaluation funnel: Tier 0 metadata -> Tier 1 transcript -> Tier 2
 * sampled frames / VLM -> Tier 3 strong model. Cheap tiers run first and
 * decide most candidates; escalation happens only while the verdict sits in
 * the review band (verdictFor -> "review") and the next tier's port is wired.
 */
export class StagedJudge implements JudgeAdapter {
  readonly name = "staged";
  private readonly deps: StagedJudgeDeps;

  constructor(deps: StagedJudgeDeps = {}) {
    this.deps = deps;
  }

  async judge(input: JudgmentInput): Promise<JudgmentResult> {
    const profile = await (this.deps.profile ?? createProfileAdapter()).profile();
    const dna = channelDna(input.candidate);
    const fit = profileFit(profile, dna.topics);

    // Tier 0: metadata only — heuristic overlap + provenance + profile nudge.
    const text = `${input.candidate.title} ${input.candidate.description ?? ""}`;
    const overlap = countHits(text, input.seed.fingerprint);
    let score = Math.min(
      1,
      Math.max(
        0,
        overlap.length * 0.4 + (input.sources.length > 1 ? 0.15 : 0) +
          (fit - PROFILE_FIT_NEUTRAL) * PROFILE_NUDGE,
      ),
    );
    const confirmed = new Set(overlap);
    const tiers: TierRecord[] = [];
    const record = (tier: TierName, action: TierRecord["action"], detail: string): void => {
      tiers.push({ tier, score, verdict: verdictFor(score), action, detail });
    };

    record(
      "tier0_metadata",
      verdictFor(score) === "review" && this.deps.transcript ? "escalated" : "final",
      `overlap=${overlap.length} fit=${fit.toFixed(2)}` +
        (verdictFor(score) === "review" && !this.deps.transcript ? "; no transcript port" : ""),
    );

    // Tier 1: transcript — only while inconclusive and the port is wired.
    if (tiers[0].action === "escalated") {
      const tr = await this.deps.transcript!.transcript(input.candidate.id);
      if (tr === null) {
        record("tier1_transcript", "escalated", "no transcript data");
      } else {
        const hits = countHits(tr, input.seed.fingerprint).filter((t) => !confirmed.has(t));
        hits.forEach((t) => confirmed.add(t));
        score = Math.min(1, score + hits.length * TIER_HIT_BONUS);
        record(
          "tier1_transcript",
          verdictFor(score) === "review" ? "escalated" : "final",
          `transcript hits: ${hits.join(", ") || "none"}`,
        );
      }
    }

    // Tier 2: sampled frames + VLM — needs both ports; boundary only.
    if (tiers[tiers.length - 1].action === "escalated") {
      const { frames, vlm } = this.deps;
      if (!frames || !vlm) {
        record("tier2_vlm", "final", "frames/vlm port not wired");
      } else {
        const desc = await vlm.describe(await frames.frames(input.candidate.id));
        if (desc === null) {
          record("tier2_vlm", "escalated", "vlm returned no description");
        } else {
          const hits = countHits(desc, input.seed.fingerprint).filter((t) => !confirmed.has(t));
          hits.forEach((t) => confirmed.add(t));
          score = Math.min(1, score + hits.length * TIER_HIT_BONUS);
          record(
            "tier2_vlm",
            verdictFor(score) === "review" ? "escalated" : "final",
            `vlm hits: ${hits.join(", ") || "none"}`,
          );
        }
      }
    }

    // Tier 3: strong model — delegated judgment, boundary only.
    if (tiers[tiers.length - 1].action === "escalated") {
      if (!this.deps.strong) {
        record("tier3_strong", "final", "strong port not wired");
      } else {
        const res = await this.deps.strong.judge(input, tiers);
        score = res.score;
        record("tier3_strong", "final", `delegated to ${this.deps.strong.name}`);
        res.criteria = { ...res.criteria, tiers };
        res.judge = this.name;
        return res;
      }
    }

    const last = tiers[tiers.length - 1];
    return {
      score: last.score,
      verdict: verdictFor(last.score),
      criteria: {
        tiers,
        dna,
        profile_fit: fit,
        profile: profile === null ? "absent" : (profile.provenance ?? "present"),
        confirmed_terms: [...confirmed],
      },
      judge: this.name,
    };
  }
}
