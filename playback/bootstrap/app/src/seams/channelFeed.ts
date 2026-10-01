// Channel feed seam — the only path by which channels enter this app.
//
// The real provider is yt-graph's adopted-channel export contract
// (task t-01M3RZVVED, post-PoC wish w-01M3RZSXN0). Curation is upstream:
// that contract carries only channels a human routed to accept, so this
// surface never lists anything else. Until the export lands the feed
// fails soft onto the local fixture.

import fixtureData from "./fixtures/adopted-channels.json";

export type Channel = {
  id: string;
  title: string;
  handle?: string;
  url?: string;
  description?: string;
  sampleVideoId?: string;
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

export class ExportContractFeed implements ChannelFeedAdapter {
  readonly name = "export";
  async listChannels(): Promise<ChannelFeedResult> {
    return {
      channels: [],
      source: "export",
      degraded: true,
      note: "yt-graph adopted-channel export (t-01M3RZVVED) not connected",
    };
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
    private readonly primary: ChannelFeedAdapter = new ExportContractFeed(),
    private readonly fallback: ChannelFeedAdapter = new FixtureFeed(),
  ) {}
  async listChannels(): Promise<ChannelFeedResult> {
    const first = await this.primary.listChannels();
    if (!first.degraded && first.channels.length > 0) return first;
    const second = await this.fallback.listChannels();
    return { ...second, degraded: true, note: first.note ?? second.note };
  }
}

export function createChannelFeed(kind: string = "auto"): ChannelFeedAdapter {
  switch (kind) {
    case "export":
      return new ExportContractFeed();
    case "fixture":
      return new FixtureFeed();
    default:
      return new FailoverFeed();
  }
}
