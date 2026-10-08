// Discover screen — Cover Flow card stream + one search field (filter over
// the curated set only — real YouTube search is off-contract) +
// keyword-stock drawer + liked-channels drawer. Empty deck is a hard stop;
// the liked drawer is the way back in (user direction 2026-10-08).
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Channel } from "../seams/channelFeed";
import { CardFlow } from "./CardFlow";

const matches = (c: Channel, q: string) => {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [c.title, c.handle ?? "", c.description ?? ""].some((f) =>
    f.toLowerCase().includes(s),
  );
};

export function Discover({
  deck,
  liked,
  keywords,
  badge,
  feedNote,
  onLike,
  onWatch,
  onSaveKeyword,
  onDropKeyword,
  onRemoveLike,
  onResetDeck,
  onOpenParent,
}: {
  deck: Channel[];
  liked: Channel[];
  keywords: string[];
  badge: React.ReactNode;
  feedNote?: string;
  onLike: (c: Channel) => void;
  onWatch: (c: Channel) => void;
  onSaveKeyword: (k: string) => void;
  onDropKeyword: (k: string) => void;
  onRemoveLike: (id: string) => void;
  onResetDeck: () => void;
  onOpenParent: () => void;
}) {
  const [query, setQuery] = useState("");
  const [kwOpen, setKwOpen] = useState(false);
  const [likesOpen, setLikesOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = deck.filter((c) => matches(c, query));

  // Deck verbs (arrows / Enter / L) live inside CardFlow; here only the
  // search-focus shortcut remains — the likes drawer toggles via its ♥ chip.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      if (e.key === "/") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          display: "flex",
          gap: 10,
          alignItems: "center",
          padding: "10px 16px",
          position: "relative",
        }}
      >
        <strong style={{ fontSize: 15 }}>yt-graph</strong>
        <div style={{ position: "relative", flex: 1, maxWidth: 380 }}>
          <input
            ref={inputRef}
            value={query}
            placeholder="filter channels — / to focus"
            onFocus={() => setKwOpen(true)}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              width: "100%",
              background: "#1c1c1c",
              border: "1px solid #333",
              color: "#eee",
              padding: "7px 10px",
              borderRadius: 8,
            }}
          />
          {kwOpen && (
            <div style={drawerStyle}>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>saved keywords</div>
              {keywords.map((k) => (
                <div key={k} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    style={chip}
                    onClick={() => {
                      setQuery(k);
                      setKwOpen(false);
                    }}
                  >
                    {k}
                  </button>
                  <button onClick={() => onDropKeyword(k)} style={xbtn}>✕</button>
                </div>
              ))}
              {query.trim() && !keywords.includes(query.trim()) && (
                <button
                  style={chip}
                  onClick={() => {
                    onSaveKeyword(query.trim());
                    setKwOpen(false);
                  }}
                >
                  + save “{query.trim()}”
                </button>
              )}
              {keywords.length === 0 && !query.trim() && (
                <div style={{ fontSize: 12, color: "#666" }}>type to filter, then save the word</div>
              )}
              <button style={xbtn} onClick={() => setKwOpen(false)}>close</button>
            </div>
          )}
        </div>
        {badge}
        <button onClick={() => setLikesOpen((o) => !o)} style={chip}>♥ {liked.length}</button>
        <button onClick={onOpenParent} style={chip} title="parent controls">⚙</button>
        {feedNote && <span style={{ color: "#ccaa55", fontSize: 12 }}>{feedNote}</span>}
      </header>

      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {filtered.length > 0 ? (
          <CardFlow items={filtered} onLike={onLike} onWatch={onWatch} />
        ) : deck.length === 0 ? (
          <div style={{ textAlign: "center", color: "#999" }}>
            <div style={{ fontSize: 18, marginBottom: 8 }}>all channels reviewed</div>
            <div style={{ fontSize: 13, marginBottom: 14 }}>
              {liked.length} liked — open ♥ to watch the daily feed
            </div>
            <button onClick={onResetDeck} style={chip}>reset deck</button>
            <button onClick={() => setLikesOpen(true)} style={{ ...chip, marginLeft: 8 }}>
              open ♥
            </button>
          </div>
        ) : (
          <div style={{ color: "#888", fontSize: 14 }}>
            no match for “{query}” <button style={chip} onClick={() => setQuery("")}>clear</button>
          </div>
        )}
      </div>

      {likesOpen && (
        <div style={{ ...drawerStyle, right: 16, top: 54, left: "auto", width: 260 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <strong>liked channels</strong>
            <button onClick={() => setLikesOpen(false)} style={xbtn}>✕</button>
          </div>
          {liked.length === 0 && (
            <div style={{ fontSize: 13, color: "#777" }}>press ♥ (or L) to keep a channel</div>
          )}
          {liked.map((c) => (
            <div
              key={c.id}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}
            >
              <span style={{ flex: 1, fontSize: 13 }}>{c.title}</span>
              <button onClick={() => onWatch(c)} style={chip}>▶</button>
              <button onClick={() => onRemoveLike(c.id)} style={xbtn}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const drawerStyle: CSSProperties = {
  position: "absolute",
  top: "110%",
  left: 0,
  zIndex: 30,
  background: "#1a1a1a",
  border: "1px solid #3a3a3a",
  borderRadius: 10,
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  minWidth: 200,
};

const chip: CSSProperties = {
  background: "#222",
  border: "1px solid #444",
  color: "#eee",
  borderRadius: 8,
  padding: "5px 10px",
  cursor: "pointer",
  fontSize: 13,
};

const xbtn: CSSProperties = {
  background: "none",
  border: "none",
  color: "#888",
  cursor: "pointer",
  fontSize: 13,
};
