import { createServer } from "node:http";
import { listChannels, listEdges } from "./db.js";

const port = Number(process.env.YTG_API_PORT ?? 8787);

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/api/health") {
    return json(res, 200, { ok: true, service: "yt-graph-api" });
  }
  if (url.pathname === "/api/channels") {
    return json(res, 200, { channels: listChannels() });
  }
  if (url.pathname === "/api/graph") {
    return json(res, 200, { channels: listChannels(), edges: listEdges() });
  }
  return json(res, 404, { error: "not_found", path: url.pathname });
});

server.listen(port, () => {
  console.log(`yt-graph api listening on http://localhost:${port}`);
});
