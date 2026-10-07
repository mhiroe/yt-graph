// headless CLI の entry point。repo-local Workflow Core を terminal から開く薄い入口。
//
// **持たないもの**: interactive UI、daemon、HTTP server、generic SQL 経路、v3 skill との接続。
// **持つもの**: repository / device identity の照合、JSON request / response 1 往復、安定した exit code。
//
// **stdout は JSON 1 行だけ。例外なく全ての終了経路で 1 行出す。** usage も引数不足も JSON を出し、
// usage の説明文は stderr にだけ置く。stdout に JSON 以外を混ぜると呼び出し側が parse できない。
//
// 使い方:
//
//   deno run --allow-read --allow-write --allow-ffi --allow-env src/cli/main.ts \
//     --repository-id dotfiles --device-id dev-macbook \
//     --db .workflow/dotfiles.sqlite --root . \
//     --request '{"kind":"workflow.capabilities"}'
//
// `--request` を省くと stdin から読む。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

import {
  declareCrossRepo,
  declareDocument,
  declareReadModel,
  declareReplication,
  sliceACapabilities,
  type WorkflowCapabilities,
} from "../capabilities.ts";
import { parseRepositoryId } from "../ids.ts";
import type { WorkflowErrorCode } from "../result.ts";
import { openNodeSqliteDriver } from "../adapters/node_sqlite.ts";
import { createFsDocumentPort } from "../adapters/fs_document.ts";
import { createFsIterationPort } from "../adapters/fs_iteration.ts";
import { createGitIterationHistory } from "../adapters/git_iteration_history.ts";
import { SqliteWorkflowStore } from "../sql/store.ts";
import { vaultComponentIdAllocator } from "../sql/transaction.ts";
import {
  createSqliteDocumentProjectionPort,
  locatorResolverOf,
} from "../sql/document_projection.ts";
import { createFsVaultScan } from "../cutover/fs_scan.ts";
import {
  CLI_EXIT_BAD_REQUEST,
  CLI_EXIT_UNAVAILABLE,
  type CliExitCode,
  type CliResponse,
  dispatch,
} from "./dispatch.ts";

export const ID_STYLES = ["vault", "operation"] as const;
export type IdStyle = (typeof ID_STYLES)[number];

type Options = {
  readonly repository_id: string;
  readonly device_id: string;
  readonly db: string;
  readonly root: string;
  readonly id_style: IdStyle;
  readonly migrate: boolean;
  readonly request?: string;
};

const USAGE = [
  "usage: workflow-cli --repository-id <id> --device-id <id> --db <path> [--root <dir>]",
  "                    [--id-style vault|operation] [--request <json>] [--migrate]",
  "",
  "--id-style vault (既定) は my-wish-data.md の <prefix>-<Crockford base32 10 桁> で採番する。",
  "operation は内部形 c-<operation_id>。**実 vault では混ぜない。**",
  "--migrate は実装より古い schema_version の DB へ forward migration を適用して開く。",
  "",
  "request を省くと stdin から JSON を 1 件読む。stdout は JSON 1 行、診断は stderr。",
  "exit code: 0=applied/noop 1=開けない 2=request 不正 3=rejected/conflict/not_found",
].join("\n");

type ArgvResult =
  | { readonly ok: true; readonly value: Options }
  | { readonly ok: false; readonly message: string };

function parseArgs(argv: readonly string[]): ArgvResult {
  const values = new Map<string, string>();
  // 値を取らない flag。`--name value` の形と混ぜないため、先に個別で拾う。
  let migrate = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--migrate") {
      migrate = true;
      continue;
    }
    if (arg === undefined || !arg.startsWith("--")) {
      return { ok: false, message: `option は --name value の形である必要がある: ${String(arg)}` };
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      return { ok: false, message: `${arg} に値が無い` };
    }
    values.set(arg.slice(2), next);
    i += 1;
  }
  const missing = ["repository-id", "device-id", "db"].filter((name) => !values.has(name));
  if (missing.length > 0) {
    return { ok: false, message: `必須 option が足りない: ${missing.join(", ")}` };
  }
  const request = values.get("request");
  const idStyleRaw = values.get("id-style") ?? "vault";
  const idStyle = ID_STYLES.find((candidate) => candidate === idStyleRaw);
  if (idStyle === undefined) {
    return { ok: false, message: `--id-style は ${ID_STYLES.join(" か ")}: ${idStyleRaw}` };
  }
  return {
    ok: true,
    value: {
      repository_id: values.get("repository-id") ?? "",
      device_id: values.get("device-id") ?? "",
      db: values.get("db") ?? "",
      root: values.get("root") ?? process.cwd(),
      id_style: idStyle,
      migrate,
      ...(request === undefined ? {} : { request }),
    },
  };
}

/**
 * CLI が宣言する capability。document write / projection (Slice C)、replication (Slice D) に
 * 加えて、Slice E で cross-repo recovery を持つ。read model query 一式はまだ無いので
 * `declareReadModel()` は呼ばない。未宣言は「持たない」であって「多分使える」ではない。
 */
export function cliCapabilities(repositoryIdValue: string): WorkflowCapabilities | undefined {
  const repositoryId = parseRepositoryId(repositoryIdValue, "repository_id");
  if (!repositoryId.ok) return undefined;
  const base = sliceACapabilities(repositoryId.value);
  const withDocument = declareDocument({
    ...base,
    // receipt だけは実装済みなので宣言する。
    supported_queries: [...base.supported_queries, "operation.get_receipt"],
  }, { write: true, projection: true });
  const withReplication = declareReplication(withDocument, { replication: true });
  const withCrossRepo = declareCrossRepo(withReplication, { recovery: true });
  // relation query 2 つを実装したので宣言する (Slice F1 の O2-1)。
  // **read model 一式ではない。**実装した query だけを挙げる。未宣言は「持たない」。
  return declareReadModel(withCrossRepo, [
    "operation.get_receipt",
    // 7b gap 2。operation_id を失った client が receipt へ戻れる口。
    "operation.list",
    "component.list",
    "wish_query.preflight",
    "relation.list_outgoing",
    "relation.find_outgoing_to",
  ]);
}

