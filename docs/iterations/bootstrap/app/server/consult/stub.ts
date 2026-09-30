import type { ConsultAdapter, ConsultInput, Suggestion } from "./types.js";

/**
 * Deterministic consult for fixture verification (YTG_CONSULT=stub) — the
 * defaults resolve to fixture searchIndex tokens that the seed's own
 * surfaces cannot reach, proving the consult path adds new channels.
 */
export class StubConsult implements ConsultAdapter {
  readonly name = "stub";

  constructor(
    private readonly suggestions: Suggestion[] = [
      { query: "glass", rationale: "adjacent craft content" },
      { query: "crypto", rationale: "speculative interest probe" },
    ],
  ) {}

  async available(): Promise<boolean> {
    return true;
  }

  async suggest(_input: ConsultInput): Promise<Suggestion[]> {
    return this.suggestions;
  }
}
