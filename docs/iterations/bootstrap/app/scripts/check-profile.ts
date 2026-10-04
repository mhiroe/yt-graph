// Connectivity check for the curiosity-profile seam (fixture-only, no live
// calls): absent profile -> neutral fit; fixture profile -> varying fit.
import { createProfileAdapter, profileFit, PROFILE_FIT_NEUTRAL } from "../server/profile/index.js";

for (const name of ["off", "auto"]) {
  const p = createProfileAdapter(name);
  const prof = await p.profile();
  console.log(`${name}: available=${await p.available()} profile=${JSON.stringify(prof)} fit=${profileFit(prof, ["science"])}`);
}
const fx = createProfileAdapter("fixture");
const prof = await fx.profile();
console.log(`fixture: available=${await fx.available()} interests=${prof?.interests.length}`);
console.log(`fit(fermentation,science)=${profileFit(prof, ["fermentation", "science"]).toFixed(2)}`);
console.log(`fit(vlog,crypto)=${profileFit(prof, ["vlog", "crypto"]).toFixed(2)}`);
console.log(`fit(no topics)=${profileFit(prof, [])} neutral=${PROFILE_FIT_NEUTRAL}`);
try {
  createProfileAdapter("dokoitsu");
} catch (e) {
  console.log(`dokoitsu -> ${(e as Error).message}`);
}