/**
 * stdout へ JSON 1 行を書き、exit code を設定する。
 *
 * **`writeFileSync(1, ...)` を使い、`process.exit()` を呼ばない。** `process.stdout.write()` は
 * pipe 相手では非同期で、直後に `process.exit()` すると書き終わる前に process が落ちて
 * stdout が truncate されうる。fd への同期 write と `process.exitCode` なら、event loop が
 * 自然に空になってから終了するので、全経路で 1 行が確実に出る。
 */
function emit(response: CliResponse): void {
  writeFileSync(1, `${JSON.stringify(response)}\n`);
  process.exitCode = response.exit_code;
}

/** 診断は stderr だけに出す。stdout には 1 byte も混ぜない。 */
function diagnostic(text: string): void {
  writeFileSync(2, text.endsWith("\n") ? text : `${text}\n`);
}

function failure(
  kind: string,
  code: WorkflowErrorCode,
  message: string,
  exit: CliExitCode,
  path?: string,
): CliResponse {
  diagnostic(`error: ${code}: ${message}`);
  return {
    kind,
    ok: false,
    exit_code: exit,
    error: path === undefined ? { code, message } : { code, message, path },
  };
}

function main(): void {
  const parsedArgs = parseArgs(process.argv.slice(2));
  if (!parsedArgs.ok) {
    // usage の説明文は stderr だけ。stdout は JSON のまま保つ。
    diagnostic(USAGE);
    emit(failure("usage", "missing_field", parsedArgs.message, CLI_EXIT_UNAVAILABLE, "argv"));
    return;
  }
  const options = parsedArgs.value;

  const capabilities = cliCapabilities(options.repository_id);
  if (capabilities === undefined) {
    emit(failure(
      "usage",
      "invalid_id",
      `repository_id が id 形式でない: ${options.repository_id}`,
      CLI_EXIT_UNAVAILABLE,
      "repository_id",
    ));
    return;
  }

  // conventional path (`<root>/.workflow.nosync/workflow.sqlite`) を cold に使えるよう、
  // open の前に DB の親 directory を作る。`:memory:` は file を持たないので触らない。
  // **失敗をここで止めない。**mkdir が失敗するなら open も失敗するので、本物の error は
  // open が返す。
  if (options.db !== ":memory:") {
    try {
      mkdirSync(dirname(options.db), { recursive: true });
    } catch {
      // open が実際の失敗を報告するので、ここでは握る。
    }
  }

  // identity の照合は store が持つ。configured 値と DB の row が違えば開かない。
  const opened = SqliteWorkflowStore.open({
    driver: openNodeSqliteDriver({ location: options.db }),
    repository_id: options.repository_id,
    device_id: options.device_id,
    durable: options.db !== ":memory:",
    migrate: options.migrate,
  });
  if (!opened.ok) {
    diagnostic(`error: ${opened.error.code}: ${opened.error.message}`);
    emit({ kind: "open", ok: false, exit_code: CLI_EXIT_UNAVAILABLE, error: opened.error });
    return;
  }
  const store = opened.value;

  try {
    let requestText = options.request;
    if (requestText === undefined) {
      try {
        requestText = readFileSync(0, "utf8");
      } catch (cause) {
        emit(failure(
          "stdin",
          "missing_field",
          `stdin を読めない: ${String(cause)}`,
          CLI_EXIT_UNAVAILABLE,
          "request",
        ));
        return;
      }
    }

    let request: unknown;
    try {
      request = JSON.parse(requestText);
    } catch (cause) {
      emit(failure(
        "request",
        "invalid_field_type",
        `request が JSON として読めない: ${String(cause)}`,
        CLI_EXIT_BAD_REQUEST,
        "request",
      ));
      return;
    }

    const response = dispatch({
      store,
      capabilities,
      // **実 vault を触る入口なので vault 形を既定にする** (裁定 root PM 2026-09-15)。
      // 内部形が要る呼び出しだけ `--id-style operation` を付ける。
      ...(options.id_style === "vault"
        ? { allocate_component_id: vaultComponentIdAllocator(store) }
        : {}),
      document: createFsDocumentPort({
        root: options.root,
        resolve_locator: locatorResolverOf(store),
      }),
      projection: createSqliteDocumentProjectionPort(store),
      // v4 provision contract。`repository.provision` / `registry.*` が repo root と
      // 実際に開いた DB path を必要とする。
      root: options.root,
      db: options.db,
      // cutover (`cutover.scan` / `bind` / `audit`) の Markdown 走査口。
      vault_scan: createFsVaultScan(options.root),
      // iteration (schema 6) の派生 fs state。skeleton / symlink を組み、
      // `iteration.repair` が DB から再構成する口にもなる。
      iteration_fs: createFsIterationPort(options.root),
      // iteration.repair の first-commit reconstruction (0.24.0-era recipe)。
      // git へ spawn するので `--allow-run` が無い環境では port 自体が err を返し、
      // repair は従来どおり fail closed する。
      iteration_history: createGitIterationHistory(options.root),
    }, request);

    if (!response.ok && response.error !== undefined) {
      diagnostic(`error: ${response.error.code}: ${response.error.message}`);
    }
    emit(response);
  } finally {
    // どの経路でも DB handle を閉じる。閉じ忘れると event loop が残って終了が遅れる。
    store.close();
  }
}

main();
