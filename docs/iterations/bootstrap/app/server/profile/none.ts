import type { CuriosityProfile, ProfileAdapter } from "./types.js";

/**
 * Fail-soft default: no profile source wired (dokoitsu is not implemented
 * yet), so the profile is absent and every consumer sees neutral behavior.
 */
export class NullProfile implements ProfileAdapter {
  readonly name = "off";
  async available(): Promise<boolean> {
    return false;
  }
  async profile(): Promise<CuriosityProfile | null> {
    return null;
  }
}
