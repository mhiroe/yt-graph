// Seam self-check run by scripts/smoke.mjs: exercises each adapter in its
// unconnected state and asserts the fail-soft contracts hold.

import { createChannelFeed } from "../src/seams/channelFeed";
import { createPointsGate, UNCONNECTED_DEFAULT } from "../src/seams/pointsGate";
import { selectSurface } from "../src/seams/playbackSurface";

const feed = createChannelFeed("auto");
const result = await feed.listChannels();
if (result.channels.length === 0) throw new Error("feed returned no channels");
if (!result.degraded || result.source !== "fixture") {
  throw new Error(`expected degraded fixture feed, got ${result.source} degraded=${result.degraded}`);
}
console.log(`feed: ${result.source} degraded=${result.degraded} channels=${result.channels.length}`);

const gate = createPointsGate("auto");
const allowance = await gate.allowance();
if (allowance.connected) throw new Error("gate unexpectedly connected");
if (allowance.remainingMinutes !== UNCONNECTED_DEFAULT.capMinutes) {
  throw new Error(`unexpected default cap: ${allowance.remainingMinutes}`);
}
console.log(`gate: ${allowance.policy} cap=${allowance.remainingMinutes}min`);

const surface = await selectSurface();
if (surface.name !== "embed") throw new Error(`expected embed fallback, got ${surface.name}`);
const open = await surface.open({ videoId: result.channels[0].sampleVideoId ?? "FIXV00" });
if (!open.opened || !open.embedUrl?.includes("youtube-nocookie.com")) {
  throw new Error(`embed surface did not produce a target: ${JSON.stringify(open)}`);
}
console.log(`surface: ${surface.name} -> ${open.embedUrl}`);

console.log("smoke: all seams fail soft as expected");
