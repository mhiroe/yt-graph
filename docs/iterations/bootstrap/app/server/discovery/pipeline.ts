import type { DatabaseSync } from "node:sqlite";
import type { SourceAdapter, SourceChannel } from "../sources/index.js";
import { db as defaultDb } from "../db.js";
import { fingerprintFromTitles } from "./fingerprint.js";
import { cleanup, type RawHit } from "./cleanup.js";
import { insertEdge, insertEvidence, insertSnapshot, rejectedIds, upsertChannel } from "../store.js";

export type DiscoveryResult = {
  seed: SourceChannel;
  fingerprint: string[];
  raw_count: number;
  kept: { id: string; title: string; sources: string[] }[];
  dropped: { id: string; reason: string }[];
};

/** Max search queries per expansion — search stays a minor path (quota law). */
const MAX_SEARCH_QUERIES = 2;

/**
 * One expansion pass: seed fingerprint -> adapter surfaces -> merge hits with
 * provenance -> deterministic cleanup -> persist channel/edge/evidence/snapshot.
 */
export async function runDiscovery(
  adapter: SourceAdapter,
  seedRef: string,
  handle: DatabaseSync = defaultDb,
): Promise<DiscoveryResult> {
  const seed = await adapter.resolveChannel(seedRef);
  if (!seed) throw new Error(`seed not resolved: ${seedRef}`);

  upsertChannel(seed, "seed", handle);
  insertSnapshot(seed.id, seed, handle);

  // Seed fingerprint from recent upload titles.
  const uploads = await adapter.channelUploads(seed.id, 20);
  const fingerprint = fingerprintFromTitles(uploads.map((v) => v.title));

  // Merge map: channelId -> {channel, evidence[]}
  const hits = new Map<string, RawHit>();
  const add = (channel: SourceChannel, source: string, detail: unknown) => {
    const hit = hits.get(channel.id) ?? { channel, evidence: [] };
    hit.evidence.push({ source, detail });
    hits.set(channel.id, hit);
  };

  // Surface 1: seed's public subscriptions.
  for (const ch of await adapter.channelSubscriptions(seed.id)) {
    add(ch, "subscriptions", { via: seed.id });
  }

  // Surface 2: seed's public playlists -> foreign item channels.
  for (const pl of await adapter.channelPlaylists(seed.id)) {
    const items = await adapter.playlistItems(pl.id);
    const foreign = [...new Set(items.map((v) => v.channelId).filter((id) => id !== seed.id))];
    for (const id of foreign) {
      const ch = await adapter.resolveChannel(id);
      if (ch) add(ch, "playlists", { playlist_id: pl.id, playlist_title: pl.title });
    }
  }

  // Surface 3: fingerprint queries over search (minor path, bounded).
  const queries = [fingerprint.slice(0, 3).join(" "), fingerprint[0]]
    .filter((q): q is string => Boolean(q))
    .slice(0, MAX_SEARCH_QUERIES);
  for (const q of new Set(queries)) {
    for (const ch of await adapter.searchChannels(q)) {
      add(ch, "search", { query: q });
    }
  }

  const { kept, dropped } = cleanup([...hits.values()], seed.id, rejectedIds(handle));

  for (const { channel, evidence } of kept) {
    upsertChannel(channel, "candidate", handle);
    insertEdge(seed.id, channel.id, "expansion", handle);
    for (const e of evidence) {
      insertEvidence({ channelId: channel.id, seedChannelId: seed.id, source: e.source, detail: e.detail }, handle);
    }
  }

  return {
    seed,
    fingerprint,
    raw_count: hits.size,
    kept: kept.map(({ channel, evidence }) => ({
      id: channel.id,
      title: channel.title,
      sources: [...new Set(evidence.map((e) => e.source))],
    })),
    dropped,
  };
}
