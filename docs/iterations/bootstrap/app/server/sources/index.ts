import type { SourceAdapter } from "./adapter.js";
import { FixtureSourceAdapter } from "./fixture/fixture-adapter.js";
import { ContentHubSourceAdapter } from "./contenthub/contenthub-adapter.js";

/**
 * Adapter selection seam. Default is the credential-free fixture; the
 * ContentHub session adapter slots in when it arrives (YTG_SOURCE=contenthub).
 */
export function createSourceAdapter(name = process.env.YTG_SOURCE ?? "fixture"): SourceAdapter {
  switch (name) {
    case "fixture":
      return new FixtureSourceAdapter();
    case "contenthub":
      return new ContentHubSourceAdapter();
    default:
      throw new Error(`unknown source adapter: ${name} (fixture | contenthub)`);
  }
}

export type { SourceAdapter } from "./adapter.js";
export type { SourceChannel, SourcePlaylist, SourceVideo, DiscoverySource } from "./types.js";
