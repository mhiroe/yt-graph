import type { SourceAdapter } from "../adapter.js";
import type { SourceChannel, SourcePlaylist, SourceVideo } from "../types.js";

/**
 * ContentHub-session source (x-graph style: scrape via a logged-in session in
 * the ContentHub webview host). The ContentHub-side adapter is still being
 * built by contenthub_pm — every method fails closed until it lands.
 */
export class ContentHubSourceAdapter implements SourceAdapter {
  readonly name = "contenthub";
  private static readonly pending =
    "ContentHub source adapter not yet delivered; run with YTG_SOURCE=fixture";

  async resolveChannel(_ref: string): Promise<SourceChannel | null> {
    throw new Error(ContentHubSourceAdapter.pending);
  }
  async channelUploads(_channelId: string): Promise<SourceVideo[]> {
    throw new Error(ContentHubSourceAdapter.pending);
  }
  async searchChannels(_query: string): Promise<SourceChannel[]> {
    throw new Error(ContentHubSourceAdapter.pending);
  }
  async channelSubscriptions(_channelId: string): Promise<SourceChannel[]> {
    throw new Error(ContentHubSourceAdapter.pending);
  }
  async channelPlaylists(_channelId: string): Promise<SourcePlaylist[]> {
    throw new Error(ContentHubSourceAdapter.pending);
  }
  async playlistItems(_playlistId: string): Promise<SourceVideo[]> {
    throw new Error(ContentHubSourceAdapter.pending);
  }
  async mySubscriptions(): Promise<SourceChannel[]> {
    throw new Error(ContentHubSourceAdapter.pending);
  }
}
