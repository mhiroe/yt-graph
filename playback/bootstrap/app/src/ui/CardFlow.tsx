// Discover card flow — Cover Flow conveyor over the curated channel set
// (user correction 2026-10-08: the deck metaphor was wrong — the image is
// old-iTunes Cover Flow: cards stream left->right through a center focus;
// "真ん中に来たやつをしばらく見て like押す").
// Direction (user correction 2026-10-08): undecided cards WAIT ON THE LEFT
// and stream left->right through focus, exiting right. Controls pull FROM
// a side: left arrow / left flick / ‹ draws the next card in from the left
// queue (advance); right arrow / right flick / › pulls a card back from
// the right pile (revisit a skipped card).
// Flowing past IS the skip — no skip verb, flowed cards stay behind on the
// right and can be revisited; like is explicit (L / ♥ button) and lifts
// the card into the liked drawer; tap / Enter on the focused card is the
// play entry (fullscreen Watch). Zero-dep.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Channel } from "../seams/channelFeed";

const THRESH = 70; // drag px that commits one flow step
const SLOT = 250; // px between card centers
const WINDOW = 3; // render cards within |offset| <= WINDOW

// Monogram tile — the export contract is channel-grain and carries no
// artwork, so the visual anchor is an initial on a hue derived from the id.
function monogram(c: Channel) {
  let h = 0;
  for (const ch of c.id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return { letter: (c.title || "?")[0].toUpperCase(), bg: `hsl(${h} 45% 28%)` };
}

export function CardFlow({
  items,
  onLike,
  onWatch,
}: {
  items: Channel[];
  onLike: (c: Channel) => void;
  onWatch: (c: Channel) => void;
}) {
  const [pos, setPos] = useState(0);
  const [dragX, setDragX] = useState<number | null>(null);
  const start = useRef<{ x: number; i: number } | null>(null);

  // pos is an index into items; likes splice items so clamp for the render.
  const p = Math.min(pos, Math.max(items.length - 1, 0));
  const top = items[p];

  const flow = (d: number) =>
    setPos((v) => Math.max(0, Math.min(items.length - 1, v + d)));

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (e.key === "ArrowLeft") flow(1);
      else if (e.key === "ArrowRight") flow(-1);
      else if (e.key === "Enter") top && onWatch(top);
      else if (e.key === "l" || e.key === "L") top && onLike(top);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const release = () => {
    if (!start.current || dragX == null) return;
    if (Math.abs(dragX) >= THRESH) flow(dragX < 0 ? 1 : -1);
    else if (Math.abs(dragX) < 10) {
      if (start.current.i === p) onWatch(top);
      else setPos(start.current.i);
    }
    setDragX(null);
    start.current = null;
  };

  // Drag is a directional verb (pull FROM a side), not content-follows:
  // a leftward pull means "draw the next card in from the left queue", so
  // the preview slides the stream the other way — the release commits in
  // the same direction the preview showed.
  const drag = -(dragX ?? 0);

  return (
    <div style={{ width: "100%", maxWidth: 860, userSelect: "none" }}>
      <div style={{ position: "relative", height: 330, overflow: "hidden", perspective: 900 }}>
        {items.map((c, i) => {
          const off = p - i; // >0 flowed past (right), <0 upcoming (left), 0 focus
          if (Math.abs(off) > WINDOW) return null;
          const focused = off === 0;
          const m = monogram(c);
          return (
            <div
              key={c.id}
              onPointerDown={(e) => {
                start.current = { x: e.clientX, i };
                setDragX(0);
                e.currentTarget.setPointerCapture?.(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (start.current && dragX != null)
                  setDragX(e.clientX - start.current.x);
              }}
              onPointerUp={release}
              onPointerCancel={() => {
                setDragX(null);
                start.current = null;
              }}
              style={{
                position: "absolute",
                left: "50%",
                top: "50%",
                width: 300,
                transform: `translate(-50%, -50%) translateX(${off * SLOT + drag}px) scale(${focused ? 1 : 0.76}) rotateY(${off === 0 ? 0 : off < 0 ? 42 : -42}deg)`,
                zIndex: 50 - Math.abs(off),
                opacity: Math.abs(off) > 2 ? 0.35 : focused ? 1 : 0.8,
                transition: dragX != null ? "none" : "transform .25s ease, opacity .25s ease",
                background: "#1e1e1e",
                border: `1px solid ${focused ? "#555" : "#2a2a2a"}`,
                borderRadius: 14,
                padding: 20,
                cursor: focused ? "grab" : "pointer",
                touchAction: "none",
                boxShadow: focused ? "0 10px 40px rgba(0,0,0,.6)" : "none",
              }}
            >
              <div
                style={{
                  width: focused ? 88 : 64,
                  height: focused ? 88 : 64,
                  borderRadius: "50%",
                  background: m.bg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: focused ? 40 : 30,
                  margin: "4px auto 12px",
                }}
              >
                {m.letter}
              </div>
              <div style={{ textAlign: "center", fontSize: 18, fontWeight: 600 }}>
                {c.title}
              </div>
              {c.handle && (
                <div style={{ textAlign: "center", color: "#8ab", fontSize: 12 }}>
                  {c.handle}
                </div>
              )}
              {focused && (
                <p
                  style={{
                    color: "#aaa",
                    fontSize: 13,
                    textAlign: "center",
                    minHeight: 40,
                    margin: "10px 0 0",
                  }}
                >
                  {c.description ?? ""}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          marginTop: 6,
        }}
      >
        <button onClick={() => flow(1)} style={btn} title="next card — pull from the left queue (←)">‹</button>
        <span style={{ fontSize: 12, color: "#777", minWidth: 64, textAlign: "center" }}>
          {p + 1} / {items.length}
          {p === items.length - 1 && items.length > 0 ? " — end" : ""}
        </span>
        <button
          onClick={() => top && onLike(top)}
          style={{ ...btn, color: "#f88", width: "auto", padding: "0 14px" }}
          title="like (L)"
        >
          ♥ like
        </button>
        <button
          onClick={() => top && onWatch(top)}
          style={{ ...btn, width: "auto", padding: "0 14px", fontSize: 14 }}
          title="watch (Enter / tap)"
        >
          ▶
        </button>
        <button onClick={() => flow(-1)} style={btn} title="back to a skipped card (→)">›</button>
      </div>
    </div>
  );
}

const btn: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: "50%",
  border: "1px solid #444",
  background: "#222",
  color: "#eee",
  cursor: "pointer",
  fontSize: 16,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
