// Sync the yt-graph adopted-channel export into this app's public dir, where
// the channelFeed seam's default export URL (/feed-export.json) reads it.
// Re-run after `pnpm export:adopted` upstream to refresh the snapshot.
// usage: node scripts/sync-feed.mjs [--from <export.json>]
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argIdx = process.argv.indexOf("--from");
const src = resolve(
  argIdx >= 0
    ? process.argv[argIdx + 1]
    : join(root, "../../../docs/iterations/bootstrap/app/data/export/adopted-channels.json"),
);
const dst = join(root, "public", "feed-export.json");

if (!existsSync(src)) {
  console.error(`sync-feed: export not found at ${src}`);
  console.error("  run `pnpm export:adopted` in docs/iterations/bootstrap/app first,");
  console.error("  or pass --from <path>");
  process.exit(2);
}
const doc = JSON.parse(readFileSync(src, "utf8"));
if (!Array.isArray(doc.channels)) {
  console.error(`sync-feed: ${src} is not an export document (missing channels[])`);
  process.exit(2);
}
mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log(`sync-feed: ${doc.channels.length} channel(s) (${doc.generated_at ?? "no timestamp"}) -> ${dst}`);
