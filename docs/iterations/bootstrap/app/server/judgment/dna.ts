import type { SourceChannel } from "../sources/index.js";
import { fingerprintFromTitles } from "../discovery/fingerprint.js";

/**
 * Channel Activity DNA — a deterministic signature of what a channel is and
 * how it publishes, computed only from metadata the cheap tiers already hold
 * (no extra fetches, no transcripts). Tier-0 input to the staged funnel and
 * to the DNA-vs-Curiosity-Profile fit.
 */
export type ChannelDna = {
  /** topic terms fingerprinted from the channel's own title + description */
  topics: string[];
  /** subscriberCount bucket — audience scale */
  scale: "small" | "mid" | "large";
  /** videoCount bucket — standing output volume as a cadence proxy */
  cadence: "sparse" | "steady" | "prolific";
};

export function channelDna(c: SourceChannel): ChannelDna {
  const subs = c.subscriberCount ?? 0;
  const vids = c.videoCount ?? 0;
  return {
    topics: fingerprintFromTitles([c.title, c.description ?? ""]),
    scale: subs < 50_000 ? "small" : subs < 500_000 ? "mid" : "large",
    cadence: vids < 50 ? "sparse" : vids < 300 ? "steady" : "prolific",
  };
}
