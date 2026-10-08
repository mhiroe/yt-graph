// Seed-import: read a hand-curated channel list (the
// `.agent-state/anime-channels-2026-09-29.md` shape — `- <title> | <UC...>`
// lines under `group:` headers) into the store as CANDIDATES with `manual`
// provenance. The human accept route stays the gate — nothing here marks a
// channel accepted. Re-runnable: channel rows upsert, evidence dedups on
// (channel_id, source='manual', seed_list).
// usage: tsx scripts/seed-import.ts [listPath]   (YTG_DB — default :memory:)
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../server/db.js";
import { insertEvidence, listCandidates, upsertChannel } from "../server/store.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(root, "../../../..");
const defaultList = join(repoRoot, ".agent-state", "anime-channels-2026-09-29.md");

const listPath = resolve(process.argv[2] ?? defaultList);
const seedListRef = relative(repoRoot, listPath);
const dbPath = process.env.YTG_DB ?? ":memory:";
const handle = openDb(dbPath);

type SeedRow = { id: string; title: string; group: string; note?: string; line: number };

function parseSeedList(text: string): SeedRow[] {
  const rows: SeedRow[] = [];
  let group = "ungrouped";
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    const chan = /^-\s+(.+?)\s*\|\s*(UC[\w-]+)\s*(?:\(([^)]*)\))?\s*$/.exec(line);
    if (chan) {
      rows.push({
        id: chan[2],
        title: chan[1],
        group,
        ...(chan[3] ? { note: chan[3] } : {}),
        line: i + 1,
      });
      return;
    }
    const head = /^([^\s#\-|].*?):\s*$/.exec(line);
    if (head) group = head[1];
  });
  return rows;
}

const seeds = parseSeedList(readFileSync(listPath, "utf8"));
if (seeds.length === 0) {
  console.error(`seed-import: no '- <title> | UC...' rows parsed from ${listPath}`);
  process.exit(2);
}

const hasSeedEvidence = handle.prepare(
  "select detail from discovery_evidence where channel_id = ? and source = 'manual'",
);

let inserted = 0;
let evidenceAdded = 0;
for (const s of seeds) {
  upsertChannel(
    { id: s.id, title: s.title, url: `https://www.youtube.com/channel/${s.id}` },
    "candidate",
    handle,
  );
  inserted += 1;
  const already = (hasSeedEvidence.all(s.id) as { detail: string }[]).some((r) => {
    try {
      return (JSON.parse(r.detail) as { seed_list?: string }).seed_list === seedListRef;
    } catch {
      return false;
    }
  });
  if (!already) {
    insertEvidence(
      {
        channelId: s.id,
        source: "manual",
        detail: { seed_list: seedListRef, group: s.group, ...(s.note ? { note: s.note } : {}), line: s.line },
      },
      handle,
    );
    evidenceAdded += 1;
  }
}

const staged = listCandidates(handle).filter((c) => c.status === "candidate");
console.log(`seed-import: ${seeds.length} parsed, ${inserted} upserted as candidate, ${evidenceAdded} evidence rows added`);
console.log(`store: ${dbPath}`);
console.log(`staged for human route: ${staged.length} candidate(s) — accept/reject stays a human action via the preview-and-route UX`);
for (const c of staged) console.log(`  candidate ${c.id} ${c.title}`);
