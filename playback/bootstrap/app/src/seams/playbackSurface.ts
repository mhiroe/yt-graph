// Playback surface seam — ul-browser is the preferred host (user
// direction); when it cannot host playback the seam falls back to an
// embed surface (ContentHub webview / yt-client shape). No real
// integration is wired yet: detection is a stub and embed only produces
// the target descriptor.

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

// Selection order is fixed by the wish: ul-browser first, embed fallback.
export async function selectSurface(
  candidates: PlaybackSurfaceAdapter[] = [new UlBrowserSurface(), new EmbedSurface()],
): Promise<PlaybackSurfaceAdapter> {
  for (const adapter of candidates) {
    if (await adapter.available()) return adapter;
  }
  return new EmbedSurface();
}
