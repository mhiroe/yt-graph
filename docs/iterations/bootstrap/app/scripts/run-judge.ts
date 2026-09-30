// discovery -> judgment on a scratch DB. YTG_JUDGE picks the adapter
// (auto | jev | heuristic); default auto.
import { openDb } from "../server/db.js";
import { createSourceAdapter } from "../server/sources/index.js";
import { createJudgeAdapter } from "../server/judgment/index.js";
import { runDiscovery } from "../server/discovery/pipeline.js";
import { runJudgment } from "../server/judgment/run.js";
import { listCandidates } from "../server/store.js";

const seedRef = process.argv[2] ?? "FIXSEED001";
const handle = openDb(process.env.YTG_DB ?? ":memory:");

await runDiscovery(createSourceAdapter(), seedRef, handle);
const judge = createJudgeAdapter();
const result = await runJudgment(judge, handle);
console.log(`judge: ${result.judge}`);
for (const j of result.judged) console.log(`  ${j.verdict.padEnd(6)} ${j.score.toFixed(2)} ${j.id} ${j.title}`);
for (const s of result.skipped) console.log(`  skip   ${s.id} (${s.reason})`);

const passing = listCandidates(handle).filter((c) => c.judgment?.verdict === "pass");
console.log(`preview-eligible (verdict=pass): ${passing.length}`);
