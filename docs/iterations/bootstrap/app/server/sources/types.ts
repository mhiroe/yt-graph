// Source-adapter types. The discovery pipeline talks only to these;
// fixture / ContentHub-session / future adapters all satisfy them.

export type SourceChannel = {
  id: string;               // UC... style id (fixture uses FIX... ids)
  title: string;
  handle?: string;
  description?: string;
  url?: string;
  subscriberCount?: number;
  videoCount?: number;
};

export type SourceVideo = {
  id: string;
  channelId: string;
  title: string;
  publishedAt?: string;
};

export type SourcePlaylist = {
  id: string;
  channelId: string;        // owning channel
  title: string;
  itemCount?: number;
};

/** Expansion sources a candidate can arrive through (provenance labels). */
export type DiscoverySource =
  | "search"
  | "subscriptions"
  | "playlists"
  | "chappy"
  | "manual"
  | "fixture";
