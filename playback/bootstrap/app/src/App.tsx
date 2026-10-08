import { useEffect, useMemo, useState } from "react";
import { resolveSeams, type Seams } from "./seams";
import type { Channel, ChannelFeedResult } from "./seams/channelFeed";
import type { PointsAllowance } from "./seams/pointsGate";
import {
  bindEmbedControl,
  EmbedSurface,
  type EmbedControl,
  type OpenResult,
} from "./seams/playbackSurface";
import { ParentalLock } from "./core/limits";
import { ViewingRhythm } from "./core/rhythm";
import { ParentPanel } from "./ui/ParentPanel";
import { Discover } from "./ui/Discover";
import { Watch } from "./ui/Watch";

// Watch pins the embed floor — the only surface the limits overlay and
// control channel can govern (user direction 2026-10-08). ContentHub and
// ul-browser remain parent-side alternates via selectSurface ordering.
const watchSurface = new EmbedSurface();

const LIKES_KEY = "yt-playback.likes.v1";
const KW_KEY = "yt-playback.keywords.v1";

function loadIds(key: string): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
function saveIds(key: string, ids: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    /* storage unavailable */
  }
}

function fmtMin(ms: number): string {
  return `${Math.ceil(ms / 60000)} min`;
}

export function App() {
  const lock = useMemo(() => new ParentalLock(), []);
  const rhythm = useMemo(() => new ViewingRhythm(), []);
  const [seams, setSeams] = useState<Seams | null>(null);
  const [feed, setFeed] = useState<ChannelFeedResult | null>(null);
  const [allowance, setAllowance] = useState<PointsAllowance | null>(null);

  const [screen, setScreen] = useState<"discover" | "watch">("discover");
  const [deck, setDeck] = useState<Channel[]>([]);
  const [likedIds, setLikedIds] = useState<string[]>(() => loadIds(LIKES_KEY));
  const [keywords, setKeywords] = useState<string[]>(() => loadIds(KW_KEY));
  const [parentOpen, setParentOpen] = useState(false);

  const [selected, setSelected] = useState<Channel | null>(null);
  const [opened, setOpened] = useState<OpenResult | null>(null);
  const [watching, setWatching] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  // a gate-imposed break keeps the embed mounted but paused/blocked so the
  // break end can resume in place instead of re-opening the playlist
  const [pausedByGate, setPausedByGate] = useState(false);
  const [iframeEl, setIframeEl] = useState<HTMLIFrameElement | null>(null);
  const [control, setControl] = useState<EmbedControl | null>(null);
  // tick counter drives re-render while watching so the cap counts down
  const [, setTick] = useState(0);

  useEffect(() => {
    resolveSeams({
      feed: import.meta.env.VITE_PLAYBACK_FEED,
      exportUrl: import.meta.env.VITE_PLAYBACK_EXPORT_URL,
      points: import.meta.env.VITE_PLAYBACK_POINTS,
      dokoitsuUrl: import.meta.env.VITE_PLAYBACK_DOKOITSU_URL,
    }).then(async (s) => {
      setSeams(s);
      const f = await s.feed.listChannels();
      setFeed(f);
      setDeck(f.channels);
      setAllowance(await s.pointsGate.allowance());
    });
  }, []);

  // Bind the control channel once an embed iframe is mounted.
  useEffect(() => {
    if (!iframeEl || opened?.via !== "embed") return;
    const c = bindEmbedControl(iframeEl);
    setControl(c);
    return () => {
      c.destroy();
      setControl(null);
    };
  }, [iframeEl, opened?.via, opened?.embedUrl]);

  const gatesOk = () =>
    lock.canWatch() && rhythm.canPlay() && (seams?.pointsGate.remainingMs() ?? 0) > 0;

  // Single 1s tick: accrues watch time only while playing; a break trips
  // pause-in-place, break end resumes in place.
  useEffect(() => {
    const iv = setInterval(() => {
      if (watching && seams) {
        lock.addWatch(1000);
        rhythm.accrue(1000);
        seams.pointsGate.spend(1000);
        if (!gatesOk()) {
          setWatching(false);
          const breakOnly =
            !rhythm.canPlay() &&
            lock.canWatch() &&
            seams.pointsGate.remainingMs() > 0;
          if (breakOnly && control) {
            setPausedByGate(true);
            control.block();
            void control.ready.then((ok) => {
              if (!ok) setPausedByGate(false);
            });
          }
        }
      } else if (pausedByGate && seams) {
        if (gatesOk() && control) {
          control.unblock();
          control.resume();
          setPausedByGate(false);
          setWatching(true);
        }
      }
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(iv);
  }, [watching, pausedByGate, control, lock, rhythm, seams]);

  const play = (channel: Channel) => {
    setSelected(channel);
    setOpened(null);
    setWatching(false);
    setUserPaused(false);
    setPausedByGate(false);
    setScreen("watch");
    if (seams && gatesOk()) {
      watchSurface.open({ channelId: channel.id, title: channel.title }).then((r) => {
        setOpened(r);
        if (r.opened) setWatching(true);
      });
    }
  };

  const exitWatch = () => {
    setWatching(false);
    setUserPaused(false);
    setPausedByGate(false);
    setScreen("discover");
  };

  const togglePause = () => {
    if (pausedByGate || !opened?.opened) return;
    if (userPaused) {
      setUserPaused(false);
      setWatching(true);
      control?.resume();
    } else if (watching) {
      setWatching(false);
      setUserPaused(true);
      control?.pause();
    }
  };

  const onLike = (c: Channel) => {
    setDeck((d) => d.filter((x) => x.id !== c.id));
    setLikedIds((ids) => {
      if (ids.includes(c.id)) return ids;
      const next = [...ids, c.id];
      saveIds(LIKES_KEY, next);
      return next;
    });
  };
  // No skip verb: flowing past a card IS the skip (it stays behind in the
  // stream); only ♥ pulls a card out into the liked drawer.
  const onRemoveLike = (id: string) =>
    setLikedIds((ids) => {
      const next = ids.filter((x) => x !== id);
      saveIds(LIKES_KEY, next);
      return next;
    });
  const onSaveKeyword = (k: string) =>
    setKeywords((ks) => {
      if (ks.includes(k)) return ks;
      const next = [...ks, k];
      saveIds(KW_KEY, next);
      return next;
    });
  const onDropKeyword = (k: string) =>
    setKeywords((ks) => {
      const next = ks.filter((x) => x !== k);
      saveIds(KW_KEY, next);
      return next;
    });
  const liked = useMemo(
    () => (feed?.channels ?? []).filter((c) => likedIds.includes(c.id)),
    [feed, likedIds],
  );

  const inBreak = rhythm.inBreak();
  const gateEmpty = seams !== null && seams.pointsGate.remainingMs() <= 0;
  const hardBlocked = !lock.canWatch() || gateEmpty;
  const remaining = seams?.pointsGate.remainingMs();

  const badge = (
    <span
      style={{
        fontSize: 12,
        padding: "4px 10px",
        borderRadius: 999,
        background:
          remaining !== undefined && Number.isFinite(remaining) && remaining <= 5 * 60_000
            ? "#5a2c2c"
            : "#1f2a1f",
        border: "1px solid #444",
      }}
    >
      ⏱ {allowance?.policy ?? "…"} ·{" "}
      {inBreak
        ? `break ${fmtMin(rhythm.breakRemainingMs())}`
        : remaining === undefined
          ? "…"
          : Number.isFinite(remaining)
            ? fmtMin(remaining)
            : "unmetered"}
    </span>
  );

  return (
    <div
      style={{
        fontFamily: "system-ui",
        color: "#eee",
        background: "#111",
        height: "100vh",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {screen === "discover" ? (
        <Discover
          deck={deck}
          liked={liked}
          keywords={keywords}
          badge={badge}
          feedNote={feed ? `${feed.source}${feed.degraded ? " (degraded)" : ""}` : undefined}
          onLike={onLike}
          onWatch={play}
          onSaveKeyword={onSaveKeyword}
          onDropKeyword={onDropKeyword}
          onRemoveLike={onRemoveLike}
          onResetDeck={() =>
            setDeck((feed?.channels ?? []).filter((c) => !likedIds.includes(c.id)))
          }
          onOpenParent={() => setParentOpen(true)}
        />
      ) : selected ? (
        <Watch
          channel={selected}
          embedUrl={hardBlocked ? undefined : opened?.embedUrl}
          badge={badge}
          blocked={pausedByGate}
          breakNote={
            pausedByGate
              ? `resumes ${new Date(Date.now() + rhythm.breakRemainingMs()).toTimeString().slice(0, 5)}`
              : undefined
          }
          paused={userPaused}
          initialTier={2}
          onIframe={setIframeEl}
          onTogglePause={togglePause}
          onExit={exitWatch}
        />
      ) : null}

      {opened && !opened.opened && screen === "watch" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "#111",
            gap: 10,
          }}
        >
          <div style={{ color: "#aaa" }}>{opened.note ?? "surface unavailable"}</div>
          <button onClick={exitWatch}>back</button>
        </div>
      )}

      {hardBlocked && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 60,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(8,8,8,.94)",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 22 }}>limit reached — ask a parent</div>
          <div style={{ color: "#999", fontSize: 13 }}>
            {gateEmpty ? "points budget used up" : "daily viewing limit reached"}
          </div>
          <button onClick={() => setParentOpen(true)} style={{ marginTop: 10 }}>
            parent ▾
          </button>
        </div>
      )}

      {parentOpen && (
        <div style={{ position: "absolute", inset: 0, zIndex: 70 }}>
          <div
            style={{ position: "absolute", inset: 0 }}
            onClick={() => setParentOpen(false)}
          />
          <ParentPanel lock={lock} onChange={() => setTick((t) => t + 1)} />
        </div>
      )}
    </div>
  );
}
