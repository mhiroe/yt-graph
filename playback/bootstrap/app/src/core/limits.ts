// Viewing limits + parental lock — a parent sets the viewing caps and
// locks them behind a PIN; while locked, the policy cannot change.
//
// Mockup-grade by design (wish open question: PIN vs local account vs
// device-side constraint is still undecided): PIN is a local SHA-256
// digest in the app's own storage — enough to validate the UX, not a
// security boundary. Enforcement survives reload via persisted state.

import { systemClock, type Clock } from "./clock";

export type LimitPolicy = {
  dailyCapMinutes: number;
  sessionCapMinutes: number;
};

export const DEFAULT_POLICY: LimitPolicy = {
  dailyCapMinutes: 60,
  sessionCapMinutes: 30,
};

export interface LockStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class MemoryStore implements LockStore {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

export function defaultStore(): LockStore {
  return typeof localStorage === "undefined" ? new MemoryStore() : localStorage;
}

const STORE_KEY = "yt-playback.v1";

type Persisted = {
  policy: LimitPolicy;
  pinHash: string | null;
  locked: boolean;
  ledger: Record<string, number>; // local date -> watched ms
};

async function digest(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export class ParentalLock {
  private state: Persisted;
  constructor(
    private readonly store: LockStore = defaultStore(),
    private readonly now: Clock = systemClock,
  ) {
    const raw = store.getItem(STORE_KEY);
    this.state = raw
      ? (JSON.parse(raw) as Persisted)
      : { policy: { ...DEFAULT_POLICY }, pinHash: null, locked: false, ledger: {} };
  }

  private persist(): void {
    this.store.setItem(STORE_KEY, JSON.stringify(this.state));
  }

  // Locked only once a PIN exists — first setup is always open.
  isLocked(): boolean {
    return this.state.locked && this.state.pinHash !== null;
  }

  policy(): LimitPolicy {
    return { ...this.state.policy };
  }

  // Returns false when a locked policy change is attempted.
  setPolicy(policy: LimitPolicy): boolean {
    if (this.isLocked()) return false;
    this.state.policy = { ...policy };
    this.persist();
    return true;
  }

  async setPin(pin: string): Promise<boolean> {
    if (this.isLocked()) return false;
    this.state.pinHash = await digest(pin);
    this.state.locked = true;
    this.persist();
    return true;
  }

  async unlock(pin: string): Promise<boolean> {
    if (this.state.pinHash === null) return false;
    if ((await digest(pin)) !== this.state.pinHash) return false;
    this.state.locked = false;
    this.persist();
    return true;
  }

  lock(): void {
    if (this.state.pinHash === null) return;
    this.state.locked = true;
    this.persist();
  }

  // ---- watch ledger ----

  addWatch(ms: number): void {
    const key = dayKey(this.now());
    this.state.ledger[key] = (this.state.ledger[key] ?? 0) + ms;
    this.persist();
  }

  watchedTodayMs(): number {
    return this.state.ledger[dayKey(this.now())] ?? 0;
  }

  remainingTodayMs(): number {
    return Math.max(0, this.state.policy.dailyCapMinutes * 60_000 - this.watchedTodayMs());
  }

  canWatch(): boolean {
    return this.remainingTodayMs() > 0;
  }
}
