import type { SourceChannel, SourcePlaylist, SourceVideo } from "./types.js";

/**
 * Swappable YouTube data source. Implemented by the fixture adapter now and
 * by the ContentHub-session adapter once it lands (contenthub_pm). No
 * credentials are required by this interface itself.
 */
export interface SourceAdapter {
  readonly name: string;

  /** Resolve a channel by id / handle / exact title. Null when unknown. */
  resolveChannel(ref: string): Promise<SourceChannel | null>;

  /** Recent uploads of a channel — the seed-fingerprint input. */
  channelUploads(channelId: string, limit?: number): Promise<SourceVideo[]>;

  /** Keyword search over channels (the `search.list` expansion surface). */
  searchChannels(query: string, limit?: number): Promise<SourceChannel[]>;

  /** A channel's public subscriptions. */
  channelSubscriptions(channelId: string): Promise<SourceChannel[]>;

  /** A channel's public playlists. */
  channelPlaylists(channelId: string): Promise<SourcePlaylist[]>;

  /** Playlist items; each video carries its owning channelId. */
  playlistItems(playlistId: string): Promise<SourceVideo[]>;

  /**
   * The logged-in account's own subscriptions (user signal). Optional:
   * only adapters with a live session (ContentHub) provide it.
   */
  mySubscriptions?(): Promise<SourceChannel[]>;

  /**
   * Comment-author channels on a channel's recent videos — the entry point
   * for finding "similar viewers" (subscription-gap CF). Optional: only
   * adapters whose surface exposes comment authors implement it
   * (ContentHub read-kind `yt.videos.comments`; author channel ids are the
   * pending addendum — absent ids degrade to an empty surface).
   */
  commentAuthorChannels?(channelId: string, limit?: number): Promise<SourceChannel[]>;
}
