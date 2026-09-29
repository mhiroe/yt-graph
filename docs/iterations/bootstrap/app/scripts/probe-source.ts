// Probe the configured source adapter (default fixture) — connectivity smoke.
import { createSourceAdapter } from "../server/sources/index.js";

const seedRef = process.argv[2] ?? "FIXSEED001";
const adapter = createSourceAdapter();
console.log(`adapter: ${adapter.name}`);

const seed = await adapter.resolveChannel(seedRef);
if (!seed) {
  console.error(`probe: seed ${seedRef} not resolved`);
  process.exit(1);
}
console.log(`seed: ${seed.id} ${seed.title}`);

const uploads = await adapter.channelUploads(seed.id);
console.log(`uploads: ${uploads.length}`);

const subs = await adapter.channelSubscriptions(seed.id);
console.log(`subscriptions: ${subs.map((c) => c.title).join(", ")}`);

const playlists = await adapter.channelPlaylists(seed.id);
for (const pl of playlists) {
  const items = await adapter.playlistItems(pl.id);
  const foreign = new Set(items.map((v) => v.channelId).filter((id) => id !== seed.id));
  console.log(`playlist ${pl.id} "${pl.title}": ${items.length} items, ${foreign.size} foreign channels`);
}

const hits = await adapter.searchChannels("kitchen science");
console.log(`search "kitchen science": ${hits.map((c) => c.id).join(", ")}`);
