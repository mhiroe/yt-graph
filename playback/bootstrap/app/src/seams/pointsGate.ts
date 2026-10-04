// Learning-points gate seam — viewing budget is granted by study points,
// whose source is the partner side (dokoitsu). Dokoitsu is unimplemented,
// so the seam keeps a local shadow ledger under a fail-soft default
// policy while unconnected — playback is capped, not unmetered and not
// hard-blocked. When the pipe lands, `spend`/`allowance` proxy to it and
// the point balance replaces the flat cap.

import { systemClock, type Clock } from "../core/clock";
import { defaultStore, type LockStore } from "../core/limits";

export type PointsAllowance = {
  connected: boolean;
  // minutes of viewing currently permitted; null = unmetered
  remainingMinutes: number | null;
  policy: string;
  note?: string;
};

export interface PointsGateAdapter {
  readonly name: string;
  allowance(): Promise<PointsAllowance>;
  // Record consumed viewing. Unconnected adapters keep a local shadow
  // ledger; a connected one would report spend to the points source.
  spend(ms: number): void;
  // Synchronous budget check for the play gate.
  remainingMs(): number;
}

// Provisional default — point semantics (earn/spend rate, ledger location)
// are an open question on the wish. Conservative cap aligned with the
// 30-min viewing rhythm until the user pins the policy.
export const UNCONNECTED_DEFAULT = { policy: "unconnected-default", capMinutes: 30 } as const;

const STORE_KEY = "yt-playback.points.v1";

type Persisted = { ledger: Record<string, number> }; // local date -> spent ms

function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export class DokoitsuPointsGate implements PointsGateAdapter {
  readonly name = "dokoitsu";
  private state: Persisted;

  constructor(
    private readonly store: LockStore = defaultStore(),
    private readonly now: Clock = systemClock,
  ) {
    const raw = store.getItem(STORE_KEY);
    this.state = raw ? (JSON.parse(raw) as Persisted) : { ledger: {} };
  }

  async allowance(): Promise<PointsAllowance> {
    return {
      connected: false,
      remainingMinutes: Math.ceil(this.remainingMs() / 60_000),
      policy: UNCONNECTED_DEFAULT.policy,
      note: "dokoitsu points pipe not connected",
    };
  }

  spend(ms: number): void {
    const key = dayKey(this.now());
    this.state.ledger[key] = (this.state.ledger[key] ?? 0) + ms;
    this.store.setItem(STORE_KEY, JSON.stringify(this.state));
  }

  remainingMs(): number {
    const spent = this.state.ledger[dayKey(this.now())] ?? 0;
    return Math.max(0, UNCONNECTED_DEFAULT.capMinutes * 60_000 - spent);
  }
}

export function createPointsGate(
  _kind: string = "auto",
  store: LockStore = defaultStore(),
  now: Clock = systemClock,
): PointsGateAdapter {
  return new DokoitsuPointsGate(store, now);
}
