import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConsultAdapter, ConsultInput, Suggestion } from "./types.js";

const execFileP = promisify(execFile);

const MAX_SUGGESTIONS = 5;
const STATUS_TIMEOUT_MS = 10_000;
const REQUEST_WAIT_SEC = 120;
// --wait only bounds the post-send wait; cold ContentHub start adds its own
// grace, so the outer kill is generous but still bounded for unattended runs.
const REQUEST_TIMEOUT_MS = 200_000;

/** One-line consult prompt — chappy request takes a single-line body. */
export function buildPrompt(input: ConsultInput): string {
  const fp = input.fingerprint.slice(0, 8).join(", ");
  const desc = input.seed.description ? ` — ${input.seed.description.slice(0, 200)}` : "";
  return [
    `You help discover YouTube channels. Seed channel: "${input.seed.title}"${desc}.`,
    `Fingerprint terms: ${fp || "n/a"}.`,
    `Suggest up to ${MAX_SUGGESTIONS} real YouTube channels a viewer of the seed would find interesting — similar topics but distinct voices.`,
    `Reply with ONLY a JSON array: [{"query":"<channel name or search query>","rationale":"<one phrase>"}].`,
  ].join(" ");
}

/** Extract the first JSON array of {query} objects from a chat reply. */
export function parseSuggestions(text: string): Suggestion[] {
  const match = /\[[\s\S]*\]/.exec(text);
  if (!match) return [];
  try {
    const arr: unknown = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s: unknown) => (typeof s === "string" ? { query: s } : s))
      .filter(
        (s): s is Suggestion =>
          typeof s === "object" && s !== null &&
          typeof (s as Suggestion).query === "string" && (s as Suggestion).query.length > 0,
      );
  } catch {
    return [];
  }
}

/**
 * chappy CLI consult — one bounded request per expansion pass.
 * `available()` inspects `chappy status` only: no ContentHub spawn, so an
 * unattended run never pops a manual-login window. `suggest()` runs
 * `chappy request --wait`, which may cold-start ContentHub (~25s+).
 */
export class ChappyConsult implements ConsultAdapter {
  readonly name = "chappy";

  async available(): Promise<boolean> {
    try {
      const { stdout } = await execFileP("chappy", ["status"], { timeout: STATUS_TIMEOUT_MS });
      const account = /^\s*account:\s*(.+)$/m.exec(stdout)?.[1]?.trim() ?? "";
      return account.length > 0 && !/^(unavailable|not authenticated|unknown)/.test(account);
    } catch {
      return false;
    }
  }

  async suggest(input: ConsultInput): Promise<Suggestion[]> {
    try {
      const { stdout } = await execFileP(
        "chappy",
        ["request", buildPrompt(input), "--wait", String(REQUEST_WAIT_SEC)],
        { timeout: REQUEST_TIMEOUT_MS },
      );
      return parseSuggestions(stdout).slice(0, MAX_SUGGESTIONS);
    } catch {
      return [];
    }
  }
}
