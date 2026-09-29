import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultPath = join(here, "..", "data", "yt-graph.sqlite");
const schemaPath = join(here, "schema.sql");

export function openDb(dbPath = process.env.YTG_DB ?? defaultPath): DatabaseSync {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const handle = new DatabaseSync(dbPath);
  handle.exec(readFileSync(schemaPath, "utf8"));
  return handle;
}

export const db = openDb();

export type ChannelRow = {
  id: string;
  title: string;
  handle: string | null;
  description: string | null;
  url: string | null;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
};

export type EdgeRow = {
  id: number;
  src_channel_id: string;
  dst_channel_id: string;
  kind: string;
  created_at: string;
};

export function listChannels(handle: DatabaseSync = db): ChannelRow[] {
  return handle.prepare("select * from channel order by first_seen_at").all() as unknown as ChannelRow[];
}

export function listEdges(handle: DatabaseSync = db): EdgeRow[] {
  return handle.prepare("select * from edge order by id").all() as unknown as EdgeRow[];
}
