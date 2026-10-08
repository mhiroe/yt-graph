// Playback surface seam — ul-browser is the preferred host (user
// direction; its viability is an open question on the wish), then a
// ContentHub webview / yt-client host, then a plain iframe embed as the
// always-available floor. Everything but the embed is a stub until the
// provider contracts are fixed — availability detection is the seam.

// Playable unit is the CHANNEL, not a video (user ruling 2026-10-08 — no
// video-level discovery). The embed floor plays a channel whole via its
// uploads playlist: UC… -> UU… (`videoseries?list=UU<rest>`).
export type OpenRequest = { channelId: string; title?: string };

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

// Real host surface: the dedicated-account ContentHub webview instance.
// The app is a browser SPA and cannot reach the file transport directly, so
// the seam talks to the vite playback bridge (same-origin
// /api/playback/surface/*) — dev and preview modes only; a statically hosted
// build has no bridge and honestly reports unavailable -> embed floor.
export class ContentHubWebviewSurface implements PlaybackSurfaceAdapter {
  readonly name = "contenthub-webview";
  constructor(
    private readonly base: string = "",
    private readonly f: typeof fetch = fetch,
  ) {}
  async available(): Promise<boolean> {
    try {
      const r = await this.f(`${this.base}/api/playback/surface/availability`);
      if (!r.ok) return false;
      return ((await r.json()) as { available?: boolean }).available === true;
    } catch {
      return false;
    }
  }
  async open(req: OpenRequest): Promise<OpenResult> {
    try {
      const r = await this.f(`${this.base}/api/playback/surface/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: req.channelId, title: req.title }),
      });
      const b = (await r.json().catch(() => ({}))) as {
        opened?: boolean;
        url?: string;
        note?: string;
      };
      if (!r.ok || b.opened !== true) {
        return { opened: false, via: this.name, note: b.note ?? `bridge open failed (${r.status})` };
      }
      return { opened: true, via: this.name, note: b.note ?? b.url };
    } catch (e) {
      return {
        opened: false,
        via: this.name,
        note: `bridge unreachable: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}

export class EmbedSurface implements PlaybackSurfaceAdapter {
  readonly name = "embed";
  async available(): Promise<boolean> {
    return true;
  }
  async open(req: OpenRequest): Promise<OpenResult> {
    if (!req.channelId.startsWith("UC")) {
      return {
        opened: false,
        via: this.name,
        note: `no uploads playlist for non-UC channel id ${req.channelId}`,
      };
    }
    const origin =
      typeof location === "undefined"
        ? ""
        : `&origin=${encodeURIComponent(location.origin)}`;
    return {
      opened: true,
      via: this.name,
      embedUrl: `https://www.youtube-nocookie.com/embed/videoseries?list=UU${req.channelId.slice(2)}&enablejsapi=1${origin}`,
    };
  }
}

// ---- embed control channel ----
// Beside the open/available contract: the App binds a control to the mounted
// embed iframe so the limit/rhythm gates can really pause/block a playing
// video instead of only refusing new opens. The YouTube IFrame API is loaded
// lazily and guarded — when it cannot load (offline, file://) `ready`
// resolves false and the caller degrades honestly (hide/unmount), it never
// pretends a pause happened.

export interface EmbedPlayer {
  pauseVideo(): void;
  playVideo(): void;
  destroy(): void;
}

export type EmbedPlayerFactory = (
  iframe: HTMLIFrameElement,
  events: { onReady?: () => void },
) => EmbedPlayer;

declare global {
  interface Window {
    YT?: {
      Player?: new (
        el: HTMLIFrameElement,
        opts: { events?: { onReady?: () => void } },
      ) => EmbedPlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiReady: Promise<boolean> | null = null;

function loadIframeApi(timeoutMs = 8000): Promise<boolean> {
  if (apiReady) return apiReady;
  apiReady = new Promise<boolean>((resolve) => {
    if (typeof document === "undefined") return resolve(false);
    if (window.YT?.Player) return resolve(true);
    const prev = window.onYouTubeIframeAPIReady;
    const timer = setTimeout(() => resolve(false), timeoutMs);
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      prev?.();
      resolve(window.YT?.Player ? true : false);
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    document.head.appendChild(tag);
  });
  return apiReady;
}

export class EmbedControl {
  private player: EmbedPlayer | null = null;
  private blocked = false;
  readonly ready: Promise<boolean>;

  constructor(
    private readonly iframe: HTMLIFrameElement,
    factory?: EmbedPlayerFactory,
  ) {
    this.ready = (factory ? Promise.resolve(true) : loadIframeApi()).then((apiOk) => {
      if (!apiOk) return false;
      try {
        const make =
          factory ??
          ((el, events) => new window.YT!.Player!(el, { events }) as EmbedPlayer);
        this.player = make(iframe, {});
        return true;
      } catch {
        return false;
      }
    });
  }

  get isBlocked(): boolean {
    return this.blocked;
  }

  private send(fn: (p: EmbedPlayer) => void): void {
    if (this.player) {
      try {
        fn(this.player);
      } catch {
        /* player not command-ready yet */
      }
    } else {
      void this.ready.then((ok) => {
        if (ok && this.player) {
          try {
            fn(this.player);
          } catch {
            /* player not command-ready yet */
          }
        }
      });
    }
  }

  pause(): void {
    this.send((p) => p.pauseVideo());
  }

  resume(): void {
    if (this.blocked) return;
    this.send((p) => p.playVideo());
  }

  // Block = pause + make the YouTube chrome inert so a paused embed cannot be
  // restarted from inside the iframe. If the API never arrived the caller
  // degrades (ready === false -> hide/unmount); block() itself never throws.
  block(): void {
    this.blocked = true;
    this.pause();
    try {
      this.iframe.style.pointerEvents = "none";
    } catch {
      /* detached iframe */
    }
  }

  unblock(): void {
    this.blocked = false;
    try {
      this.iframe.style.pointerEvents = "";
    } catch {
      /* detached iframe */
    }
  }

  destroy(): void {
    this.send((p) => p.destroy());
    this.player = null;
  }
}

export function bindEmbedControl(
  iframe: HTMLIFrameElement,
  factory?: EmbedPlayerFactory,
): EmbedControl {
  return new EmbedControl(iframe, factory);
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
