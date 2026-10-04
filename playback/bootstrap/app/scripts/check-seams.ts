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
  UNCONNECTED_DEFAULT,
} from "../src/seams/pointsGate";
import {
  EmbedSurface,
  selectSurface,
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
const gate = createPointsGate("auto", gstore, gclock.now);
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
const open = await surface.open({ videoId: result.channels[0].sampleVideoId ?? "FIXV00" });
if (!open.opened || !open.embedUrl?.includes("youtube-nocookie.com")) {
  throw new Error(`embed surface did not produce a target: ${JSON.stringify(open)}`);
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

console.log("smoke: all seams fail soft as expected");
