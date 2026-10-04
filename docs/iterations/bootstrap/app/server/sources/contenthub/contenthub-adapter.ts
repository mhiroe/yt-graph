import { homedir } from "node:os";
import { join } from "node:path";
import type { SourceAdapter } from "../adapter.js";
import type { SourceChannel, SourcePlaylist, SourceVideo } from "../types.js";
import {
  ChubCommandError,
  ChubTransport,
  ChubUnavailableError,
  ChubUnsupportedError,
} from "./transport.js";

/**
 * ContentHub-session source (x-graph style: read through the logged-in session
 * inside a dedicated ContentHub webview instance on this host).
 *
 * Transport root: the yt instance's `.transport` parent —
 * `~/Library/Containers/com.mhiroe.contenthub/Data/Library/Application
 *  Support/ContentHub/chub/yt` (override: `YTG_CONTENTHUB_ROOT`).
 *
 * Wire contract: request `{id, type: "yt.<kind>", created_at, input}` into
 * `.transport/outbox/`, response `<service>.response` in `.transport/inbox/`
 * (ContentHub spec_contenthub_process.md "transport contract").
 *
 * Live kinds on the ContentHub side today: `yt.session.check` /
 * `yt.auth.inspect`, plus the scrape read-kinds on instance 0.1.2
 * (`yt.channels.get` / `uploads` / `playlists` / `yt.playlists.items` /
 * `yt.videos.comments` / `yt.search` / `yt.subscriptions.mine`). An instance
 * that does not know a kind answers "Unsupported CLI command" and the read
 * fails soft (empty list / null) so an unattended run skips rather than
 * stalls. `yt.auth.action` (interactive auth kind) is intentionally never
 * sent — an unattended run must not drive a login UI.
 *
 * Access posture (user ruling 2026-09-29): read-only, human-like pacing, on a
 * DEDICATED account session. Calls are serial and round-trip-bound (no burst
 * fan-out); nothing here navigates at scroll-full-tilt or writes state.
 */
export class ContentHubSourceAdapter implements SourceAdapter {
  readonly name = "contenthub";

  private readonly transport: ChubTransport;
  private sessionGate: Promise<void> | undefined;

  constructor(root = defaultTransportRoot(), timeoutMs = defaultTimeoutMs()) {
    this.transport = new ChubTransport({ root, timeoutMs });
  }

  // ---- liveness (live kinds; also used by scripts/probe-contenthub.ts) ----

  /** yt.session.check -> {alive, url}. */
  async sessionCheck(): Promise<{ alive: boolean; url?: string }> {
    const out = await this.transport.request("yt.session.check");
    return { alive: out["alive"] === true, url: stringOf(out["url"]) };
  }

  /** yt.auth.inspect -> {authenticated, url}. */
  async authInspect(): Promise<{ authenticated: boolean; url?: string }> {
    const out = await this.transport.request("yt.auth.inspect");
    const auth = (out["authentication"] ?? {}) as Record<string, unknown>;
    return { authenticated: auth["authenticated"] === true, url: stringOf(auth["url"]) };
  }

  /** True when a ContentHub instance currently claims the transport root. */
  ownerAlive(): boolean {
    return this.transport.ownerAlive();
  }

  /**
   * Gate every data read behind the live session: instance alive on
   * youtube.com AND authenticated (dedicated account). A dead instance or a
   * logged-out session fails closed — never enqueue, never drive auth UI.
   * Success is memoized; failure clears so the next call re-checks.
   */
  private ensureSession(): Promise<void> {
    if (this.sessionGate === undefined) {
      this.sessionGate = (async () => {
        const session = await this.sessionCheck();
        if (!session.alive) {
          throw new ChubUnavailableError(
            `ContentHub yt session not alive (url: ${session.url ?? "?"})`,
          );
        }
        const auth = await this.authInspect();
        if (!auth.authenticated) {
          throw new ChubUnavailableError(
            "ContentHub yt session is not authenticated (dedicated account) — " +
              "log in via the visible instance before using YTG_SOURCE=contenthub",
          );
        }
      })();
      this.sessionGate.catch(() => {
        this.sessionGate = undefined;
      });
    }
    return this.sessionGate;
  }

