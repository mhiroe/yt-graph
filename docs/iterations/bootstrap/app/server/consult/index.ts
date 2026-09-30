import type { ConsultAdapter, ConsultInput, Suggestion } from "./types.js";
import { ChappyConsult } from "./chappy.js";
import { StubConsult } from "./stub.js";

/** Disabled consult — always unavailable, suggests nothing. */
class NullConsult implements ConsultAdapter {
  readonly name = "off";
  async available(): Promise<boolean> {
    return false;
  }
  async suggest(_input: ConsultInput): Promise<Suggestion[]> {
    return [];
  }
}

/**
 * Consult selection seam: YTG_CONSULT=auto | chappy | stub | off (default auto).
 * auto uses chappy — its `available()` gate checks `chappy status` without
 * spawning ContentHub, so an unattended run never stalls or pops a login
 * window when the ChatGPT session is signed out.
 */
export function createConsultAdapter(name = process.env.YTG_CONSULT ?? "auto"): ConsultAdapter {
  switch (name) {
    case "chappy":
    case "auto":
      return new ChappyConsult();
    case "stub":
      return new StubConsult();
    case "off":
      return new NullConsult();
    default:
      throw new Error(`unknown consult adapter: ${name} (auto | chappy | stub | off)`);
  }
}

export type { ConsultAdapter, ConsultInput, Suggestion } from "./types.js";
