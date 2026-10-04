// Dump the adopted-channel export contract document to a file a consumer
// (e.g. the playback app's public dir /feed-export.json) can serve.
// usage: tsx scripts/export-adopted.ts [outPath]   (YTG_DB for the source DB)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../server/db.js";
import { buildAdoptedExport } from "../server/export/adopted.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] ?? join(root, "data", "export", "adopted-channels.json");

const doc = buildAdoptedExport(openDb());
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`export: ${doc.channels.length} adopted channel(s) -> ${out}`);
