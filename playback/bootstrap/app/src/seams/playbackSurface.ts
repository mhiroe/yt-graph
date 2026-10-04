// Playback surface seam — ul-browser is the preferred host (user
// direction; its viability is an open question on the wish), then a
// ContentHub webview / yt-client host, then a plain iframe embed as the
// always-available floor. Everything but the embed is a stub until the
// provider contracts are fixed — availability detection is the seam.

export type OpenRequest = { videoId: string };

export type OpenResult = {
  opened: boolean;
  via: string;
  embedUrl?: string;
  note?: string;
};

export interface PlaybackSurfaceAdapter {
  readonly name: string;
  available(): Promise<boolean>;
  open(req: OpenRequest): Promise<OpenResult>;
}

export class UlBrowserSurface implements PlaybackSurfaceAdapter {
  readonly name = "ul-browser";
  async available(): Promise<boolean> {
    return false;
  }
  async open(_req: OpenRequest): Promise<OpenResult> {
    return { opened: false, via: this.name, note: "ul-browser integration not wired" };
  }
}

export class ContentHubWebviewSurface implements PlaybackSurfaceAdapter {
  readonly name = "contenthub-webview";
  async available(): Promise<boolean> {
    return false;
  }
  async open(_req: OpenRequest): Promise<OpenResult> {
    return { opened: false, via: this.name, note: "ContentHub webview host not wired" };
  }
}

export class EmbedSurface implements PlaybackSurfaceAdapter {
  readonly name = "embed";
  async available(): Promise<boolean> {
    return true;
  }
  async open(req: OpenRequest): Promise<OpenResult> {
    return {
      opened: true,
      via: this.name,
      embedUrl: `https://www.youtube-nocookie.com/embed/${req.videoId}`,
    };
  }
}

// Selection order is fixed by the wish: ul-browser first, then ContentHub
// webview, embed as the floor.
export async function selectSurface(
  candidates: PlaybackSurfaceAdapter[] = [
    new UlBrowserSurface(),
    new ContentHubWebviewSurface(),
    new EmbedSurface(),
  ],
): Promise<PlaybackSurfaceAdapter> {
  for (const adapter of candidates) {
    if (await adapter.available()) return adapter;
  }
  return new EmbedSurface();
}
