import { createServer } from "node:http";
import { db, listChannels, listEdges } from "./db.js";
import { listCandidates } from "./store.js";
import { createSourceAdapter } from "./sources/index.js";
import { runDiscovery } from "./discovery/pipeline.js";
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
    if (url.pathname === "/api/discover" && req.method === "POST") {
      const body = (await readBody(req)) as { seed?: string };
      if (!body.seed) return json(res, 400, { error: "missing seed" });
      const result = await runDiscovery(createSourceAdapter(), body.seed, db);
      return json(res, 200, result);
    }
    if (url.pathname === "/api/judge" && req.method === "POST") {
      const result = await runJudgment(undefined, db);
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
