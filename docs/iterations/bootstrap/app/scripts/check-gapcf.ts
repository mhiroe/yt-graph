// Subscription-gap CF check (fixture, in-memory DB): the pass finds
// similar viewers through comment authors, diffs their subscriptions
// against the account's own, and surfaces missing-edge candidates.
// Also verifies the seam is fail-soft when surfaces are absent.
// usage: tsx scripts/check-gapcf.ts
import { openDb } from "../server/db.js";
import { createSourceAdapter } from "../server/sources/index.js";
import type { SourceAdapter } from "../server/sources/index.js";
import { runDiscovery } from "../server/discovery/pipeline.js";
import { runSubscriptionGap } from "../server/discovery/gapcf.js";

process.env.YTG_CONSULT = "off";
const handle = openDb(":memory:");
const adapter = createSourceAdapter("fixture");

let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

const seed = (await adapter.resolveChannel("FIXSEED001"))!;
const gap = await runSubscriptionGap(adapter, seed);

check("similar viewers evaluated", gap.viewers.length === 3, `${gap.viewers.length}`);
const v1 = gap.viewers.find((v) => v.id === "FIXVIEW01");
check(
  "FIXVIEW01 overlap ~0.5 with gap ids",
  Boolean(v1 && v1.overlap === 0.5 && v1.gap_ids.includes("FIXGAP01") && v1.gap_ids.includes("FIXG01")),
  v1 ? `shared=${v1.shared.join("+")} gaps=${v1.gap_ids.join("+")}` : "missing",
);
const v3 = gap.viewers.find((v) => v.id === "FIXVIEW03");
check(
  "zero-overlap viewer skipped",
  Boolean(v3 && v3.skipped === "insufficient_overlap"),
);

// Multi-viewer gap = strongest signal: FIXGAP01 arrives via VIEW01+VIEW02.
const gapHit = gap.hits.find((h) => h.channel.id === "FIXGAP01");
check(
  "FIXGAP01 shared by 2 viewers",
  Boolean(gapHit && gapHit.evidence.length === 2),
  `${gapHit?.evidence.length ?? 0} evidence entries`,
);

// Fail-soft: adapters without the optional surfaces contribute nothing.
const bare: SourceAdapter = {
  name: "bare",
  resolveChannel: async () => null,
  channelUploads: async () => [],
  searchChannels: async () => [],
  channelSubscriptions: async () => [],
  channelPlaylists: async () => [],
  playlistItems: async () => [],
};
const bareGap = await runSubscriptionGap(bare, seed);
check(
  "no mySubscriptions -> empty + reported gap",
  bareGap.hits.length === 0 && bareGap.gaps.some((g) => g.includes("subscriptions.mine")),
  bareGap.gaps.join(";"),
);
const noComments: SourceAdapter = { ...bare, mySubscriptions: async () => [] };
const ncGap = await runSubscriptionGap(noComments, seed);
check(
  "no commentAuthorChannels -> empty + reported gap",
  ncGap.hits.length === 0 && ncGap.gaps.some((g) => g.includes("comment-author")),
  ncGap.gaps.join(";"),
);

// End-to-end through the pipeline: gap candidates land as persisted
// candidates carrying subscription_gap provenance.
const disc = await runDiscovery(adapter, "FIXSEED001", handle);
const gapKept = disc.kept.filter((k) => k.sources.includes("subscription_gap"));
check(
  "discovery kept gap candidates",
  gapKept.some((k) => k.id === "FIXGAP01") && gapKept.some((k) => k.id === "FIXG01"),
  gapKept.map((k) => k.id).join(","),
);
check(
  "gap_cf report present",
  Boolean(disc.gap_cf && disc.gap_cf.viewers === 3 && disc.gap_cf.candidates >= 3),
  JSON.stringify(disc.gap_cf),
);
const ev = handle
  .prepare(
    "select source, detail from discovery_evidence where channel_id = 'FIXGAP01' and source = 'subscription_gap'",
  )
  .all() as { source: string; detail: string }[];
check(
  "gap provenance persisted (2 viewer rows)",
  ev.length === 2 && ev.every((r) => JSON.parse(r.detail).via_viewer?.startsWith("FIXVIEW")),
  `${ev.length} rows`,
);

process.exit(failed ? 1 : 0);
