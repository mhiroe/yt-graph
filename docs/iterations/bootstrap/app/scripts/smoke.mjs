// Smoke check: boot the API on a scratch port against an in-memory DB,
// hit /api/health and /api/graph, then shut it down.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 8877;
const base = `http://localhost:${port}`;

const child = spawn(join(root, "node_modules", ".bin", "tsx"), ["server/index.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    NODE_OPTIONS: "--experimental-sqlite",
    YTG_API_PORT: String(port),
    YTG_DB: ":memory:",
  },
});
child.stderr.on("data", (d) => process.stderr.write(d));

const deadline = Date.now() + 15000;
let healthy = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${base}/api/health`);
    if (r.ok && (await r.json()).ok) { healthy = true; break; }
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 300));
}
if (!healthy) {
  console.error("smoke: api did not become healthy within 15s");
  child.kill("SIGKILL");
  process.exit(1);
}
const graph = await (await fetch(`${base}/api/graph`)).json();
console.log(`smoke: health ok; graph=${graph.channels.length} channels, ${graph.edges.length} edges`);
child.kill("SIGKILL");
process.exit(0);
