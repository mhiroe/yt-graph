import type { SourceChannel } from "../sources/index.js";

/** A candidate the consult layer asks the source adapter to resolve. */
export type Suggestion = {
  query: string; // channel name / search query to resolve through the source
  rationale?: string; // why the consult suggested it — kept as evidence detail
};

export type ConsultInput = {
  seed: SourceChannel;
  fingerprint: string[];
};

/**
 * Swappable consult layer (chappy CLI wall-bounce / stub / off).
 * Suggestions are resolved through the source adapter, so the consult itself
 * never needs YouTube access.
 */
export interface ConsultAdapter {
  readonly name: string;
  /** Cheap, side-effect-free gate — never spawns ContentHub or a login window. */
  available(): Promise<boolean>;
  /** Fail-soft: implementations return [] rather than throwing. */
  suggest(input: ConsultInput): Promise<Suggestion[]>;
}