  // ---- SourceAdapter reads (contract kind names; soft-skip while unlanded) ----

  /** yt.channels.get — id / handle / title → channel metadata. */
  async resolveChannel(ref: string): Promise<SourceChannel | null> {
    const out = await this.read("yt.channels.get", { ref });
    if (out === undefined) return null;
    const raw = (out["channel"] ?? (out["id"] !== undefined ? out : undefined)) as
      | Record<string, unknown>
      | undefined;
    const channel = raw === undefined ? undefined : toChannel(raw);
    return channel ?? null;
  }

  /** yt.channels.uploads — recent uploads of a channel. */
  async channelUploads(channelId: string, limit = 20): Promise<SourceVideo[]> {
    const out = await this.read("yt.channels.uploads", { channel_id: channelId, limit });
    return out === undefined ? [] : videoList(out);
  }

  /** yt.search — query → channel hits (channel-shaped entries only). */
  async searchChannels(query: string, limit = 25): Promise<SourceChannel[]> {
    const out = await this.read("yt.search", { query, limit });
    if (out === undefined) return [];
    return channelList(out)
      .filter((raw) => {
        const kind = stringOf(raw["type"] ?? raw["kind"]);
        return kind === undefined || kind === "channel";
      })
      .map(toChannel)
      .filter((c): c is SourceChannel => c !== undefined)
      .slice(0, limit);
  }

  /** yt.channels.subscriptions — a channel's public subscriptions. */
  async channelSubscriptions(channelId: string): Promise<SourceChannel[]> {
    const out = await this.read("yt.channels.subscriptions", { channel_id: channelId });
    return out === undefined ? [] : channelsFrom(out);
  }

  /** yt.channels.playlists — a channel's public playlists. */
  async channelPlaylists(channelId: string): Promise<SourcePlaylist[]> {
    const out = await this.read("yt.channels.playlists", { channel_id: channelId });
    return out === undefined ? [] : playlistList(out);
  }

  /**
   * Playlist items. The contract bullet lists items under
   * `yt.channels.playlists` "(+items)" without a dedicated kind name —
   * `yt.playlists.items` is the inferred name (service `<noun>.<verb>`
   * convention); it fails soft until the ContentHub read-kinds task lands.
   */
  async playlistItems(playlistId: string): Promise<SourceVideo[]> {
    const out = await this.read("yt.playlists.items", { playlist_id: playlistId });
    return out === undefined ? [] : videoList(out);
  }

  /** yt.subscriptions.mine — the dedicated account's own subscriptions. */
  async mySubscriptions(): Promise<SourceChannel[]> {
    const out = await this.read("yt.subscriptions.mine", {});
    return out === undefined ? [] : channelsFrom(out);
  }

  /**
   * yt.videos.comments — comment-author channels on a channel's recent
   * videos (the subscription-gap CF entry point). The read-kind is live on
   * the instance; whether comment payloads carry author channel ids is the
   * pending contenthub_pm addendum — when they don't, the list degrades to
   * empty and the gap pass contributes nothing (fail-soft).
   */
  async commentAuthorChannels(channelId: string, limit = 25): Promise<SourceChannel[]> {
    const out = await this.read("yt.videos.comments", {
      channel_id: channelId,
      limit,
    });
    if (out === undefined) return [];
    const seen = new Set<string>();
    const authors: SourceChannel[] = [];
    for (const raw of rows(out, ["comments", "items", "results"])) {
      const id = firstString(raw, "author_channel_id", "authorChannelId", "channel_id", "channelId");
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      authors.push({
        id,
        title: firstString(raw, "author", "author_name", "authorTitle", "name") ?? id,
      });
    }
    return authors.slice(0, limit);
  }

