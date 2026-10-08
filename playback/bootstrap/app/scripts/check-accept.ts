// kk acceptance smoke — standalone e2e for the usable pass.
//
// Covers the wish's 受け入れ条件 without a browser and without foreign
// services:
//   A) real-feed enumeration — the served drop lists exactly the adopted set
//      (diffed against the core export file, not just the public copy)
//   B) playback open — channel-grain open yields the UU* uploads-playlist
//      embed; the surface probe reports honestly; the embed URL is live-
//      resolved as a soft check (no faked browser)
//   C) limit+lock+points+rhythm enforcement — the App's 1s tick contract is
//      replayed seam-level against a stubbed player: break trips pause+block,
//      resume is refused mid-block, break end resumes in place; cap hits take
//      the unmount path; dead points server degrades to the shadow ledger.
//
// usage: tsx scripts/check-accept.ts   (run `pnpm sync:feed` first)

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createChannelFeed } from "../src/seams/channelFeed";
import { DokoitsuPointsGate, HttpPointsGate } from "../src/seams/pointsGate";
import {
  bindEmbedControl,
  ContentHubWebviewSurface,
  EmbedSurface,
  selectSurface,
  UlBrowserSurface,
  type EmbedPlayer,
} from "../src/seams/playbackSurface";
import { ManualClock } from "../src/core/clock";
import { MemoryStore, ParentalLock } from "../src/core/limits";
import { ViewingRhythm } from "../src/core/rhythm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 5525;
const base = `http://localhost:${port}`;

const coreExport = JSON.parse(
  readFileSync(
    join(root, "..", "..", "..", "docs", "iterations", "bootstrap", "app", "data", "export", "adopted-channels.json"),
    "utf8",
  ),
) as { channels: { id: string; title?: string }[] };
const adoptedIds = [...coreExport.channels.map((c) => c.id)].sort();
if (adoptedIds.length === 0) {
  throw new Error("core export is empty — run the accept route first");
}

const vite: ChildProcess = spawn(
  join(root, "node_modules", ".bin", "vite"),
  ["--port", String(port), "--strictPort"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);
vite.stderr?.on("data", (d) => process.stderr.write(d));

async function waitUp(): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("vite dev server never came up");
}

let failed = false;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};
const note = (name: string, detail: string) => console.log(`NOTE ${name} — ${detail}`);

