// Minimal ContentHub file-transport client for the playback bridge.
//
// Mirrors the contract in ContentHub
// `docs/iterations/rebuild/spec_contenthub_process.md` "transport contract":
// request envelopes `{id, type, created_at, input}` land in
// `<root>/.transport/outbox/<id>.json` via tmp+rename; the instance claims it
// (`outbox/.claimed/`) and answers in `inbox/<id>.json` as
// `<service>.response` carrying `output` or `error`. Client duties honored
// here: atomic publish, bounded wait, drain delivered responses to archive/,
// and NEVER leave or send a request against a dead owner (an outbox write
// would spawn a visible instance via LaunchAgent).
//
// Kept local to the playback component — the separable-component contract
// forbids importing from docs/iterations/bootstrap/app.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export class ChubUnavailableError extends Error {
  override readonly name = "ChubUnavailableError";
}

export class ChubCommandError extends Error {
  override readonly name = "ChubCommandError";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ChubClient {
  private readonly outbox: string;
  private readonly inbox: string;
  private readonly archive: string;
  private readonly ownerFile: string;

  constructor(
    root: string,
    private readonly timeoutMs = 120_000,
    private readonly pollMs = 250,
  ) {
    const t = join(root, ".transport");
    this.outbox = join(t, "outbox");
    this.inbox = join(t, "inbox");
    this.archive = join(t, "archive");
    this.ownerFile = join(t, "owner.json");
  }

  /** Is a live instance claiming this root? owner.json carries the pid;
   *  liveness is kill(pid,0) (EPERM = alive) — a stale file alone says nothing. */
  ownerAlive(): boolean {
    try {
      const owner = JSON.parse(readFileSync(this.ownerFile, "utf8")) as { pid?: unknown };
      if (typeof owner.pid !== "number") return false;
      process.kill(owner.pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /** Drop one command envelope, wait for the response, return `output`.
   *  Throws ChubUnavailableError when no live owner or on timeout,
   *  ChubCommandError on an error envelope. */
  async request(type: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.ownerAlive()) {
      throw new ChubUnavailableError(
        `no live ContentHub owner at ${this.ownerFile} — not enqueueing ${type}`,
      );
    }
    const id = `pb-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const tmp = join(this.outbox, `.${id}.tmp`);
    const requestFile = join(this.outbox, `${id}.json`);
    writeFileSync(tmp, JSON.stringify({ id, type, created_at: new Date().toISOString(), input }));
    renameSync(tmp, requestFile);

    const responseFile = join(this.inbox, `${id}.json`);
    const deadline = Date.now() + this.timeoutMs;
    try {
      while (Date.now() < deadline) {
        if (existsSync(responseFile)) {
          const res = JSON.parse(readFileSync(responseFile, "utf8")) as {
            output?: Record<string, unknown>;
            error?: { name?: string; message?: string };
          };
          try {
            mkdirSync(this.archive, { recursive: true });
            renameSync(responseFile, join(this.archive, `${id}.response.json`));
          } catch {
            rmSync(responseFile, { force: true });
          }
          if (res.error) throw new ChubCommandError(`${type}: ${res.error.message ?? "unknown"}`);
          return res.output ?? {};
        }
        await sleep(this.pollMs);
      }
    } finally {
      // A timed-out request must not stay in the outbox (claim orphans re-fire).
      if (!existsSync(responseFile)) rmSync(requestFile, { force: true });
    }
    throw new ChubUnavailableError(`${type} timed out after ${this.timeoutMs}ms`);
  }
}
