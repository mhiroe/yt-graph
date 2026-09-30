// ContentHub file-transport client (pure file client — no daemon, no IPC).
//
// Contract: ContentHub `docs/iterations/rebuild/spec_contenthub_process.md`
// "transport contract". A request is a JSON envelope
// `{id, type: "<service>.<kind>", created_at, input}` dropped into
// `<root>/.transport/outbox/<id>.json` via tmp+rename; the instance claims it
// (`outbox/.claimed/<id>.json`) and writes the response to
// `inbox/<id>.json`:
//   {schema_version: 1, type: "<service>.response", request_id, received_at,
//    output: {...}}                          — success
//   {..., output: {}, error: {name, message, code, status, url}} — failure
// Client duties per the contract: atomic tmp+rename write, bounded wait
// (floor 90s to cover the claim window; recommended default 120s), drain the
// delivered response into `archive/`, and never leave a timed-out request in
// the outbox (an unclaimed one would re-fire whenever an instance spawns).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** No live instance claimed this transport root — fail closed, never enqueue. */
export class ChubUnavailableError extends Error {
  override readonly name = "ChubUnavailableError";
}

/** The instance answered with an error envelope. */
export class ChubCommandError extends Error {
  override readonly name: string = "ChubCommandError";
}

/** The instance is live but does not know this kind yet (read kinds pending). */
export class ChubUnsupportedError extends ChubCommandError {
  override readonly name = "ChubUnsupportedError";
}

export type ChubTransportOptions = {
  /** Transport root — the dir that contains `.transport/`. */
  root: string;
  /** Response wait ceiling. Contract floor is 90s; default 120s. */
  timeoutMs?: number;
  /** Inbox poll interval. */
  pollMs?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ChubTransport {
  private readonly outbox: string;
  private readonly inbox: string;
  private readonly archive: string;
  private readonly ownerFile: string;
  private readonly timeoutMs: number;
  private readonly pollMs: number;

  constructor(options: ChubTransportOptions) {
    const transportDir = join(options.root, ".transport");
    this.outbox = join(transportDir, "outbox");
    this.inbox = join(transportDir, "inbox");
    this.archive = join(transportDir, "archive");
    this.ownerFile = join(transportDir, "owner.json");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  /**
   * Is an instance currently claiming this root? Contract: owner.json carries
   * the owner pid; liveness is `kill(pid, 0)` (EPERM = alive, matching the
   * host's own guard). Never infer liveness from the file's mere existence —
   * a dead owner leaves a stale owner.json behind.
   */
  ownerAlive(): boolean {
    let pid: number;
    try {
      const owner = JSON.parse(readFileSync(this.ownerFile, "utf8")) as { pid?: unknown };
      if (typeof owner.pid !== "number") return false;
      pid = owner.pid;
    } catch {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the process exists but belongs to another session — alive.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /**
   * Drop one command envelope and wait for its response. Returns the
   * response `output` object. Throws ChubUnavailableError when no live owner
   * exists or the wait times out, ChubUnsupportedError when the instance
   * does not implement the kind, ChubCommandError on other error envelopes.
   */
  async request(type: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.ownerAlive()) {
      throw new ChubUnavailableError(
        `ContentHub: no live owner at ${this.ownerFile} — not enqueueing ${type} ` +
          `(an outbox write would spawn a visible instance via LaunchAgent)`,
      );
    }

    const id = `ytg-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const envelope = { id, type, created_at: new Date().toISOString(), input };

    // Atomic publish: same-dir tmp file without a .json suffix, then rename.
    const tmp = join(this.outbox, `.${id}.tmp`);
    const requestFile = join(this.outbox, `${id}.json`);
    writeFileSync(tmp, JSON.stringify(envelope));
    renameSync(tmp, requestFile);

    const responseFile = join(this.inbox, `${id}.json`);
    const deadline = Date.now() + this.timeoutMs;
    try {
      while (Date.now() < deadline) {
        if (existsSync(responseFile)) {
          const response = JSON.parse(readFileSync(responseFile, "utf8")) as {
            request_id?: string;
            output?: Record<string, unknown>;
            error?: { name?: string; message?: string };
          };
          this.drain(responseFile, id);
          if (response.error) {
            const message = response.error.message ?? "unknown ContentHub error";
            if (/unsupported cli command/i.test(message)) {
              throw new ChubUnsupportedError(`${type}: ${message}`);
            }
            throw new ChubCommandError(`${type}: ${message}`);
          }
          return response.output ?? {};
        }
        await sleep(this.pollMs);
      }
    } finally {
      // Client duty: a timed-out request must not stay in the outbox. Only the
      // unclaimed file is ours to remove — a claimed one is the instance's.
      if (!existsSync(responseFile)) rmSync(requestFile, { force: true });
    }
    throw new ChubUnavailableError(
      `ContentHub: ${type} timed out after ${this.timeoutMs}ms (no inbox response)`,
    );
  }

  /** Move the delivered response out of the inbox (inbox is a route, not a cache). */
  private drain(responseFile: string, id: string): void {
    try {
      mkdirSync(this.archive, { recursive: true });
      renameSync(responseFile, join(this.archive, `${id}.response.json`));
    } catch {
      rmSync(responseFile, { force: true });
    }
  }
}