// ---------- A) real-feed enumeration over the dev-server path ----------
try {
  await waitUp();

  const index = await (await fetch(`${base}/`)).text();
  check("app serves on scratch port", index.includes('id="root"') || index.includes("/src/main"));

  const drop = (await (await fetch(`${base}/feed-export.json`)).json()) as {
    channels: { id: string }[];
  };
  const servedIds = [...drop.channels.map((c) => c.id)].sort();
  check(
    "served drop == core export (upstream truth)",
    JSON.stringify(servedIds) === JSON.stringify(adoptedIds),
    `${servedIds.length} vs ${adoptedIds.length} ids`,
  );

  const feed = createChannelFeed("export", { exportUrl: `${base}/feed-export.json` });
  const res = await feed.listChannels();
  const gotIds = res.channels.map((c) => c.id).sort();
  check(
    "feed enumerates adopted-only via export seam",
    res.source === "export" && !res.degraded && JSON.stringify(gotIds) === JSON.stringify(adoptedIds),
    `source=${res.source} degraded=${res.degraded} ${gotIds.length} ids`,
  );
  check("no fixture bleed", !gotIds.some((id) => id.startsWith("FIX")));

  // ---------- B) playback open ----------
  const probe = (await (await fetch(`${base}/api/playback/surface/availability`)).json()) as {
    available?: boolean;
  };
  note(
    "contenthub surface probe",
    `available=${probe.available} (dead owner expected false; live ContentHub would read true)`,
  );
  const picked = await selectSurface([
    new UlBrowserSurface(),
    new ContentHubWebviewSurface(base),
    new EmbedSurface(),
  ]);
  note("surface selection", `picked=${picked.name}`);
  check(
    "selection keeps fallback order",
    picked.name === "embed" || picked.name === "contenthub-webview",
    `picked=${picked.name}`,
  );

  const firstUc = adoptedIds.find((id) => id.startsWith("UC"));
  if (!firstUc) throw new Error("adopted set has no UC channel id");
  const open = await new EmbedSurface().open({ channelId: firstUc });
  check(
    "channel open yields uploads-playlist embed",
    open.opened === true &&
      typeof open.embedUrl === "string" &&
      open.embedUrl.includes(`/videoseries?list=UU${firstUc.slice(2)}`) &&
      open.embedUrl.includes("enablejsapi=1"),
    open.embedUrl,
  );
  // The embed URL is the mount payload — resolve it live when the network
  // allows; unreachable network reports WARN, not failure (standalone stays
  // hermetic).
  try {
    const head = await fetch(open.embedUrl!, { method: "HEAD" });
    check("embed URL resolves over HTTP", head.ok, `status=${head.status}`);
  } catch (e) {
    note("embed URL live resolve skipped", `offline: ${e instanceof Error ? e.message : e}`);
  }

  // Bridge open honesty: whatever ContentHub's real state is, the response
  // carries a boolean + note, never a server error.
  const bridgeOpen = (await (
    await fetch(`${base}/api/playback/surface/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: firstUc }),
    })
  ).json()) as { opened?: boolean; note?: string };
  check(
    "bridge open answers honestly",
    typeof bridgeOpen.opened === "boolean",
    `opened=${bridgeOpen.opened}${bridgeOpen.note ? ` note=${bridgeOpen.note}` : ""}`,
  );
} finally {
  vite.kill("SIGKILL");
}

// ---------- C) limit + lock + points + rhythm enforcement (seam e2e) ----------
// Replays the App's 1s tick contract against real core objects: accrual ->
// gate evaluation -> control channel behavior. ManualClock drives the break
// window deterministically; a stubbed EmbedPlayer records the calls.
const clock = new ManualClock(Date.parse("2026-10-08T12:00:00"));
const lock = new ParentalLock(new MemoryStore(), clock.now);
const rhythm = new ViewingRhythm({ watchMs: 5_000, restMs: 3_000 }, clock.now);
const gate = new DokoitsuPointsGate(new MemoryStore(), clock.now);
const calls: string[] = [];
const fakeIframe = { style: { pointerEvents: "" } } as unknown as HTMLIFrameElement;
const ctl = bindEmbedControl(fakeIframe, (): EmbedPlayer => ({
  pauseVideo: () => calls.push("pause"),
  playVideo: () => calls.push("play"),
  destroy: () => calls.push("destroy"),
}));
await ctl.ready;

const gatesOk = () => lock.canWatch() && rhythm.canPlay() && gate.remainingMs() > 0;
const breakOnly = () => !rhythm.canPlay() && lock.canWatch() && gate.remainingMs() > 0;
let watching = true;
let blocked = false;
// Tick as App does: accrue, evaluate gates, act through the control channel.
for (let i = 0; i < 10 && !blocked; i++) {
  lock.addWatch(1_000);
  rhythm.accrue(1_000);
  gate.spend(1_000);
  if (!gatesOk()) {
    watching = false;
    if (breakOnly()) {
      blocked = true;
      ctl.block();
    }
  }
  clock.advance(1_000);
}
check("rhythm break trips during watch", blocked && !watching, `calls=${calls.join(",")}`);
check("block paused the live embed", calls.join(",") === "pause", calls.join(","));
check("blocked embed chrome is inert", fakeIframe.style.pointerEvents === "none");
ctl.resume();
check("resume refused while blocked", calls.join(",") === "pause", calls.join(","));

// Break end (manual clock) -> unblock + resume in place.
clock.advance(3_000);
if (gatesOk()) {
  ctl.unblock();
  ctl.resume();
  blocked = false;
  watching = true;
}
check("break end resumes in place", watching && calls.join(",") === "pause,play", calls.join(","));
check("unblocked chrome restored", fakeIframe.style.pointerEvents === "");

// Daily cap trip -> NOT breakOnly -> unmount path (no pause-in-place claim).
lock.setPolicy({ dailyCapMinutes: 0.05, sessionCapMinutes: 30 }); // 3s cap
let capTrip = false;
for (let i = 0; i < 10 && watching; i++) {
  lock.addWatch(1_000);
  rhythm.accrue(1_000);
  gate.spend(1_000);
  if (!gatesOk()) {
    watching = false;
    capTrip = !breakOnly();
  }
  clock.advance(1_000);
}
check("cap trip takes the unmount path (no fake pause)", capTrip, `calls=${calls.join(",")}`);

// Points-empty blocks the play gate outright.
const emptyGate = new DokoitsuPointsGate(new MemoryStore(), clock.now);
emptyGate.spend(30 * 60_000);
check("points budget exhaustion blocks play", emptyGate.remainingMs() === 0);

// Dead points server over the real stack -> honest shadow degrade.
const deadHttp = new HttpPointsGate("http://127.0.0.1:59998");
const deadA = await deadHttp.allowance();
check(
  "dead dokoitsu degrades to shadow ledger",
  deadA.connected === false && deadHttp.remainingMs() > 0,
  `connected=${deadA.connected} policy=${deadA.policy}`,
);

process.exit(failed ? 1 : 0);
