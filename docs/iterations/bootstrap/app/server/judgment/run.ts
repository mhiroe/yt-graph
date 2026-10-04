import type { DatabaseSync } from "node:sqlite";
import { db as defaultDb, type ChannelRow } from "../db.js";
import { createJudgeAdapter, type JudgeAdapter } from "./index.js";
import { insertJudgment, latestJudgments } from "../store.js";

export type JudgeRunResult = {
  judge: string;
  judged: { id: string; title: string; score: number; verdict: string }[];
  skipped: { id: string; reason: string }[];
};

function seedContext(handle: DatabaseSync): { id: string; title: string; fingerprint: string[] } | null {
  const seed = handle
    .prepare("select * from channel where status = 'seed' order by last_seen_at desc limit 1")
    .get() as unknown as ChannelRow | undefined;
  if (!seed) return null;
  const snap = handle
    .prepare("select payload from channel_snapshot where channel_id = ? order by id desc limit 1")
    .get(seed.id) as unknown as { payload: string } | undefined;
  let fingerprint: string[] = [];
  try {
    const payload = snap ? (JSON.parse(snap.payload) as { fingerprint?: string[] }) : {};
    fingerprint = payload.fingerprint ?? [];
  } catch { /* fingerprint stays empty */ }
  return { id: seed.id, title: seed.title, fingerprint };
}

/**
 * Judge channels: with `target`, a single human-picked channel (adhoc mode —
 * "この候補を今評価"), re-judging only under `force`; without it, every
 * status='candidate' channel that has no judgment row yet.
 * Persisted verdicts drive which candidates are previewable.
 */
export async function runJudgment(
  judge: JudgeAdapter = createJudgeAdapter(),
  handle: DatabaseSync = defaultDb,
  target?: { channelId: string; force?: boolean },
): Promise<JudgeRunResult> {
  const seed = seedContext(handle);
  if (!seed) throw new Error("no seed channel — run discovery first");

  const candidates = (
    target
      ? handle.prepare("select * from channel where id = ?").all(target.channelId)
      : handle.prepare("select * from channel where status = 'candidate' order by id").all()
  ) as unknown as ChannelRow[];
  const judged = latestJudgments(handle);
  const sources = new Map<string, string[]>();
  for (const r of handle
    .prepare("select distinct channel_id, source from discovery_evidence")
    .all() as unknown as { channel_id: string; source: string }[]) {
    const list = sources.get(r.channel_id) ?? [];
    list.push(r.source);
    sources.set(r.channel_id, list);
  }

  const out: JudgeRunResult = { judge: judge.name, judged: [], skipped: [] };
  for (const c of candidates) {
    if (judged.has(c.id) && !target?.force) {
      out.skipped.push({ id: c.id, reason: "already_judged" });
      continue;
    }
    const result = await judge.judge({
      candidate: {
        id: c.id,
        title: c.title,
        handle: c.handle ?? undefined,
        description: c.description ?? undefined,
        url: c.url ?? undefined,
      },
      seed,
      sources: sources.get(c.id) ?? [],
    });
    insertJudgment(
      { channelId: c.id, judge: result.judge, criteria: result.criteria, score: result.score, verdict: result.verdict },
      handle,
    );
    out.judged.push({ id: c.id, title: c.title, score: result.score, verdict: result.verdict });
  }
  return out;
}
