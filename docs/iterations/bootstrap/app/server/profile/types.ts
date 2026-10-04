// Curiosity-profile adapter types. The profile is the viewer's interest
// signature, supplied from outside this repo (dokoitsu planned). Consumers —
// the cheap judgment tiers — talk only to this seam.

/** One weighted interest axis of the viewer profile. */
export type InterestAxis = {
  tag: string;    // lowercase topic term, e.g. "fermentation"
  weight: number; // 0..1 affinity
};

export type CuriosityProfile = {
  interests: InterestAxis[];
  /** where the profile came from (adapter name / snapshot ref) */
  provenance?: string;
};

/**
 * Swappable curiosity-profile source. Fail-soft contract: an absent or
 * unreachable profile resolves to null — consumers treat null as neutral,
 * never as an error.
 */
export interface ProfileAdapter {
  readonly name: string;
  /** Cheap, side-effect-free probe — no service spawns, no network. */
  available(): Promise<boolean>;
  /** The current profile, or null when none is configured/reachable. */
  profile(): Promise<CuriosityProfile | null>;
}

/** Neutral fit prior when no profile exists — one place, like verdictFor. */
export const PROFILE_FIT_NEUTRAL = 0.5;

/**
 * DNA-vs-profile fit for the cheap tiers: noisy-OR over the interest axes the
 * channel's topic terms match — one strong match already lifts the fit,
 * several compound toward 1, no match -> 0. Absent profile (or nothing to
 * compare against) -> PROFILE_FIT_NEUTRAL.
 */
export function profileFit(profile: CuriosityProfile | null, topics: string[]): number {
  if (!profile || profile.interests.length === 0 || topics.length === 0) {
    return PROFILE_FIT_NEUTRAL;
  }
  const tags = new Set(topics);
  let miss = 1;
  for (const axis of profile.interests) {
    if (tags.has(axis.tag)) miss *= 1 - axis.weight;
  }
  return miss === 1 ? 0 : 1 - miss;
}
