// Seam self-check run by scripts/smoke.mjs: exercises each adapter in its
// unconnected state and asserts the fail-soft contracts hold.

import {
  createChannelFeed,
  ExportContractFeed,
  FailoverFeed,
  FixtureFeed,
} from "../src/seams/channelFeed";
import {
  createPointsGate,
  DokoitsuPointsGate,
  HttpPointsGate,
  UNCONNECTED_DEFAULT,
} from "../src/seams/pointsGate";
import {
  bindEmbedControl,
  ContentHubWebviewSurface,
  EmbedSurface,
  selectSurface,
  UlBrowserSurface,
  type EmbedPlayer,
  type PlaybackSurfaceAdapter,
} from "../src/seams/playbackSurface";
import { MemoryStore, ParentalLock } from "../src/core/limits";
import { ManualClock } from "../src/core/clock";
import { ViewingRhythm } from "../src/core/rhythm";

// Export contract live path: injected loader returns a valid document.
const liveExport = new ExportContractFeed("x", async () => ({
  channels: [{ id: "UC1", title: "Adopted Channel" }],
}));
const live = await liveExport.listChannels();
if (live.degraded || live.source !== "export" || live.channels.length !== 1) {
  throw new Error(`export path did not serve channels: ${JSON.stringify(live)}`);
}

// Invalid export shape must degrade, not crash.
const badExport = new ExportContractFeed("x", async () => ({ channels: [{ id: 1 }] }));
if (!(await badExport.listChannels()).degraded) {
  throw new Error("invalid export shape was not flagged degraded");
}

const feed = createChannelFeed("auto");
const result = await feed.listChannels();
if (result.channels.length === 0) throw new Error("feed returned no channels");
if (!result.degraded || result.source !== "fixture") {
  throw new Error(`expected degraded fixture feed, got ${result.source} degraded=${result.degraded}`);
}
console.log(`feed: ${result.source} degraded=${result.degraded} channels=${result.channels.length}`);

// Failover prefers a live export over the fixture.
const failover = new FailoverFeed(liveExport, new FixtureFeed());
const preferred = await failover.listChannels();
if (preferred.source !== "export" || preferred.degraded) {
  throw new Error(`failover did not prefer live export: ${JSON.stringify(preferred)}`);
}

const gclock = new ManualClock(Date.parse("2026-10-01T12:00:00"));
const gstore = new MemoryStore();
const gate = createPointsGate("local", gstore, gclock.now);
const allowance = await gate.allowance();
if (allowance.connected) throw new Error("gate unexpectedly connected");
if (allowance.remainingMinutes !== UNCONNECTED_DEFAULT.capMinutes) {
  throw new Error(`unexpected default cap: ${allowance.remainingMinutes}`);
}
// Budget depletes with spend, blocks at zero, rolls over next day.
gate.spend(UNCONNECTED_DEFAULT.capMinutes * 60_000 - 60_000);
if (gate.remainingMs() !== 60_000) {
  throw new Error(`gate remaining wrong: ${gate.remainingMs()}`);
}
gate.spend(60_000);
if (gate.remainingMs() !== 0) throw new Error("gate not empty at cap");
const spent = new DokoitsuPointsGate(gstore, gclock.now);
if (spent.remainingMs() !== 0) throw new Error("gate spend not persisted");
gclock.advance(24 * 3600_000);
if (gate.remainingMs() !== UNCONNECTED_DEFAULT.capMinutes * 60_000) {
  throw new Error("gate budget did not roll over next day");
}
console.log(`gate: ${allowance.policy} cap=${allowance.remainingMinutes}min, spend enforced`);

