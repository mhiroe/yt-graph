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

// dokoitsu owns :8787 from this client's view (the yt-graph API also
// defaults there — when both run, yt-graph moves via YTG_API_PORT).
export const DEFAULT_DOKOITSU_URL = "http://127.0.0.1:8787";

// Live points gate: the settled `/parental` contract on dokoitsu
// (docs/spec_parental.md — GET allowance / POST spend {ms: DELTA, id?}).
// The shadow gate stays embedded: `spend` always accrues locally and any
// reachability gap degrades to the shadow cap — connected:false is honest,
// never faked.
export class HttpPointsGate implements PointsGateAdapter {
  readonly name = "dokoitsu-http";
  private readonly shadow: PointsGateAdapter;
  private readonly f: typeof fetch;
  private readonly refreshMs: number;
  private connected = false;
  private unmetered = false;
  private serverRemainingMs = 0;
  private sinceFetchMs = 0;
  private pendingId: string | null = null;
  private pendingMs = 0;
  private flushing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly baseUrl: string = DEFAULT_DOKOITSU_URL,
    opts: {
      shadow?: PointsGateAdapter;
      fetchImpl?: typeof fetch;
      refreshMs?: number;
    } = {},
  ) {
    this.shadow = opts.shadow ?? new DokoitsuPointsGate();
    this.f = opts.fetchImpl ?? fetch;
    this.refreshMs = opts.refreshMs ?? 10_000;
  }

  async allowance(): Promise<PointsAllowance> {
    const live = await this.fetchAllowance();
    return live ?? this.shadow.allowance();
  }

  // spend() stays synchronous per the contract — deltas accumulate into a
  // pending buffer that the interval flushes as one POST. A failed flush is
  // retried with the SAME id so the server's 500-id dedupe makes the retry
  // a no-op (replay -> applied:false), never a double count.
  spend(ms: number): void {
    this.shadow.spend(ms);
    this.pendingMs += ms;
    this.sinceFetchMs += ms;
    this.ensureTimer();
  }

  remainingMs(): number {
    if (!this.connected) return this.shadow.remainingMs();
    if (this.unmetered) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.serverRemainingMs - this.sinceFetchMs);
  }

  private async fetchAllowance(): Promise<PointsAllowance | null> {
    try {
      const r = await this.f(`${this.baseUrl}/parental/allowance`);
      if (!r.ok) return null;
      const b = (await r.json()) as {
        connected?: boolean;
        remainingMinutes?: number | null;
        policy?: string;
        note?: string;
      };
      if (b.connected !== true) return null;
      this.connected = true;
      this.unmetered = b.remainingMinutes === null || b.remainingMinutes === undefined;
      this.serverRemainingMs = this.unmetered ? 0 : (b.remainingMinutes as number) * 60_000;
      this.sinceFetchMs = 0;
      this.ensureTimer();
      return {
        connected: true,
        remainingMinutes: b.remainingMinutes ?? null,
        policy: b.policy ?? "v1",
        note: b.note,
      };
    } catch {
      this.connected = false;
      return null;
    }
  }

  // One modest interval drives both jobs: refresh the folded allowance (also
  // picks up server-side break end while nothing is playing) and flush the
  // pending spend delta. unref'd under node so checks exit cleanly.
  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.fetchAllowance();
      void this.flush();
    }, this.refreshMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  // Exposed for checks and a future page-hide flush; the interval is the
  // steady path.
  async flushNow(): Promise<void> {
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.pendingMs <= 0) return;
    this.flushing = true;
    const id =
      this.pendingId ??
      (this.pendingId =
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `sp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const ms = this.pendingMs;
    try {
      const r = await this.f(`${this.baseUrl}/parental/spend`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ms, id }),
      });
      // 202 either way: applied:true counted it now, applied:false means a
      // replay the server already folded — the delta is safe to drop.
      if (r.status === 202) {
        this.pendingMs -= ms;
        this.pendingId = null;
      }
    } catch {
      this.connected = false;
    } finally {
      this.flushing = false;
    }
  }
}

export function createPointsGate(
  kind: string = "auto",
  store: LockStore = defaultStore(),
  now: Clock = systemClock,
  opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): PointsGateAdapter {
  const shadow = new DokoitsuPointsGate(store, now);
  if (kind === "local" || kind === "shadow") return shadow;
  // auto/http/dokoitsu: the hybrid — live contract when reachable, shadow
  // ledger otherwise.
  return new HttpPointsGate(opts.baseUrl ?? DEFAULT_DOKOITSU_URL, {
    shadow,
    fetchImpl: opts.fetchImpl,
  });
}
