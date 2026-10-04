import type { ProfileAdapter } from "./types.js";
import { NullProfile } from "./none.js";
import { FixtureProfile } from "./fixture.js";

/**
 * Profile selection seam: YTG_PROFILE=auto | fixture | off (default auto).
 * The real source is dokoitsu — not implemented yet, so `auto` falls back to
 * the fail-soft NullProfile (absent profile -> neutral consumers). When a
 * dokoitsu adapter lands it registers here and `auto` probes it first.
 */
export function createProfileAdapter(name = process.env.YTG_PROFILE ?? "auto"): ProfileAdapter {
  switch (name) {
    case "auto":
    case "off":
      return new NullProfile();
    case "fixture":
      return new FixtureProfile();
    default:
      throw new Error(`unknown profile adapter: ${name} (auto | fixture | off)`);
  }
}

export type { CuriosityProfile, InterestAxis, ProfileAdapter } from "./types.js";
export { PROFILE_FIT_NEUTRAL, profileFit } from "./types.js";
