// Feed-wiring check: proves the surface renders exactly the adopted set from
// the synced export drop, and that the fixture fallback engages only when the
// export is unreachable.
//
// Boots a throwaway vite dev server on :5199 so public/feed-export.json is
// served the same way the app fetches it, then drives the channelFeed seam
// in `auto` mode — the same adapter resolution the app runs.
// usage: tsx scripts/check-feed-wiring.ts   (run `pnpm sync:feed` first)
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createChannelFeed } from "../src/seams/channelFeed";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 5199;
const base = `http://localhost:${port}`;

const drop = JSON.parse(readFileSync(join(root, "public", "feed-export.json"), "utf8")) as {
  channels: { id: string }[];
};
const adoptedIds = [...drop.channels.map((c) => c.id)].sort();
if (adoptedIds.length === 0) throw new Error("synced drop has no channels — run pnpm sync:feed");

const vite: ChildProcess = spawn(
  join(root, "node_modules", ".bin", "vite"),
  ["--port", String(port), "--strictPort"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);
vite.stderr?.on("data", (d) => process.stderr.write(d));

async function waitUp(): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/feed-export.json`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("vite dev server never came up");
}

let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

try {
  await waitUp();
  const feed = createChannelFeed("auto", { exportUrl: `${base}/feed-export.json` });
  const res = await feed.listChannels();
  const gotIds = res.channels.map((c) => c.id).sort();
  check("auto resolves export source", res.source === "export" && !res.degraded,
    `source=${res.source} degraded=${res.degraded}`);
  check("adopted-only render: exactly the accepted set",
    JSON.stringify(gotIds) === JSON.stringify(adoptedIds),
    `${gotIds.length} vs ${adoptedIds.length} ids`);
  check("no fixture bleed", !gotIds.some((id) => id.startsWith("FIX")));
} finally {
  vite.kill("SIGKILL");
}

// Unreachable export -> degraded fixture fallback (curation gate stays upstream).
const offline = await createChannelFeed("auto", {
  exportUrl: `http://localhost:${port}/feed-export.json`,
}).listChannels();
check("disconnected export degrades to fixture", offline.source === "fixture" && offline.degraded,
  `source=${offline.source} degraded=${offline.degraded}`);

process.exit(failed ? 1 : 0);
