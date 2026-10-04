import type { DatabaseSync } from "node:sqlite";
import type { SourceAdapter, SourceChannel } from "../sources/index.js";
import { db as defaultDb, type ChannelRow } from "../db.js";
import { fingerprintFromTitles } from "./fingerprint.js";
import { cleanup, type RawHit } from "./cleanup.js";
import { insertEdge, insertEvidence, rejectedIds, upsertChannel } from "../store.js";

/**
 * Relation-edge kinds the walk can materialize (spec_product.md "discovery
 * strategy": collab / event・community / reference / influence /
 * behavioral-similarity). `event` has no adapter surface today — reported in
 * `unresolved_kinds` instead of being silently absent.
 */
export const RELATION_EDGE_KINDS = [
  "influence",
  "reference",
  "collab",
  "community",
  "behavioral",
  "event",
] as const;
export type RelationEdgeKind = (typeof RELATION_EDGE_KINDS)[number];

/** Frontier cap per walk — bounds adapter reads (serial, round-trip bound). */
const MAX_FRONTIER_NEIGHBORS = 8;
const MAX_COMMUNITY_PAIRS = 10;
/** Wide fingerprint for the behavioral overlap check (top-N per channel). */
const BEHAVIORAL_FP_TOP = 20;

export type EdgeWalkResult = {
  origin: { id: string; title: string };
  frontier: {
    id: string;
    title: string;
    via_edges: { id: number; kind: string; direction: "in" | "out" }[];
  }[];
  /** Relation edges actually created this pass (deduped against the store). */
  typed_edges: { src: string; dst: string; kind: string }[];
  /** Channels carrying walk provenance after cleanup — new and re-confirmed. */
  surfaced: {
    id: string;
    title: string;
    via: string[];
    edge_kinds: string[];
    was_known: boolean;
  }[];
  skipped: { id: string; reason: string }[];
  /** Relation kinds with no surface on the current adapter. */
  unresolved_kinds: string[];
};

type FrontierNode = {
  channel: ChannelRow;
  via_edges: { id: number; kind: string; direction: "in" | "out" }[];
};

/**
 * Relation-edge walk: traverse the stored resolved edges around a
 * seed/accepted origin, then extend one hop through each frontier channel's
 * relation surfaces (subscriptions = influence, playlist co-billing = collab,
 * playlist curation = reference, playlist co-membership = community,
 * fingerprint overlap = behavioral). Targets surface as candidates with
 * `edge_walk` evidence. No search/consult — search is the entry path only
 * (quota law), the walk is the graph-native expansion.
 */
