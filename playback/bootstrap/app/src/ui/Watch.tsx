// Watch screen — content-first player. Transition model (user refinement
// 2026-10-08): card click / Enter enters straight into fullscreen playback
// (initialTier, true-FS attempted first with full-window fallback — a
// mount-time request can outlive user activation); double-click unwinds one
// tier and at normal tier returns to Discover; F still cycles tiers up; Esc
// unwinds too. A transparent gesture layer over the iframe gives the mouse
// model (click = pause/resume via the control channel, dbl-click = unwind)
// and covers YouTube's own chrome — no escape links on a curated surface.
// Chrome auto-hides ~2.5s; a limit block replaces it with the break scrim —
// kept inside the player container so it still shows in true fullscreen.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Channel } from "../seams/channelFeed";

export function Watch({
  channel,
  embedUrl,
  badge,
  blocked,
  breakNote,
  paused,
  initialTier = 0,
  onIframe,
  onTogglePause,
  onExit,
}: {
  channel: Channel;
  embedUrl?: string;
  badge: React.ReactNode;
  blocked: boolean;
  breakNote?: string;
  paused: boolean;
  initialTier?: number;
  onIframe: (el: HTMLIFrameElement | null) => void;
  onTogglePause: () => void;
  onExit: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [tier, setTier] = useState(0); // 0 normal, 1 full-window, 2 true fullscreen
  const [chrome, setChrome] = useState(true);
  const hideT = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wake = () => {
    setChrome(true);
    if (hideT.current) clearTimeout(hideT.current);
    hideT.current = setTimeout(() => setChrome(false), 2500);
  };
  useEffect(() => {
    wake();
    return () => {
      if (hideT.current) clearTimeout(hideT.current);
    };
  }, []);

  const requestFs = () => {
    void boxRef.current?.requestFullscreen?.().catch(() => {});
  };
  const exitFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  };
  const cycleTier = () => {
    const n = (tier + 1) % 3;
    if (n === 2) requestFs();
    else exitFs();
    setTier(n);
  };
  const unwind = () => {
    if (tier === 2) {
      exitFs();
      setTier(1);
    } else if (tier === 1) setTier(0);
    else onExit();
  };

  // Entry transition: card click / Enter mounts Watch straight into
  // fullscreen playback. True fullscreen is tried first; when the
  // mount-time request outlives user activation and is refused, the
  // in-page full-window tier still gives edge-to-edge playback.
  useEffect(() => {
    if (initialTier < 1) return;
    if (initialTier >= 2 && boxRef.current?.requestFullscreen) {
      boxRef.current
        .requestFullscreen()
        .then(() => setTier(2))
        .catch(() => setTier(1));
    } else {
      setTier(1);
    }
    // mount-only transition
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Single click on the gesture layer pauses/resumes; a dbl-click cancels
  // the pending single action and unwinds instead (~280ms disambiguation,
  // same convention YouTube uses for click-vs-dblclick).
  const clickT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureClick = () => {
    if (clickT.current) clearTimeout(clickT.current);
    clickT.current = setTimeout(() => onTogglePause(), 280);
  };
  const gestureDouble = () => {
    if (clickT.current) clearTimeout(clickT.current);
    unwind();
  };

  useEffect(() => {
    const h = () => {
      if (!document.fullscreenElement) setTier((t) => (t === 2 ? 1 : t));
    };
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (e.key === "Escape") unwind();
      else if (e.key === "f" || e.key === "F") cycleTier();
      else if (e.key === " ") {
        e.preventDefault();
        onTogglePause();
      }
      wake();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const showChrome = chrome || paused || blocked;
  const tierLabel = tier === 2 ? "fullscreen" : tier === 1 ? "full-window" : "";

  return (
    <div
      ref={boxRef}
      onMouseMove={wake}
      onDoubleClick={gestureDouble}
      style={{
        position: tier === 1 ? "fixed" : "relative",
        inset: tier === 1 ? 0 : undefined,
        zIndex: tier === 1 ? 40 : undefined,
        background: "#000",
        height: tier === 1 ? "100vh" : "100%",
        padding: tier === 0 ? 10 : 0,
        boxSizing: "border-box",
      }}
    >
      {embedUrl && (
        <iframe
          ref={onIframe}
          src={embedUrl}
          title={channel.title}
          style={{
            border: 0,
            display: "block",
            width: "100%",
            height: "100%",
            opacity: blocked ? 0.35 : 1,
          }}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      )}

      {!blocked && embedUrl && (
        <div
          onClick={gestureClick}
          onDoubleClick={gestureDouble}
          onMouseMove={wake}
          style={{ position: "absolute", inset: 0, zIndex: 5 }}
        />
      )}

      {showChrome && !blocked && (
        <>
          <div style={stripTop}>
            <button onClick={unwind} style={pbtn}>‹ back</button>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {channel.title}
            </span>
            {badge}
            {tierLabel && <span style={{ fontSize: 12, color: "#8ab" }}>{tierLabel}</span>}
          </div>
          <div style={stripBottom}>
            <button onClick={onTogglePause} style={pbtn}>{paused ? "▶ resume" : "⏸ pause"}</button>
            <button onClick={onExit} style={pbtn}>stop</button>
            <span style={{ fontSize: 12, color: "#777" }}>click pause · dbl-click back · F fullscreen</span>
          </div>
        </>
      )}

      {blocked && (
        <div style={scrim}>
          <div style={{ fontSize: 22 }}>break time</div>
          <div style={{ color: "#ccc", fontSize: 14, marginTop: 6 }}>
            {breakNote ?? "playback resumes when the break ends"}
          </div>
        </div>
      )}
    </div>
  );
}

const strip: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  zIndex: 6,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  background: "linear-gradient(rgba(0,0,0,.75), transparent)",
};
const stripTop: CSSProperties = { ...strip, top: 0 };
const stripBottom: CSSProperties = {
  ...strip,
  top: "auto",
  bottom: 0,
  background: "linear-gradient(transparent, rgba(0,0,0,.75))",
};
const pbtn: CSSProperties = {
  background: "rgba(30,30,30,.85)",
  border: "1px solid #555",
  color: "#eee",
  borderRadius: 8,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 13,
};
const scrim: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 10,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(10,10,10,.72)",
  color: "#eee",
};
