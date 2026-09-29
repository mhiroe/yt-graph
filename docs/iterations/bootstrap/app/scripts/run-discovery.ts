// Run one discovery pass against the fixture adapter on a scratch DB.
// usage: tsx scripts/run-discovery.ts [seedRef]   (YTG_DB=:memory: default here)
import { openDb } from "../server/db.js";
import { createSourceAdapter } from "../server/sources/index.js";
import { runDiscovery } from "../server/discovery/pipeline.js";
import { listCandidates } from "../server/store.js";

const seedRef = process.argv[2] ?? "FIXSEED001";
const handle = openDb(process.env.YTG_DB ?? ":memory:");
const adapter = createSourceAdapter();

const result = await runDiscovery(adapter, seedRef, handle);
console.log(`seed: ${result.seed.title} (${result.seed.id})`);
console.log(`fingerprint: ${result.fingerprint.join(", ")}`);
console.log(`raw hits: ${result.raw_count}, kept: ${result.kept.length}, dropped: ${result.dropped.length}`);
for (const c of result.kept) console.log(`  + ${c.id} ${c.title} [${c.sources.join("+")}]`);
for (const d of result.dropped) console.log(`  - ${d.id} (${d.reason})`);

const persisted = listCandidates(handle);
const withEvidence = persisted.filter((c) => c.evidence_count > 0);
console.log(`persisted: ${persisted.length} channels, ${withEvidence.length} with evidence`);
