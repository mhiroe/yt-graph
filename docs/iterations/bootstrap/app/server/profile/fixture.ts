import type { CuriosityProfile, ProfileAdapter } from "./types.js";

const FIXTURE_PROFILE: CuriosityProfile = {
  provenance: "fixture",
  interests: [
    { tag: "fermentation", weight: 1.0 },
    { tag: "science", weight: 0.9 },
    { tag: "physics", weight: 0.8 },
    { tag: "kitchen", weight: 0.8 },
    { tag: "chemistry", weight: 0.7 },
    { tag: "diy", weight: 0.5 },
    { tag: "orbits", weight: 0.4 },
  ],
};

/**
 * Canned profile for fixture runs and tests — same domain as
 * sources/fixture, so the DNA-vs-profile fit path is exercisable without a
 * real dokoitsu supply.
 */
export class FixtureProfile implements ProfileAdapter {
  readonly name = "fixture";
  async available(): Promise<boolean> {
    return true;
  }
  async profile(): Promise<CuriosityProfile | null> {
    return FIXTURE_PROFILE;
  }
}
