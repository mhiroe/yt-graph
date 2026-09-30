// Bounded live check for the ContentHub-session source adapter.
// Read-only: yt.session.check + yt.auth.inspect (live kinds) and one data
// read (yt.subscriptions.mine). Fails closed when no live instance claims the
// transport root — it never enqueues a request against a dead owner.
//
// usage: YTG_SOURCE=contenthub pnpm exec tsx scripts/probe-contenthub.ts
//        (env: YTG_CONTENTHUB_ROOT, YTG_CONTENTHUB_TIMEOUT_MS)
import { createSourceAdapter } from "../server/sources/index.js";
import type { ContentHubSourceAdapter } from "../server/sources/contenthub/contenthub-adapter.js";

const adapter = createSourceAdapter("contenthub") as ContentHubSourceAdapter;

if (!adapter.ownerAlive()) {
  console.log("contenthub: no live instance on the yt transport root — skipping (fail closed)");
  process.exit(0);
}

const session = await adapter.sessionCheck();
console.log(`session.check: alive=${session.alive} url=${session.url ?? "?"}`);

const auth = await adapter.authInspect();
console.log(`auth.inspect: authenticated=${auth.authenticated} url=${auth.url ?? "?"}`);

if (!session.alive || !auth.authenticated) {
  console.log("contenthub: session not usable — data reads skipped (fail closed)");
  process.exit(0);
}

// The only user-signal surface this task wires. While the ContentHub
// read-kinds task is unlanded this returns [] with an "Unsupported CLI
// command" envelope on the wire — the round trip itself proves transport.
const mine = await adapter.mySubscriptions();
console.log(`subscriptions.mine: ${mine.length} channels`);
for (const c of mine.slice(0, 10)) console.log(`  ${c.id} ${c.title}`);
