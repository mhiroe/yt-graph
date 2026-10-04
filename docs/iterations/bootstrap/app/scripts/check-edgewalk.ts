// Edge-walk check (fixture, in-memory DB): discover a seed, reject one
// candidate, then walk the stored edges — typed relation edges must
// materialize around the seed and the walk must surface hop-2 channels.
// usage: tsx scripts/check-edgewalk.ts
import { openDb, listEdges } from "../server/db.js";
import { createSourceAdapter } from "../server/sources/index.js";
import { runDiscovery } from "../server/discovery/pipeline.js";
import { runEdgeWalk } from "../server/discovery/edgewalk.js";
import { insertDecision } from "../server/store.js";

process.env.YTG_CONSULT = "off"; // walk must be the only path to FIXG01
const handle = openDb(":memory:");
const adapter = createSourceAdapter("fixture");

let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

await runDiscovery(adapter, "FIXSEED001", handle);
insertDecision({ channelId: "FIXN01", decision: "reject" }, handle);

const walk = await runEdgeWalk(adapter, "FIXSEED001", handle);

const edgeKeys = new Set(
  listEdges(handle).map(
    (e) => `${e.src_channel_id}->${e.dst_channel_id}:${e.kind}`,
  ),
);

check("walk origin is the seed", walk.origin.id === "FIXSEED001");
check(
  "frontier walked the stored neighbors",
  walk.frontier.length >= 8,
  `${walk.frontier.length} frontier nodes`,
);

// Relation typing on the seed's own neighborhood.
for (const [edge, label] of [
  ["FIXSEED001->FIXSUB01:influence", "subscription edge -> influence"],
  ["FIXSEED001->FIXPL01:reference", "curation playlist -> reference"],
  ["FIXSEED001->FIXS01:collab", "co-billed playlist -> collab"],
  ["FIXSEED001->FIXPL03:behavioral", "fingerprint overlap -> behavioral"],
  ["FIXS01->FIXS02:community", "playlist co-membership -> community"],
] as const) {
  check(label, edgeKeys.has(edge), edge);
}

// Hop-2 path: FIXG01 sits behind FIXPL03's subscriptions — the walk types
// that edge `influence` and surfaces the channel through the neighbor.
const g01 = walk.surfaced.find((s) => s.id === "FIXG01");
check(
  "walk surfaced hop-2 channel FIXG01",
  Boolean(g01 && g01.via.includes("FIXPL03") && g01.edge_kinds.includes("influence")),
  g01 ? `via ${g01.via.join("+")} [${g01.edge_kinds.join("+")}]` : "not surfaced",
);
check(
  "hop-2 edge materialized",
  edgeKeys.has("FIXPL03->FIXG01:influence"),
);

// Rejected channels stay routed — not re-surfaced by the walk.
check(
  "rejected channel not re-surfaced",
  walk.skipped.some((s) => s.id === "FIXN01" && s.reason === "already_rejected"),
);
check(
  "event kind reported as unresolved surface",
  walk.unresolved_kinds.includes("event"),
);

// Idempotent: a second walk creates no duplicate edges.
const again = await runEdgeWalk(adapter, "FIXSEED001", handle);
check(
  "re-walk is idempotent (no new typed edges)",
  again.typed_edges.length === 0,
  `${again.typed_edges.length} new`,
);

process.exit(failed ? 1 : 0);