  /**
   * Session-gated kind dispatch. Unsupported kind (read kinds not yet landed
   * on the ContentHub side) -> undefined, so callers return an empty surface
   * and the run continues instead of stalling. A dead/unauthenticated session
   * still throws — that is a fail-closed condition, not a missing feature.
   */
  private async read(
    kind: `yt.${string}`,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    await this.ensureSession();
    try {
      return await this.transport.request(kind, input);
    } catch (err) {
      if (err instanceof ChubUnsupportedError) return undefined;
      throw err;
    }
  }
}

// ---- wire-shape mapping (tolerant; the scrape payload lands with ContentHub) ----

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringOf(raw[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function toChannel(raw: Record<string, unknown>): SourceChannel | undefined {
  const id = firstString(raw, "id", "channel_id", "channelId");
  const title = firstString(raw, "title", "name") ?? id;
  if (id === undefined || title === undefined) return undefined;
  return {
    id,
    title,
    handle: stringOf(raw["handle"]),
    description: stringOf(raw["description"]),
    url: stringOf(raw["url"]),
    subscriberCount: numberOf(raw["subscriber_count"] ?? raw["subscriberCount"]),
    videoCount: numberOf(raw["video_count"] ?? raw["videoCount"]),
  };
}

function toVideo(raw: Record<string, unknown>): SourceVideo | undefined {
  const id = firstString(raw, "id", "video_id", "videoId");
  const channelId = firstString(raw, "channel_id", "channelId");
  const title = firstString(raw, "title", "name");
  if (id === undefined || channelId === undefined || title === undefined) return undefined;
  return {
    id,
    channelId,
    title,
    publishedAt: firstString(raw, "published_at", "publishedAt"),
  };
}

function toPlaylist(raw: Record<string, unknown>): SourcePlaylist | undefined {
  const id = firstString(raw, "id", "playlist_id", "playlistId");
  const channelId = firstString(raw, "channel_id", "channelId");
  const title = firstString(raw, "title", "name");
  if (id === undefined || channelId === undefined || title === undefined) return undefined;
  return {
    id,
    channelId,
    title,
    itemCount: numberOf(raw["item_count"] ?? raw["itemCount"]),
  };
}

/** First array of objects under the list-ish keys the contract implies. */
function rows(out: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
  for (const key of keys) {
    const value = out[key];
    if (Array.isArray(value)) {
      return value.filter((v): v is Record<string, unknown> =>
        typeof v === "object" && v !== null,
      );
    }
  }
  return [];
}

function channelList(out: Record<string, unknown>): Record<string, unknown>[] {
  return rows(out, ["channels", "subscriptions", "items", "results"]);
}

function channelsFrom(out: Record<string, unknown>): SourceChannel[] {
  return channelList(out)
    .map(toChannel)
    .filter((c): c is SourceChannel => c !== undefined);
}

function videoList(out: Record<string, unknown>): SourceVideo[] {
  return rows(out, ["videos", "items", "uploads", "results"])
    .map(toVideo)
    .filter((v): v is SourceVideo => v !== undefined);
}

function playlistList(out: Record<string, unknown>): SourcePlaylist[] {
  return rows(out, ["playlists", "items", "results"])
    .map(toPlaylist)
    .filter((p): p is SourcePlaylist => p !== undefined);
}

// ---- config ----

function defaultTransportRoot(): string {
  return (
    process.env.YTG_CONTENTHUB_ROOT ??
    join(
      homedir(),
      "Library/Containers/com.mhiroe.contenthub/Data/Library/Application Support",
      "ContentHub/chub/yt",
    )
  );
}

function defaultTimeoutMs(): number {
  const raw = process.env.YTG_CONTENTHUB_TIMEOUT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

export { ChubCommandError, ChubUnavailableError, ChubUnsupportedError };
