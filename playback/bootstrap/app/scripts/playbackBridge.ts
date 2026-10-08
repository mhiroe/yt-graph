// Vite dev/preview bridge for the ContentHubWebviewSurface seam.
//
// The playback app is a browser SPA — it cannot touch ContentHub's file
// transport (`.transport/` under the container app-support dir) directly.
// This plugin exposes two same-origin endpoints so the seam stays HTTP:
//
//   GET  /api/playback/surface/availability
//        -> {available, owner, session?:{alive,authenticated}}
//        available = a live ContentHub instance claims the yt transport root
//        (owner.json pid alive). When alive, yt.session.check + yt.auth.inspect
//        run as read-only diagnostics.
//
//   POST /api/playback/surface/open   {channelId, title?}
//        -> {opened, url?, note?}
//        Open semantics = land the dedicated-account webview on the channel
//        page and front the host window: `yt.channels.get {id}` navigates
//        (its destination() is /channel/UC…), `host.show` raises the window.
//        There is no generic navigate kind — channels.get is the existing
//        channel-page vehicle. If the read errors but session.check shows the
//        webview landed on the channel anyway, the open still counts
//        (navigation is the semantic; the scrape payload is not needed).
//        A dead owner is never written to (that would spawn a visible
//        instance via LaunchAgent) — open returns opened:false.
//
// Config: PLAYBACK_CONTENTHUB_ROOT (default: the yt instance transport root),
//         PLAYBACK_CONTENTHUB_TIMEOUT_MS (default 120s, the contract's
//         recommended wait covering the claim window).
import { homedir } from "node:os";
import { join } from "node:path";
import type { Connect, Plugin } from "vite";
import { ChubClient, ChubCommandError, ChubUnavailableError } from "./chubTransport";

function defaultRoot(): string {
  return (
    process.env.PLAYBACK_CONTENTHUB_ROOT ??
    process.env.YTG_CONTENTHUB_ROOT ??
    join(
      homedir(),
      "Library/Containers/com.mhiroe.contenthub/Data/Library/Application Support",
      "ContentHub/chub/yt",
    )
  );
}

function defaultTimeoutMs(): number {
  const raw = process.env.PLAYBACK_CONTENTHUB_TIMEOUT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try {
        resolve(buf === "" ? {} : (JSON.parse(buf) as Record<string, unknown>));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export function playbackBridge(root = defaultRoot(), timeoutMs = defaultTimeoutMs()): Plugin {
  const chub = new ChubClient(root, timeoutMs);

  const availability = async () => {
    if (!chub.ownerAlive()) return { available: false, owner: false };
    const out: Record<string, unknown> = { available: true, owner: true };
    try {
      out.session = await chub.request("yt.session.check");
      out.auth = ((await chub.request("yt.auth.inspect"))["authentication"] ?? {}) as Record<
        string,
        unknown
      >;
    } catch (e) {
      out.sessionError = e instanceof Error ? e.message : String(e);
    }
    return out;
  };

  const open = async (channelId: string, title?: string) => {
    if (!/^UC[\w-]{10,}$/.test(channelId)) {
      return { status: 400, body: { opened: false, note: `not a UC channel id: ${channelId}` } };
    }
    if (!chub.ownerAlive()) {
      return {
        status: 200,
        body: { opened: false, note: "no live ContentHub owner on the yt transport root" },
      };
    }
    let navigated = false;
    let note = "";
    try {
      await chub.request("yt.channels.get", { id: channelId });
      navigated = true;
    } catch (e) {
      // The read scrapes metadata after navigating — a scrape failure can mask
      // a landed navigation, so confirm via the page-agnostic session.check.
      note = e instanceof Error ? e.message : String(e);
      try {
        const session = await chub.request("yt.session.check");
        const url = typeof session["url"] === "string" ? session["url"] : "";
        navigated = new URL(url).pathname.startsWith(`/channel/${channelId}`);
        if (navigated) note = `webview on channel page (read errored: ${note})`;
      } catch {
        navigated = false;
      }
    }
    if (!navigated) {
      return { status: 200, body: { opened: false, note: note || "navigation failed" } };
    }
    try {
      const shown = (await chub.request("host.show")) as { shown?: boolean; url?: string };
      return {
        status: 200,
        body: {
          opened: true,
          url: shown.url ?? `https://www.youtube.com/channel/${channelId}`,
          note: note || `channel page fronted in ContentHub webview${title ? ` (${title})` : ""}`,
        },
      };
    } catch (e) {
      return {
        status: 200,
        body: {
          opened: false,
          note: `navigated but host.show failed: ${e instanceof Error ? e.message : String(e)}`,
        },
      };
    }
  };

  const use = (middlewares: Connect.Server) => {
    middlewares.use("/api/playback/surface/availability", async (_req, res) => {
      try {
        json(res, 200, await availability());
      } catch (e) {
        json(res, 500, { available: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
    middlewares.use("/api/playback/surface/open", async (req, res) => {
      if (req.method !== "POST") return json(res, 405, { opened: false, note: "POST only" });
      try {
        const body = await readBody(req);
        const channelId = typeof body.channelId === "string" ? body.channelId : "";
        const title = typeof body.title === "string" ? body.title : undefined;
        const r = await open(channelId, title);
        json(res, r.status, r.body);
      } catch (e) {
        json(res, 500, { opened: false, note: e instanceof Error ? e.message : String(e) });
      }
    });
  };

  return {
    name: "playback-contenthub-bridge",
    configureServer: (server) => use(server.middlewares),
    configurePreviewServer: (server) => use(server.middlewares),
  };
}

export { ChubUnavailableError, ChubCommandError };
