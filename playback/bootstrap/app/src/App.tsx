import { useEffect, useMemo, useState } from "react";
import { resolveSeams, type Seams } from "./seams";
import type { Channel, ChannelFeedResult } from "./seams/channelFeed";
import type { PointsAllowance } from "./seams/pointsGate";
import type { OpenResult } from "./seams/playbackSurface";
import { ParentalLock } from "./core/limits";
import { ViewingRhythm } from "./core/rhythm";
import { ParentPanel } from "./ui/ParentPanel";

function fmtMin(ms: number): string {
  return `${Math.ceil(ms / 60000)} min`;
}

export function App() {
  const lock = useMemo(() => new ParentalLock(), []);
  const rhythm = useMemo(() => new ViewingRhythm(), []);
  const [seams, setSeams] = useState<Seams | null>(null);
  const [feed, setFeed] = useState<ChannelFeedResult | null>(null);
  const [allowance, setAllowance] = useState<PointsAllowance | null>(null);
  const [selected, setSelected] = useState<Channel | null>(null);
  const [opened, setOpened] = useState<OpenResult | null>(null);
  const [watching, setWatching] = useState(false);
  // tick counter drives re-render while watching so the cap counts down
  const [, setTick] = useState(0);

  useEffect(() => {
    resolveSeams({
      feed: import.meta.env.VITE_PLAYBACK_FEED,
      exportUrl: import.meta.env.VITE_PLAYBACK_EXPORT_URL,
      points: import.meta.env.VITE_PLAYBACK_POINTS,
    }).then(async (s) => {
      setSeams(s);
      setFeed(await s.feed.listChannels());
      setAllowance(await s.pointsGate.allowance());
    });
  }, []);

  // Single 1s tick: accrues watch time only while playing, and keeps the
  // break countdown live so playback re-enables when the break ends.
  useEffect(() => {
    const iv = setInterval(() => {
      if (watching && seams) {
        lock.addWatch(1000);
        rhythm.accrue(1000);
        seams.pointsGate.spend(1000);
        if (!lock.canWatch() || !rhythm.canPlay() || seams.pointsGate.remainingMs() <= 0) {
          setWatching(false);
        }
      }
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(iv);
  }, [watching, lock, rhythm, seams]);

  const play = (channel: Channel) => {
    setSelected(channel);
    setOpened(null);
    setWatching(false);
    if (
      channel.sampleVideoId &&
      seams &&
      lock.canWatch() &&
      rhythm.canPlay() &&
      seams.pointsGate.remainingMs() > 0
    ) {
      seams.surface.open({ videoId: channel.sampleVideoId }).then((r) => {
        setOpened(r);
        if (r.opened) setWatching(true);
      });
    }
  };

  const inBreak = rhythm.inBreak();
  const gateEmpty = seams !== null && seams.pointsGate.remainingMs() <= 0;
  const canWatch = lock.canWatch() && !inBreak && !gateEmpty;

  return (
    <div
      style={{
        fontFamily: "system-ui",
        color: "#eee",
        background: "#111",
        height: "100vh",
        position: "relative",
      }}
    >
      <header style={{ padding: "8px 16px", display: "flex", gap: 12, alignItems: "center" }}>
        <strong>yt-graph playback</strong>
        <span>
          feed: {feed ? `${feed.source}${feed.degraded ? " (degraded)" : ""}` : "…"}
        </span>
        <span>
          gate:{" "}
          {allowance
            ? `${allowance.policy} — ${seams ? fmtMin(seams.pointsGate.remainingMs()) : "…"} left`
            : "…"}
        </span>
        <span>surface: {seams?.surface.name ?? "…"}</span>
        <span>
          watched {fmtMin(lock.watchedTodayMs())} / left {fmtMin(lock.remainingTodayMs())}
        </span>
        <span>
          {inBreak
            ? `break — ${fmtMin(rhythm.breakRemainingMs())} left`
            : `next break in ${fmtMin(rhythm.nextBreakInMs())}`}
        </span>
        {feed?.note && (
          <span style={{ color: "#ccaa55", fontSize: 12 }}>{feed.note}</span>
        )}
        <ParentPanel lock={lock} onChange={() => setTick((t) => t + 1)} />
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
          {inBreak && (
            <p style={{ color: "#ffaa55" }}>
              break time — {fmtMin(rhythm.breakRemainingMs())} until playback resumes
            </p>
          )}
          {!inBreak && !lock.canWatch() && (
            <p style={{ color: "#ff7777" }}>daily viewing limit reached — ask a parent</p>
          )}
          {!inBreak && lock.canWatch() && gateEmpty && (
            <p style={{ color: "#ff7777" }}>
              points budget used up — study to earn more (default policy)
            </p>
          )}
          {selected ? (
            <>
              <h3 style={{ margin: "4px 0" }}>{selected.title}</h3>
              <p style={{ color: "#aaa", fontSize: 13 }}>{selected.description}</p>
              {opened && !opened.opened && (
                <p style={{ fontSize: 13 }}>{opened.note ?? "surface unavailable"}</p>
              )}
              {watching && opened?.embedUrl && (
                <iframe
                  src={opened.embedUrl}
                  title={selected.title}
                  width={480}
                  height={270}
                  style={{ border: 0, display: "block", margin: "8px 0" }}
                  allow="encrypted-media; picture-in-picture"
                  allowFullScreen
                />
              )}
              {watching && (
                <div style={{ fontSize: 13, color: "#aaa" }}>
                  playing via {opened?.via}
                  <button onClick={() => setWatching(false)} style={{ marginLeft: 12 }}>
                    stop watching
                  </button>
                </div>
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