// HttpPointsGate — the live dokoitsu /parental contract behind injected
// fetch. allowance maps {connected,policy,remainingMinutes,note}; spend
// flushes {ms: DELTA, id}; retry reuses the same id (server dedupe).
const posts: { url: string; body: { ms?: number; id?: string } }[] = [];
const liveGate = new HttpPointsGate("http://dokoitsu.test", {
  shadow: new DokoitsuPointsGate(new MemoryStore(), gclock.now),
  fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/parental/allowance")) {
      return new Response(
        JSON.stringify({
          connected: true,
          remainingMinutes: 12.5,
          policy: "v1",
          note: "週120分・30分見たら10分休憩",
        }),
        { status: 200 },
      );
    }
    if (u.endsWith("/parental/spend")) {
      posts.push({ url: u, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ ok: true, applied: true }), { status: 202 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch,
});
const liveA = await liveGate.allowance();
if (!liveA.connected || liveA.policy !== "v1" || liveA.remainingMinutes !== 12.5) {
  throw new Error(`live allowance not mapped: ${JSON.stringify(liveA)}`);
}
if (liveGate.remainingMs() !== 12.5 * 60_000) {
  throw new Error(`live remainingMs wrong: ${liveGate.remainingMs()}`);
}
liveGate.spend(5_000);
liveGate.spend(7_000);
await liveGate.flushNow();
liveGate.spend(3_000);
await liveGate.flushNow();
if (posts.length !== 2) throw new Error(`expected 2 flushes, got ${posts.length}`);
if (posts[0].body.ms !== 12_000 || posts[1].body.ms !== 3_000) {
  throw new Error(`spend is not delta: ${JSON.stringify(posts)}`);
}
if (!posts[0].body.id || !posts[1].body.id || posts[0].body.id === posts[1].body.id) {
  throw new Error("spend ids missing or not unique");
}
if (liveGate.remainingMs() !== 12.5 * 60_000 - 15_000) {
  throw new Error(`since-fetch accrual wrong: ${liveGate.remainingMs()}`);
}
// Failed flush keeps the same pending id — the retry is a dedupe-safe replay.
let failOnce = true;
const replayPosts: { ms?: number; id?: string }[] = [];
const replayGate = new HttpPointsGate("http://dokoitsu.test", {
  shadow: new DokoitsuPointsGate(new MemoryStore(), gclock.now),
  fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/parental/spend")) {
      replayPosts.push(JSON.parse(String(init?.body ?? "{}")));
      if (failOnce) {
        failOnce = false;
        throw new Error("network down");
      }
      return new Response(JSON.stringify({ ok: true, applied: true }), { status: 202 });
    }
    return new Response(
      JSON.stringify({ connected: true, remainingMinutes: 5, policy: "v1" }),
      { status: 200 },
    );
  }) as typeof fetch,
});
await replayGate.allowance();
replayGate.spend(9_000);
await replayGate.flushNow();
await replayGate.flushNow(); // retry must reuse the same id
if (replayPosts.length !== 2 || replayPosts[0].id !== replayPosts[1].id || replayPosts[0].ms !== 9_000) {
  throw new Error(`retry did not replay the same spend id: ${JSON.stringify(replayPosts)}`);
}
// Break / unmetered shapes: remainingMinutes 0 blocks, null is unmetered.
const breakGate = new HttpPointsGate("http://dokoitsu.test", {
  fetchImpl: (async () =>
    new Response(
      JSON.stringify({
        connected: true,
        remainingMinutes: 0,
        policy: "v1",
        note: "30分見たら10分休憩（休憩中 — 13:40まで）",
      }),
      { status: 200 },
    )) as typeof fetch,
});
const breakA = await breakGate.allowance();
if (breakA.remainingMinutes !== 0 || breakGate.remainingMs() !== 0) {
  throw new Error("enforced break did not zero the budget");
}
const freeGate = new HttpPointsGate("http://dokoitsu.test", {
  fetchImpl: (async () =>
    new Response(
      JSON.stringify({ connected: true, remainingMinutes: null, policy: "v1", note: "制限なし" }),
      { status: 200 },
    )) as typeof fetch,
});
await freeGate.allowance();
if (freeGate.remainingMs() !== Number.POSITIVE_INFINITY) {
  throw new Error("unmetered allowance did not read as infinite");
}
// Dead server -> honest shadow fallback (connected:false, shadow cap applies).
const deadGate = new HttpPointsGate("http://127.0.0.1:9", {
  shadow: new DokoitsuPointsGate(new MemoryStore(), gclock.now),
  fetchImpl: (async () => {
    throw new Error("unreachable");
  }) as typeof fetch,
});
const deadA = await deadGate.allowance();
if (deadA.connected || deadA.policy !== UNCONNECTED_DEFAULT.policy) {
  throw new Error(`dead server did not degrade to shadow: ${JSON.stringify(deadA)}`);
}
deadGate.spend(60_000);
if (deadGate.remainingMs() !== UNCONNECTED_DEFAULT.capMinutes * 60_000 - 60_000) {
  throw new Error("shadow ledger did not track spend while dead");
}
console.log("http-gate: live allowance/spend/delta + id replay + break-0 + unmetered + shadow degrade");

