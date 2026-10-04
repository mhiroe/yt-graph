import type { DatabaseSync } from "node:sqlite";
import type { SourceChannel } from "./sources/index.js";
import { db as defaultDb, type ChannelRow } from "./db.js";

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

export function insertJudgment(
  j: { channelId: string; judge: string; criteria: unknown; score: number; verdict: string },
  handle: DatabaseSync = defaultDb,
): void {
  handle
    .prepare("insert into judgment (channel_id, judge, criteria, score, verdict) values (?, ?, ?, ?, ?)")
    .run(j.channelId, j.judge, JSON.stringify(j.criteria), j.score, j.verdict);
}

export type JudgmentRow = {
  channel_id: string;
  judge: string;
  score: number;
  verdict: string;
};

/** Latest judgment per channel. */
export function latestJudgments(handle: DatabaseSync = defaultDb): Map<string, JudgmentRow> {
  const rows = handle
    .prepare(
      `select j.channel_id, j.judge, j.score, j.verdict
       from judgment j
       join (select channel_id, max(id) mid from judgment group by channel_id) latest
         on latest.mid = j.id`,
    )
    .all() as unknown as JudgmentRow[];
  return new Map(rows.map((r) => [r.channel_id, r]));
}

export type Decision = "accept" | "reject" | "later";

const DECISION_STATUS: Record<Decision, string> = {
  accept: "accepted",
  reject: "rejected",
  later: "later",
};

/** Persist a human routing decision and move the channel status. */
export function insertDecision(
  d: { channelId: string; decision: Decision; note?: string },
  handle: DatabaseSync = defaultDb,
): void {
  handle
    .prepare("insert into human_decision (channel_id, decision, note) values (?, ?, ?)")
    .run(d.channelId, d.decision, d.note ?? null);
  handle
    .prepare("update channel set status = ?, last_seen_at = datetime('now') where id = ?")
    .run(DECISION_STATUS[d.decision], d.channelId);
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
  handle: string | null;
  description: string | null;
  url: string | null;
  sources: string[];
  evidence_count: number;
  judgment?: { judge: string; score: number; verdict: string };
};

export type RelatedEdge = {
  id: number;
  kind: string;
  created_at: string;
  channel_id: string;
  title: string;
  status: string;
};

export type ChannelInspection = {
  channel: ChannelRow;
  evidence: {
    id: number;
    seed_channel_id: string | null;
    source: string;
    detail: unknown;
    created_at: string;
  }[];
  judgments: {
    id: number;
    judge: string;
    criteria: unknown;
    score: number | null;
    verdict: string | null;
    created_at: string;
  }[];
  decisions: { id: number; decision: string; note: string | null; created_at: string }[];
  edges: { incoming: RelatedEdge[]; outgoing: RelatedEdge[] };
  snapshot: { fetched_at: string; payload: unknown } | null;
};

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** One channel fully opened for the inspection UI — detail, provenance, AI
 *  evaluations, related edges, and the human routing history. */
export function inspectChannel(channelId: string, handle: DatabaseSync = defaultDb): ChannelInspection | null {
  const channel = handle.prepare("select * from channel where id = ?").get(channelId) as
    | ChannelRow
    | undefined;
  if (!channel) return null;

  const evidence = (
    handle
      .prepare(
        `select id, seed_channel_id, source, detail, created_at
         from discovery_evidence where channel_id = ? order by id`,
      )
      .all(channelId) as unknown as {
      id: number; seed_channel_id: string | null; source: string; detail: string; created_at: string;
    }[]
  ).map((e) => ({ ...e, detail: parseJson(e.detail) }));

  const judgments = (
    handle
      .prepare(
        `select id, judge, criteria, score, verdict, created_at
         from judgment where channel_id = ? order by id desc`,
      )
      .all(channelId) as unknown as {
      id: number; judge: string; criteria: string; score: number | null; verdict: string | null;
      created_at: string;
    }[]
  ).map((j) => ({ ...j, criteria: parseJson(j.criteria) }));

  const decisions = handle
    .prepare(
      `select id, decision, note, created_at
       from human_decision where channel_id = ? order by id desc`,
    )
    .all(channelId) as unknown as ChannelInspection["decisions"];

  const incoming = handle
    .prepare(
      `select e.id, e.kind, e.created_at, c.id as channel_id, c.title, c.status
       from edge e join channel c on c.id = e.src_channel_id
       where e.dst_channel_id = ? order by e.id`,
    )
    .all(channelId) as unknown as RelatedEdge[];
  const outgoing = handle
    .prepare(
      `select e.id, e.kind, e.created_at, c.id as channel_id, c.title, c.status
       from edge e join channel c on c.id = e.dst_channel_id
       where e.src_channel_id = ? order by e.id`,
    )
    .all(channelId) as unknown as RelatedEdge[];

  const snapRow = handle
    .prepare(
      `select fetched_at, payload from channel_snapshot where channel_id = ? order by id desc limit 1`,
    )
    .get(channelId) as unknown as { fetched_at: string; payload: string } | undefined;

  return {
    channel,
    evidence,
    judgments,
    decisions,
    edges: { incoming, outgoing },
    snapshot: snapRow ? { fetched_at: snapRow.fetched_at, payload: parseJson(snapRow.payload) } : null,
  };
}

/** Candidates with their provenance — what the UI lists before judgment. */
export function listCandidates(handle: DatabaseSync = defaultDb): CandidateView[] {
  const rows = handle
    .prepare(
      `select c.id, c.title, c.status, c.handle, c.description, c.url, e.source
       from channel c
       left join discovery_evidence e on e.channel_id = c.id
       order by c.id`,
    )
    .all() as unknown as {
      id: string; title: string; status: string;
      handle: string | null; description: string | null; url: string | null;
      source: string | null;
    }[];
  const judgments = latestJudgments(handle);
  const byId = new Map<string, CandidateView>();
  for (const r of rows) {
    const v = byId.get(r.id) ?? {
      id: r.id, title: r.title, status: r.status,
      handle: r.handle, description: r.description, url: r.url,
      sources: [], evidence_count: 0,
    };
    if (r.source !== null) {
      v.evidence_count += 1;
      if (!v.sources.includes(r.source)) v.sources.push(r.source);
    }
    const j = judgments.get(r.id);
    if (j) v.judgment = { judge: j.judge, score: j.score, verdict: j.verdict };
    byId.set(r.id, v);
  }
  return [...byId.values()];
}
