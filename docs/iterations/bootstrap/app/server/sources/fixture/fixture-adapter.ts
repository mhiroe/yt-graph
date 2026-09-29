import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceAdapter } from "../adapter.js";
import type { SourceChannel, SourcePlaylist, SourceVideo } from "../types.js";

type FixtureData = {
  channels: SourceChannel[];
  uploads: Record<string, SourceVideo[]>;
  subscriptions: Record<string, string[]>;
  playlists: SourcePlaylist[];
  playlistItems: Record<string, SourceVideo[]>;
  searchIndex: Record<string, string[]>;
};

const dataPath = join(dirname(fileURLToPath(import.meta.url)), "fixture-data.json");
const data = JSON.parse(readFileSync(dataPath, "utf8")) as FixtureData;
const byId = new Map(data.channels.map((c) => [c.id, c]));

/**
 * Deterministic in-repo dataset. Models the surfaces the ContentHub-session
 * adapter will provide later — no credentials, no network.
 */
export class FixtureSourceAdapter implements SourceAdapter {
  readonly name = "fixture";

  async resolveChannel(ref: string): Promise<SourceChannel | null> {
    const hit =
      byId.get(ref) ??
      data.channels.find((c) => c.handle === ref || c.title === ref);
    return hit ?? null;
  }

  async channelUploads(channelId: string, limit = 20): Promise<SourceVideo[]> {
    return (data.uploads[channelId] ?? []).slice(0, limit);
  }

  async searchChannels(query: string, limit = 25): Promise<SourceChannel[]> {
    const seen = new Set<string>();
    const out: SourceChannel[] = [];
    for (const token of query.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean)) {
      for (const id of data.searchIndex[token] ?? []) {
        const ch = byId.get(id);
        if (ch && !seen.has(id)) {
          seen.add(id);
          out.push(ch);
        }
      }
    }
    return out.slice(0, limit);
  }

  async channelSubscriptions(channelId: string): Promise<SourceChannel[]> {
    return (data.subscriptions[channelId] ?? [])
      .map((id) => byId.get(id))
      .filter((c): c is SourceChannel => c !== undefined);
  }

  async channelPlaylists(channelId: string): Promise<SourcePlaylist[]> {
    return data.playlists.filter((p) => p.channelId === channelId);
  }

  async playlistItems(playlistId: string): Promise<SourceVideo[]> {
    return data.playlistItems[playlistId] ?? [];
  }
}