// Parental lock: policy is free until a PIN is set, then change-proof.
const store = new MemoryStore();
const lock = new ParentalLock(store);
if (lock.isLocked()) throw new Error("fresh lock reported locked");
if (!lock.setPolicy({ dailyCapMinutes: 45, sessionCapMinutes: 15 })) {
  throw new Error("unlocked setPolicy rejected");
}
await lock.setPin("1234");
if (!lock.isLocked()) throw new Error("lock did not engage after setPin");
if (lock.setPolicy({ dailyCapMinutes: 999, sessionCapMinutes: 999 })) {
  throw new Error("locked setPolicy was allowed");
}
if (await lock.unlock("0000")) throw new Error("wrong PIN unlocked");
if (!(await lock.unlock("1234"))) throw new Error("correct PIN rejected");
if (!lock.setPolicy({ dailyCapMinutes: 90, sessionCapMinutes: 30 })) {
  throw new Error("post-unlock setPolicy rejected");
}
lock.lock();

// Lock state survives reload (persisted store).
const reloaded = new ParentalLock(store);
if (!reloaded.isLocked()) throw new Error("lock state did not persist");
if (reloaded.policy().dailyCapMinutes !== 90) throw new Error("policy not persisted");

// Watch ledger: accrual, cap enforcement, day rollover.
const clock = new ManualClock(Date.parse("2026-10-01T12:00:00"));
const led = new ParentalLock(store, clock.now);
led.addWatch(89 * 60_000);
if (!led.canWatch()) throw new Error("canWatch false under the cap");
led.addWatch(2 * 60_000);
if (led.canWatch()) throw new Error("canWatch true past the daily cap");
clock.advance(24 * 3600_000);
if (!led.canWatch()) throw new Error("daily ledger did not roll over");
console.log("lock: PIN gate + persisted ledger + daily cap enforced");

// Viewing rhythm: 30 min of accrual forces a 10 min break; accrual during
// a break is ignored and playback is blocked until it ends.
const rclock = new ManualClock(Date.parse("2026-10-01T12:00:00"));
const rhythm = new ViewingRhythm({ watchMs: 30 * 60_000, restMs: 10 * 60_000 }, rclock.now);
for (let i = 0; i < 30; i++) {
  rhythm.accrue(60_000);
  rclock.advance(60_000);
}
if (rhythm.canPlay() || !rhythm.inBreak()) {
  throw new Error("break did not trigger after 30 min of viewing");
}
rhythm.accrue(60_000); // ignored inside a break
rclock.advance(5 * 60_000);
if (rhythm.canPlay()) throw new Error("playback allowed mid-break");
// break started at the t=29min mark (accrue precedes advance), so 4min remain
if (rhythm.breakRemainingMs() !== 4 * 60_000) {
  throw new Error(`break remaining wrong: ${rhythm.breakRemainingMs()}`);
}
rclock.advance(5 * 60_000);
if (!rhythm.canPlay()) throw new Error("playback still blocked after break");
rhythm.accrue(60_000);
if (rhythm.nextBreakInMs() !== 29 * 60_000) {
  throw new Error(`watch counter did not reset: ${rhythm.nextBreakInMs()}`);
}
console.log("rhythm: 30min watch -> 10min enforced break -> resume + reset");

const surface = await selectSurface();
if (surface.name !== "embed") throw new Error(`expected embed fallback, got ${surface.name}`);
// Channel-grain open: a real UC id yields the channel's uploads-playlist
// embed (UC… -> videoseries?list=UU…), playing the channel whole.
const open = await surface.open({ channelId: "UCrrsHarrLoiLTqu1LHxDJpw", title: "めざましテレビ" });
if (
  !open.opened ||
  open.embedUrl !==
    "https://www.youtube-nocookie.com/embed/videoseries?list=UUrrsHarrLoiLTqu1LHxDJpw&enablejsapi=1"
) {
  throw new Error(`embed surface did not produce an uploads playlist: ${JSON.stringify(open)}`);
}
// Non-UC ids (fixtures etc.) carry no derivable uploads playlist — the floor
// reports instead of embedding a bogus playlist URL.
const nonUC = await surface.open({ channelId: result.channels[0].id });
if (nonUC.opened) {
  throw new Error(`non-UC id produced an embed URL: ${JSON.stringify(nonUC)}`);
}

