import { createServer } from "node:http";
import { db, listChannels, listEdges } from "./db.js";
import { insertDecision, inspectChannel, listCandidates, type Decision } from "./store.js";
import { buildAdoptedExport } from "./export/adopted.js";
import { createSourceAdapter } from "./sources/index.js";
import { runDiscovery } from "./discovery/pipeline.js";
import { runEdgeWalk } from "./discovery/edgewalk.js";
import { runJudgment } from "./judgment/run.js";

const port = Number(process.env.YTG_API_PORT ?? 8787);

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try {
        resolve(buf === "" ? {} : JSON.parse(buf));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname === "/api/health") {
      return json(res, 200, { ok: true, service: "yt-graph-api" });
    }
    if (url.pathname === "/api/channels") {
      return json(res, 200, { channels: listChannels() });
    }
    if (url.pathname === "/api/candidates") {
      return json(res, 200, { candidates: listCandidates() });
    }
    if (url.pathname === "/api/graph") {
      return json(res, 200, { channels: listChannels(), edges: listEdges() });
    }
    if (url.pathname === "/api/inspect") {
      const channelId = url.searchParams.get("channel_id");
      if (!channelId) return json(res, 400, { error: "missing channel_id" });
      const detail = inspectChannel(channelId, db);
      if (!detail) return json(res, 404, { error: "unknown channel" });
      return json(res, 200, detail);
    }
    if (url.pathname === "/api/export/adopted") {
      return json(res, 200, buildAdoptedExport(db));
    }
    if (url.pathname === "/api/discover" && req.method === "POST") {
      const body = (await readBody(req)) as { seed?: string };
      if (!body.seed) return json(res, 400, { error: "missing seed" });
      const result = await runDiscovery(createSourceAdapter(), body.seed, db);
      return json(res, 200, result);
    }
    if (url.pathname === "/api/judge" && req.method === "POST") {
      const body = (await readBody(req)) as { channel_id?: string; force?: boolean };
      if (body.channel_id !== undefined) {
        const ch = db.prepare("select status from channel where id = ?").get(body.channel_id) as
          | { status: string }
          | undefined;
        if (!ch) return json(res, 404, { error: "unknown channel" });
        if (!["candidate", "later"].includes(ch.status)) {
          return json(res, 409, { error: "evaluate targets a candidate or later channel" });
        }
        const result = await runJudgment(undefined, db, {
          channelId: body.channel_id,
          force: body.force === true,
        });
        return json(res, 200, result);
      }
      const result = await runJudgment(undefined, db);
      return json(res, 200, result);
    }
    if (url.pathname === "/api/decide" && req.method === "POST") {
      const body = (await readBody(req)) as { channel_id?: string; decision?: string; note?: string };
      const decision = body.decision as Decision;
      if (!body.channel_id || !["accept", "reject", "later"].includes(decision)) {
        return json(res, 400, { error: "channel_id + decision (accept|reject|later) required" });
      }
      const exists = db.prepare("select id from channel where id = ?").get(body.channel_id);
      if (!exists) return json(res, 404, { error: "unknown channel" });
      insertDecision({ channelId: body.channel_id, decision, note: body.note }, db);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/api/expand" && req.method === "POST") {
      const body = (await readBody(req)) as { channel_id?: string };
      if (!body.channel_id) return json(res, 400, { error: "missing channel_id" });
      const ch = db.prepare("select status from channel where id = ?").get(body.channel_id) as
        | { status: string }
        | undefined;
      if (!ch) return json(res, 404, { error: "unknown channel" });
      if (!["accepted", "seed"].includes(ch.status)) {
        return json(res, 409, { error: "expand requires an accepted or seed channel" });
      }
      const result = await runDiscovery(createSourceAdapter(), body.channel_id, db);
      return json(res, 200, result);
    }
    if (url.pathname === "/api/walk" && req.method === "POST") {
      const body = (await readBody(req)) as { channel_id?: string };
      if (!body.channel_id) return json(res, 400, { error: "missing channel_id" });
      const ch = db.prepare("select status from channel where id = ?").get(body.channel_id) as
        | { status: string }
        | undefined;
      if (!ch) return json(res, 404, { error: "unknown channel" });
      if (!["accepted", "seed"].includes(ch.status)) {
        return json(res, 409, { error: "walk requires an accepted or seed channel" });
      }
      const result = await runEdgeWalk(createSourceAdapter(), body.channel_id, db);
      return json(res, 200, result);
    }
    return json(res, 404, { error: "not_found", path: url.pathname });
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(port, () => {
  console.log(`yt-graph api listening on http://localhost:${port}`);
});
