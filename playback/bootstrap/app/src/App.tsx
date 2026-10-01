import { useEffect, useState } from "react";
import { resolveSeams, type Seams } from "./seams";
import type { Channel, ChannelFeedResult } from "./seams/channelFeed";
import type { PointsAllowance } from "./seams/pointsGate";
import type { OpenResult } from "./seams/playbackSurface";

export function App() {
  const [seams, setSeams] = useState<Seams | null>(null);
  const [feed, setFeed] = useState<ChannelFeedResult | null>(null);
  const [allowance, setAllowance] = useState<PointsAllowance | null>(null);
  const [selected, setSelected] = useState<Channel | null>(null);
  const [opened, setOpened] = useState<OpenResult | null>(null);

  useEffect(() => {
    resolveSeams({
      feed: import.meta.env.VITE_PLAYBACK_FEED,
      points: import.meta.env.VITE_PLAYBACK_POINTS,
    }).then(async (s) => {
      setSeams(s);
      setFeed(await s.feed.listChannels());
      setAllowance(await s.pointsGate.allowance());
    });
  }, []);

  const play = (channel: Channel) => {
    setSelected(channel);
    setOpened(null);
    if (channel.sampleVideoId && seams) {
      seams.surface.open({ videoId: channel.sampleVideoId }).then(setOpened);
    }
  };

  return (
    <div style={{ fontFamily: "system-ui", color: "#eee", background: "#111", height: "100vh" }}>
      <header style={{ padding: "8px 16px", display: "flex", gap: 12, alignItems: "center" }}>
        <strong>yt-graph playback</strong>
        <span>
          feed: {feed ? `${feed.source}${feed.degraded ? " (degraded)" : ""}` : "…"}
        </span>
        <span>
          gate: {allowance ? `${allowance.policy} — ${allowance.remainingMinutes ?? "∞"} min` : "…"}
        </span>
        <span>surface: {seams?.surface.name ?? "…"}</span>
      </header>
      <div style={{ display: "flex" }}>
        <ul style={{ width: 320, margin: 0, padding: "8px 16px", listStyle: "none" }}>
          {(feed?.channels ?? []).map((c) => (
            <li key={c.id} style={{ padding: "6px 0" }}>
              <button
                onClick={() => play(c)}
                style={{
                  background: selected?.id === c.id ? "#2a4a2a" : "#1c1c1c",
                  color: "#eee",
                  border: "1px solid #333",
                  padding: "6px 10px",
                  width: "100%",
                  textAlign: "left",
                }}
              >
                {c.title}
                {c.handle ? ` ${c.handle}` : ""}
              </button>
            </li>
          ))}
        </ul>
        <div style={{ padding: "8px 16px" }}>
          {selected ? (
            <>
              <h3 style={{ margin: "4px 0" }}>{selected.title}</h3>
              <p style={{ color: "#aaa", fontSize: 13 }}>{selected.description}</p>
              {opened && (
                <p style={{ fontSize: 13 }}>
                  {opened.opened
                    ? `opens via ${opened.via}: ${opened.embedUrl}`
                    : (opened.note ?? "surface unavailable")}
                </p>
              )}
            </>
          ) : (
            <p style={{ color: "#777" }}>select a channel</p>
          )}
        </div>
      </div>
    </div>
  );
}