// ContentHub webview seam (contract-level, injected bridge fetch):
// available() mirrors the probe's boolean; open() maps the bridge response.
const liveBridge = new ContentHubWebviewSurface("http://chub", async () =>
  new Response(JSON.stringify({ available: true }), { status: 200 }),
);
if (!(await liveBridge.available())) {
  throw new Error("available bridge was reported unavailable");
}
const openedChub = await new ContentHubWebviewSurface("http://chub", async () =>
  new Response(
    JSON.stringify({ opened: true, url: "https://www.youtube.com/channel/UCrrsHarrLoiLTqu1LHxDJpw" }),
    { status: 200 },
  ),
).open({ channelId: "UCrrsHarrLoiLTqu1LHxDJpw" });
if (!openedChub.opened || openedChub.via !== "contenthub-webview") {
  throw new Error(`bridge open not mapped: ${JSON.stringify(openedChub)}`);
}
const deadBridge = new ContentHubWebviewSurface("http://chub", async () => {
  throw new Error("bridge down");
});
if (await deadBridge.available()) {
  throw new Error("unreachable bridge reported available");
}
const deadOpen = await deadBridge.open({ channelId: "UCrrsHarrLoiLTqu1LHxDJpw" });
if (deadOpen.opened) {
  throw new Error("unreachable bridge reported opened");
}
// Order preserved: ul-browser (stub: unavailable) -> contenthub -> embed.
const pickedChub = await selectSurface([
  new UlBrowserSurface(),
  liveBridge,
  new EmbedSurface(),
]);
if (pickedChub.name !== "contenthub-webview") {
  throw new Error(`available contenthub was skipped for ${pickedChub.name}`);
}

// Selection order: an available preferred adapter wins over the embed floor.
const fakeUl: PlaybackSurfaceAdapter = {
  name: "ul-browser",
  available: async () => true,
  open: async () => ({ opened: true, via: "ul-browser" }),
};
const picked = await selectSurface([fakeUl, new EmbedSurface()]);
if (picked.name !== "ul-browser") {
  throw new Error("an available preferred surface was skipped");
}
console.log(`surface: ${surface.name} -> ${open.embedUrl}`);

// Embed control channel: a stubbed player records the calls the gates make.
// block() must pause AND refuse resume until unblock() — a paused embed must
// not be restartable mid-break. destroy() propagates to the player.
const calls: string[] = [];
const stubPlayer: EmbedPlayer = {
  pauseVideo: () => calls.push("pause"),
  playVideo: () => calls.push("play"),
  destroy: () => calls.push("destroy"),
};
const fakeIframe = { style: { pointerEvents: "" } } as unknown as HTMLIFrameElement;
const ctl = bindEmbedControl(fakeIframe, () => stubPlayer);
if (!(await ctl.ready)) throw new Error("stubbed control reported not ready");
ctl.block();
if (!ctl.isBlocked) throw new Error("block() did not latch");
ctl.resume(); // must be ignored while blocked
if (calls.join(",") !== "pause") {
  throw new Error(`block/resume contract broken: ${calls.join(",")}`);
}
if (fakeIframe.style.pointerEvents !== "none") {
  throw new Error("block() left the embed chrome live");
}
ctl.unblock();
ctl.resume();
if (calls.join(",") !== "pause,play") {
  throw new Error(`resume after unblock did not reach the player: ${calls.join(",")}`);
}
ctl.destroy();
if (calls.join(",") !== "pause,play,destroy") {
  throw new Error(`destroy did not reach the player: ${calls.join(",")}`);
}
// Block issued before the player binds still lands once it is ready
// (gate fires faster than the IFrame API handshake).
const lateCalls: string[] = [];
let bound: EmbedPlayer | null = null;
const lateCtl = bindEmbedControl(fakeIframe, () => {
  bound = { pauseVideo: () => lateCalls.push("pause"), playVideo: () => {}, destroy: () => {} };
  return bound;
});
lateCtl.block();
await lateCtl.ready;
if (lateCalls.join(",") !== "pause") {
  throw new Error(`pre-ready block did not pause on bind: ${lateCalls.join(",")}`);
}
// A factory that cannot produce a player reports ready=false honestly.
const deadCtl = bindEmbedControl(fakeIframe, () => {
  throw new Error("no player");
});
if (await deadCtl.ready) {
  throw new Error("failed bind reported ready");
}
console.log("control: block pauses + latches, resume gated by unblock, degrade honest");

console.log("smoke: all seams fail soft as expected");