export async function runEdgeWalk(
  adapter: SourceAdapter,
  originId: string,
  handle: DatabaseSync = defaultDb,
): Promise<EdgeWalkResult> {
  const origin = handle.prepare("select * from channel where id = ?").get(originId) as
    | ChannelRow
    | undefined;
  if (!origin) throw new Error(`walk origin not found: ${originId}`);

  const known = new Set(
    (handle.prepare("select id from channel").all() as unknown as { id: string }[]).map(
      (r) => r.id,
    ),
  );

  // Stored resolved edges touching the origin, both directions — the same
  // resolution the inspection aggregate performs.
  const neighborRows = handle
    .prepare(
      `select e.id as edge_id, e.kind as edge_kind, 'out' as direction, c.*
       from edge e join channel c on c.id = e.dst_channel_id
       where e.src_channel_id = ?
       union all
       select e.id, e.kind, 'in', c.*
       from edge e join channel c on c.id = e.src_channel_id
       where e.dst_channel_id = ?
       order by edge_id`,
    )
    .all(origin.id, origin.id) as unknown as (ChannelRow & {
    edge_id: number;
    edge_kind: string;
    direction: "in" | "out";
  })[];

  const byNeighbor = new Map<string, FrontierNode>();
  for (const row of neighborRows) {
    if (row.id === origin.id) continue;
    const node = byNeighbor.get(row.id) ?? { channel: row, via_edges: [] };
    node.via_edges.push({ id: row.edge_id, kind: row.edge_kind, direction: row.direction });
    byNeighbor.set(row.id, node);
  }
  const frontier: FrontierNode[] = [
    { channel: origin, via_edges: [] },
    ...[...byNeighbor.values()].slice(0, MAX_FRONTIER_NEIGHBORS),
  ];

  const typedEdges: EdgeWalkResult["typed_edges"] = [];
  const linkEdge = (src: string, dst: string, kind: string): void => {
    if (src === dst) return;
    const exists = handle
      .prepare(
        "select 1 from edge where src_channel_id = ? and dst_channel_id = ? and kind = ?",
      )
      .get(src, dst, kind);
    if (exists) return;
    insertEdge(src, dst, kind, handle);
    typedEdges.push({ src, dst, kind });
  };

  const hits = new Map<string, RawHit & { via: Set<string>; edge_kinds: Set<string> }>();
  const addHit = (
    channel: SourceChannel,
    via: string,
    edgeKind: RelationEdgeKind,
    extra: Record<string, unknown> = {},
  ): void => {
    const hit = hits.get(channel.id) ?? {
      channel,
      evidence: [],
      via: new Set<string>(),
      edge_kinds: new Set<string>(),
    };
    hit.evidence.push({ source: "edge_walk", detail: { via, edge_kind: edgeKind, ...extra } });
    hit.via.add(via);
    hit.edge_kinds.add(edgeKind);
    hits.set(channel.id, hit);
  };

  const uploadsFp = async (ch: { id: string; title: string; description?: string | null }) =>
    fingerprintFromTitles(
      [
        ch.title,
        ch.description ?? "",
        ...(await adapter.channelUploads(ch.id, BEHAVIORAL_FP_TOP)).map((v) => v.title),
      ].filter(Boolean),
      BEHAVIORAL_FP_TOP,
    );
  const originFp = await uploadsFp(origin);

  for (const node of frontier) {
    const x = node.channel;

    // influence: who x subscribes to shapes x's taste.
    for (const s of (await adapter.channelSubscriptions(x.id)).slice(0, 25)) {
      if (s.id === x.id) continue;
      const wasKnown = known.has(s.id);
      upsertChannel(s, "candidate", handle);
      linkEdge(x.id, s.id, "influence");
      addHit(s, x.id, "influence", { was_known: wasKnown });
    }

    // reference vs collab: a playlist mixing the owner's own videos with
    // foreign channels is shared billing (collab); a playlist of only foreign
    // channels is curation (reference). Co-listed foreign channels are a
    // community/event sphere — pairwise community edges, bounded.
    for (const pl of await adapter.channelPlaylists(x.id)) {
      const items = await adapter.playlistItems(pl.id);
      const foreignIds = [
        ...new Set(items.map((v) => v.channelId).filter((id) => id !== x.id)),
      ];
      const kind: RelationEdgeKind = items.some((v) => v.channelId === x.id)
        ? "collab"
        : "reference";
      const members: SourceChannel[] = [];
      for (const id of foreignIds) {
        const ch = await adapter.resolveChannel(id);
        if (!ch) continue;
        const wasKnown = known.has(ch.id);
        upsertChannel(ch, "candidate", handle);
        linkEdge(x.id, ch.id, kind);
        addHit(ch, x.id, kind, {
          playlist_id: pl.id,
          playlist_title: pl.title,
          co_members: foreignIds,
          was_known: wasKnown,
        });
        members.push(ch);
      }
      const sorted = members.map((m) => m.id).sort();
      let pairs = 0;
      for (let i = 0; i < sorted.length && pairs < MAX_COMMUNITY_PAIRS; i += 1) {
        for (let j = i + 1; j < sorted.length && pairs < MAX_COMMUNITY_PAIRS; j += 1) {
          linkEdge(sorted[i], sorted[j], "community");
          pairs += 1;
        }
      }
    }

    // behavioral: fingerprint overlap between a walked neighbor and the
    // origin annotates the existing relation (no new candidates — the
    // similar pair already sits on a stored edge).
    if (x.id !== origin.id) {
      const fp = await uploadsFp(x);
      const overlap = fp.filter((t) => originFp.includes(t));
      if (overlap.length > 0) {
        const outward = node.via_edges.some((e) => e.direction === "out");
        const [src, dst] = outward ? [origin.id, x.id] : [x.id, origin.id];
        linkEdge(src, dst, "behavioral");
        const hit = hits.get(x.id);
        if (hit) {
          hit.evidence.push({
            source: "edge_walk",
            detail: { via: origin.id, edge_kind: "behavioral", overlap },
          });
          hit.edge_kinds.add("behavioral");
        }
      }
    }
  }

  const { kept, dropped } = cleanup(
    [...hits.values()],
    origin.id,
    rejectedIds(handle),
  );
  for (const hit of kept) {
    for (const e of hit.evidence) {
      insertEvidence(
        {
          channelId: hit.channel.id,
          seedChannelId: origin.id,
          source: e.source,
          detail: e.detail,
        },
        handle,
      );
    }
  }
  const keptHits = kept.map(
    (hit) => hits.get(hit.channel.id) ?? { ...hit, via: new Set<string>(), edge_kinds: new Set<string>() },
  );

  return {
    origin: { id: origin.id, title: origin.title },
    frontier: frontier.map((n) => ({
      id: n.channel.id,
      title: n.channel.title,
      via_edges: n.via_edges,
    })),
    typed_edges: typedEdges,
    surfaced: keptHits.map((hit) => ({
      id: hit.channel.id,
      title: hit.channel.title,
      via: [...hit.via],
      edge_kinds: [...hit.edge_kinds],
      was_known: known.has(hit.channel.id),
    })),
    skipped: dropped,
    // `event` is the one relation kind with no derivation rule on the current
    // adapter surface (needs event/live signals); collab/community here are
    // playlist-derived approximations, noted in the module docstring.
    unresolved_kinds: ["event"],
  };
}
