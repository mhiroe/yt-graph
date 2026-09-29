import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.YTG_DB ?? join(here, "..", "data", "yt-graph.sqlite");
const schemaPath = join(here, "schema.sql");

mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec(readFileSync(schemaPath, "utf8"));

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

export function listChannels(): ChannelRow[] {
  return db.prepare("select * from channel order by first_seen_at").all() as unknown as ChannelRow[];
}

export function listEdges(): EdgeRow[] {
  return db.prepare("select * from edge order by id").all() as unknown as EdgeRow[];
}
