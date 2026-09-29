import type { DatabaseSync } from "node:sqlite";
import type { SourceChannel } from "./sources/index.js";
import { db as defaultDb } from "./db.js";

/** Insert a channel or refresh last_seen_at; status only moves forward explicitly. */
export function upsertChannel(
  ch: SourceChannel,
  status: "seed" | "candidate" = "candidate",
  handle: DatabaseSync = defaultDb,
): void {
  handle
    .prepare(
      `insert into channel (id, title, handle, description, url, status)
       values (?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         title = excluded.title,
         handle = excluded.handle,
         description = excluded.description,
         url = excluded.url,
         status = case
           when channel.status in ('accepted', 'rejected', 'later', 'seed') then channel.status
           else excluded.status
         end,
         last_seen_at = datetime('now')`,
    )
    .run(ch.id, ch.title, ch.handle ?? null, ch.description ?? null, ch.url ?? null, status);
}

export function insertEvidence(
  e: { channelId: string; seedChannelId?: string; source: string; detail?: unknown },
  handle: DatabaseSync = defaultDb,
): void {
  handle
    .prepare(
      `insert into discovery_evidence (channel_id, seed_channel_id, source, detail)
       values (?, ?, ?, ?)`,
    )
    .run(e.channelId, e.seedChannelId ?? null, e.source, JSON.stringify(e.detail ?? {}));
}

export function insertEdge(
  srcId: string,
  dstId: string,
  kind: string,
  handle: DatabaseSync = defaultDb,
): void {
  handle
    .prepare("insert or ignore into edge (src_channel_id, dst_channel_id, kind) values (?, ?, ?)")
    .run(srcId, dstId, kind);
}

export function insertSnapshot(
  channelId: string,
  payload: unknown,
  handle: DatabaseSync = defaultDb,
): void {
  handle
    .prepare("insert into channel_snapshot (channel_id, payload) values (?, ?)")
    .run(channelId, JSON.stringify(payload));
}

/** Channel ids the human already rejected — deterministic cleanup drops re-hits. */
export function rejectedIds(handle: DatabaseSync = defaultDb): Set<string> {
  const rows = handle
    .prepare("select distinct channel_id from human_decision where decision = 'reject'")
    .all() as unknown as { channel_id: string }[];
  return new Set(rows.map((r) => r.channel_id));
}

export type CandidateView = {
  id: string;
  title: string;
  status: string;
  sources: string[];
  evidence_count: number;
};

/** Candidates with their provenance — what the UI lists before judgment. */
export function listCandidates(handle: DatabaseSync = defaultDb): CandidateView[] {
  const rows = handle
    .prepare(
      `select c.id, c.title, c.status, e.source
       from channel c
       left join discovery_evidence e on e.channel_id = c.id
       order by c.id`,
    )
    .all() as unknown as { id: string; title: string; status: string; source: string | null }[];
  const byId = new Map<string, CandidateView>();
  for (const r of rows) {
    const v = byId.get(r.id) ?? { id: r.id, title: r.title, status: r.status, sources: [], evidence_count: 0 };
    if (r.source !== null) {
      v.evidence_count += 1;
      if (!v.sources.includes(r.source)) v.sources.push(r.source);
    }
    byId.set(r.id, v);
  }
  return [...byId.values()];
}
