// v4 provision contract。repo 内の identity manifest と device-local な DB 置き場を整える。
//
// **この file は filesystem IO を持つ** (`adapters/fs_document.ts` と同じ境界)。request 形状の
// 検査は `dispatch.ts` が持ち、ここは「root 配下の file を読み書きする」だけを担当する。
//
// layout:
//
//   <root>/.workflow/repository.json          repository_id の manifest。**tracked な file。**
//                                             git commit / vault sync に乗せて、clone や別
//                                             device へも repository identity を伝える。
//   <root>/.workflow.nosync/                  device-local な置き場。`.nosync` suffix で
//                                             iCloud sync から外れ、dot prefix で Obsidian
//                                             からも見えない。
//   <root>/.workflow.nosync/workflow.sqlite   DB の conventional path。
//
// DB は sync も commit もしないので `.nosync` 側へ置く。git repo では `.gitignore` に
// `/.workflow.nosync/` を確実に入れて、誤って commit されないようにする。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { err, ok, type Result } from "../result.ts";

/** repository_id manifest を置く tracked な directory。 */
export const WORKFLOW_DIR = ".workflow";
/** device-local な置き場。iCloud は `.nosync` suffix の directory を sync しない。 */
export const LOCAL_DIR = ".workflow.nosync";
/** conventional な DB file 名。 */
export const DB_NAME = "workflow.sqlite";

const MANIFEST_NAME = "repository.json";
const GITIGNORE_LINE = "/.workflow.nosync/";

/** `<root>/.workflow/repository.json`。 */
export function manifestPath(root: string): string {
  return join(root, WORKFLOW_DIR, MANIFEST_NAME);
}

/** `<root>/.workflow.nosync`。registry (`repositories.json`) もここへ置く。 */
export function dbDir(root: string): string {
  return join(root, LOCAL_DIR);
}

/** `<root>/.workflow.nosync/workflow.sqlite`。 */
export function dbPath(root: string): string {
  return join(dbDir(root), DB_NAME);
}

/**
 * 開いている DB の path が conventional path を指すか。
 *
 * `--db` は相対でも渡せるので、両側を解決してから比べる。`:memory:` は解決すると
 * cwd 直下の file 名と見なされて conventional と必ず違うので、`db_conventional: false` に
 * なる。それでよい: in-memory は永続化しないので conventional ではない。
 */
export function isConventionalDb(root: string, db: string): boolean {
  return resolve(db) === resolve(dbPath(root));
}

/**
 * manifest に書かれた repository_id を読む。
 *
 * - file が無い → `ok(undefined)`。
 * - file はあるのに読めない → `document_not_found`。
 * - JSON が壊れている、`repository_id` が string でない → `invalid_field_type`。
 *
 * **「無い」と「壊れている / 読めない」を区別する。**壊れた manifest を「無い」へ倒して
 * 上書きすると、repository identity を黙って差し替える事故になる。
 */
export function manifestRepositoryId(root: string): Result<string | undefined> {
  const path = manifestPath(root);
  if (!existsSync(path)) return ok(undefined);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    return err("document_not_found", `manifest を読めない: ${String(cause)}`, "manifest");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return err(
      "invalid_field_type",
      `manifest が JSON として読めない: ${String(cause)}`,
      "manifest",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err("invalid_field_type", "manifest は object である必要がある", "manifest");
  }
  const repositoryId = (parsed as Record<string, unknown>)["repository_id"];
  if (typeof repositoryId !== "string") {
    return err(
      "invalid_field_type",
      "manifest の repository_id は string である必要がある",
      "manifest.repository_id",
    );
  }
  return ok(repositoryId);
}

export type ProvisionReport = {
  /** manifest を今回書いたか、既にあったか。違う id の manifest は失敗なのでここへ来ない。 */
  readonly manifest_state: "created" | "present";
  /** `.gitignore` の対応結果。`.git` が無い root (git 管理でない vault 等) では `no_git`。 */
  readonly gitignore: "created" | "appended" | "present" | "no_git";
  readonly db_dir: string;
  readonly db: string;
};

/**
 * provision contract を root へ適用する。**idempotent。**2 回目以降は manifest を書かず
 * `manifest_state: "present"` を返す。
 *
 * 既存 manifest の id が違う場合は `repository_id_mismatch` で失敗させる。tracked file を
 * 上書きすると identity の差し替えになるので、ここでは絶対に書き戻さない。
 */
export function provisionRepository(
  root: string,
  repositoryId: string,
): Result<ProvisionReport> {
  const manifestId = manifestRepositoryId(root);
  if (!manifestId.ok) return manifestId;
  let manifestState: ProvisionReport["manifest_state"];
  if (manifestId.value === undefined) {
    const manifest = manifestPath(root);
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, `${JSON.stringify({ repository_id: repositoryId })}\n`, "utf8");
    manifestState = "created";
  } else if (manifestId.value !== repositoryId) {
    return err(
      "repository_id_mismatch",
      `manifest の repository_id ${JSON.stringify(manifestId.value)} と ${
        JSON.stringify(repositoryId)
      } が一致しない`,
      "manifest.repository_id",
    );
  } else {
    manifestState = "present";
  }
  const dir = dbDir(root);
  mkdirSync(dir, { recursive: true });
  return ok({
    manifest_state: manifestState,
    gitignore: ensureGitignore(root),
    db_dir: dir,
    db: dbPath(root),
  });
}

/**
 * `.git` がある root の `.gitignore` に `/.workflow.nosync/` を確実に入れる。
 *
 * `.git` は通常 directory だが **worktree では file** なので、形を見ず存在だけを見る。
 * `.git` が無いなら ignore の必要自体が無いので、書かずに `no_git` を報告する。
 */
function ensureGitignore(root: string): ProvisionReport["gitignore"] {
  if (!existsSync(join(root, ".git"))) return "no_git";
  const path = join(root, ".gitignore");
  if (!existsSync(path)) {
    writeFileSync(
      path,
      `# ${LOCAL_DIR} は device-local の DB 置き場。sync も commit もしない。\n${GITIGNORE_LINE}\n`,
      "utf8",
    );
    return "created";
  }
  const text = readFileSync(path, "utf8");
  // 末尾の空白 (CRLF の `\r` 含む) までは gitignore が無視するので、trim してから比べる。
  // 行頭の空白は gitignore 上意味を持つので、触らない。
  if (text.split("\n").some((line) => line.trimEnd() === GITIGNORE_LINE)) {
    return "present";
  }
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${text}${separator}${GITIGNORE_LINE}\n`, "utf8");
  return "appended";
}
