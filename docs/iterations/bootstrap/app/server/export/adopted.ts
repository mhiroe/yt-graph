// Adopted-channel export seam — the contract a separate playback client
// consumes (task t-01M3RZVVED). Curation is upstream by definition: the
// export carries only channels a human routed to `accept` (channel.status
// = 'accepted'), so downstream surfaces are curated without trusting the
// consumer to filter.
//
// Wire form: a JSON document `{ generated_at, channels: [...] }` served at
// `GET /api/export/adopted` and dumped to a file by `scripts/export-adopted.ts`.
// The playback app's ChannelFeed parses the `channels` array; `sampleVideoId`
// is part of the contract but stays unset until channel snapshots carry
// upload ids.

import type { DatabaseSync } from "node:sqlite";
import { db as defaultDb } from "../db.js";

export type AdoptedChannel = {
  id: string;
  title: string;
  handle?: string;
  url?: string;
  description?: string;
  /** Representative video for preview — reserved, unset while snapshots
   *  carry no upload ids. */
  sampleVideoId?: string;
};

export type AdoptedExport = {
  generated_at: string;
  channels: AdoptedChannel[];
};

/** Build the curated-surface document from the local store. */
export function buildAdoptedExport(handle: DatabaseSync = defaultDb): AdoptedExport {
  const rows = handle
    .prepare(
      `select id, title, handle, url, description from channel
       where status = 'accepted' order by id`,
    )
    .all() as unknown as {
    id: string;
    title: string;
    handle: string | null;
    url: string | null;
    description: string | null;
  }[];
  return {
    generated_at: new Date().toISOString(),
    channels: rows.map((r) => ({
      id: r.id,
      title: r.title,
      ...(r.handle !== null ? { handle: r.handle } : {}),
      ...(r.url !== null ? { url: r.url } : {}),
      ...(r.description !== null ? { description: r.description } : {}),
    })),
  };
}
