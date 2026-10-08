// Channel feed seam — the only path by which channels enter this app.
//
// The real provider is yt-graph's adopted-channel export contract
// (task t-01M3RZVVED, post-PoC wish w-01M3RZSXN0). Curation is upstream:
// that contract carries only channels a human routed to accept, so this
// surface never lists anything else. Until the export lands the feed
// fails soft onto the local fixture.
//
// Provisional export shape (contract not yet fixed on the yt-graph side):
// a JSON document `{ "channels": [{ "id", "title", ... }] }` fetched from
// a configurable URL — served from the app's public dir or wherever the
// exporter drops it (VITE_PLAYBACK_EXPORT_URL, default /feed-export.json).

import fixtureData from "./fixtures/adopted-channels.json";

export type Channel = {
  id: string;
  title: string;
  handle?: string;
  url?: string;
  description?: string;
};

export type ChannelFeedResult = {
  channels: Channel[];
  source: "export" | "fixture" | "none";
  degraded: boolean;
  note?: string;
};

export interface ChannelFeedAdapter {
  readonly name: string;
  listChannels(): Promise<ChannelFeedResult>;
}

export type ExportLoader = (url: string) => Promise<unknown>;

const fetchLoader: ExportLoader = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`export fetch ${res.status}`);
  return res.json();
};

export function parseExportDocument(raw: unknown): Channel[] | null {
  if (typeof raw !== "object" || raw === null) return null;
  const channels = (raw as { channels?: unknown }).channels;
  if (!Array.isArray(channels)) return null;
  for (const c of channels) {
    if (typeof c !== "object" || c === null) return null;
    const { id, title } = c as { id?: unknown; title?: unknown };
    if (typeof id !== "string" || typeof title !== "string") return null;
  }
  return channels as Channel[];
}

export class ExportContractFeed implements ChannelFeedAdapter {
  readonly name = "export";
  constructor(
    private readonly url: string = "/feed-export.json",
    private readonly load: ExportLoader = fetchLoader,
  ) {}
  async listChannels(): Promise<ChannelFeedResult> {
    try {
      const channels = parseExportDocument(await this.load(this.url));
      if (channels === null) throw new Error("invalid export shape");
      return { channels, source: "export", degraded: false };
    } catch (e) {
      return {
        channels: [],
        source: "export",
        degraded: true,
        note: `export not connected: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}

export class FixtureFeed implements ChannelFeedAdapter {
  readonly name = "fixture";
  async listChannels(): Promise<ChannelFeedResult> {
    return { channels: fixtureData.channels as Channel[], source: "fixture", degraded: false };
  }
}

// Failover: export contract first, fixture while it is unavailable.
export class FailoverFeed implements ChannelFeedAdapter {
  readonly name = "auto";
  constructor(
    private readonly primary: ChannelFeedAdapter,
    private readonly fallback: ChannelFeedAdapter = new FixtureFeed(),
  ) {}
  async listChannels(): Promise<ChannelFeedResult> {
    const first = await this.primary.listChannels();
    if (!first.degraded && first.channels.length > 0) return first;
    const second = await this.fallback.listChannels();
    return { ...second, degraded: true, note: first.note ?? second.note };
  }
}

export function createChannelFeed(
  kind: string = "auto",
  opts: { exportUrl?: string } = {},
): ChannelFeedAdapter {
  switch (kind) {
    case "export":
      return new ExportContractFeed(opts.exportUrl);
    case "fixture":
      return new FixtureFeed();
    default:
      return new FailoverFeed(new ExportContractFeed(opts.exportUrl));
  }
}
