// Acceptance loop (fixture): seed -> candidates -> jev -> preview -> route ->
// expand, one full turn against a scratch API + in-memory DB.
// Deterministic: fixture source, heuristic judge, stub consult.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 8879;
const base = `http://localhost:${port}`;

const child = spawn(join(root, "node_modules", ".bin", "tsx"), ["server/index.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    NODE_OPTIONS: "--experimental-sqlite",
    YTG_API_PORT: String(port),
    YTG_DB: ":memory:",
    YTG_SOURCE: "fixture",
    YTG_JUDGE: "heuristic",
    YTG_CONSULT: "stub",
  },
});
child.stderr.on("data", (d) => process.stderr.write(d));

let failed = false;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};

const post = async (path, body) => {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const get = async (path) => (await fetch(`${base}${path}`)).json();

try {
  const deadline = Date.now() + 15000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok && (await r.json()).ok) { healthy = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  check("api healthy", healthy);
  if (!healthy) throw new Error("api never came up");

  // 1. discover: one seed -> candidates with provenance
  const disc = await post("/api/discover", { seed: "FIXSEED001" });
  check("discover 200", disc.status === 200);
  check("seed resolved", disc.body.seed?.id === "FIXSEED001");
  check("candidates kept", (disc.body.kept?.length ?? 0) >= 8, `${disc.body.kept?.length} kept`);
  const consultHits = disc.body.kept?.filter((k) => k.sources.includes("stub")) ?? [];
  check("consult surface contributed", consultHits.length >= 1, consultHits.map((c) => c.id).join(","));

  // 2. judge: every candidate scored
  const judge = await post("/api/judge", {});
  check("judge 200", judge.status === 200);
  const passCount = judge.body.judged?.filter((j) => j.verdict === "pass").length ?? 0;
  check("judged all candidates", (judge.body.judged?.length ?? 0) >= 8, `${judge.body.judged?.length} judged`);
  check("at least one pass verdict", passCount >= 1, `${passCount} pass`);

  // 3. preview: candidate detail carries what a human needs to route
  const { candidates } = await get("/api/candidates");
  const preview = candidates.find((c) => c.id === "FIXPL03");
  check(
    "preview fields (desc + sources + judgment)",
    Boolean(preview?.description && preview.sources.length > 0 && preview.judgment),
  );

  // 4. route: accept / reject / later persist
  for (const [id, decision, want] of [
    ["FIXPL03", "accept", "accepted"],
    ["FIXN01", "reject", "rejected"],
    ["FIXS02", "later", "later"],
  ]) {
    const r = await post("/api/decide", { channel_id: id, decision });
    check(`decide ${decision} ${id}`, r.status === 200 && r.body.ok);
    const after = (await get("/api/candidates")).candidates.find((c) => c.id === id);
    check(`status ${id} -> ${want}`, after?.status === want, `got ${after?.status}`);
  }

  // 5. expand: accepted node re-expands; rejected stays filtered
  const exp = await post("/api/expand", { channel_id: "FIXPL03" });
  check("expand 200", exp.status === 200);
  const newEdges = (await get("/api/graph")).edges.filter((e) => e.src_channel_id === "FIXPL03");
  check("re-expansion produced edges from accepted node", newEdges.length >= 1, `${newEdges.length} edges`);
  check(
    "rejected channel not re-surfaced",
    !(exp.body.kept ?? []).some((k) => k.id === "FIXN01"),
  );
  const noCandidateExpand = await post("/api/expand", { channel_id: "FIXS01" });
  check("expand rejects unrouted candidate", noCandidateExpand.status === 409);

  const final = await get("/api/graph");
  console.log(`accept loop complete: ${final.channels.length} channels / ${final.edges.length} edges`);
} finally {
  child.kill("SIGKILL");
}
process.exit(failed ? 1 : 0);
