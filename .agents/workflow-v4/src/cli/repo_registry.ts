// vault 側の device-local repo registry (v4 provision contract)。
//
// `<root>/.workflow.nosync/repositories.json` に、この device から見えている repo の
// `repository_id -> root` を持つ。**`.nosync` 配下なので iCloud sync も git commit も
// されない。**device ごとに root path は違うので、registry は sync される tracked file に
// 置けない。
//
// registry は lookup table であって正本ではない。entry が消えても repo 自体は壊れない。
// 正本の identity は各 repo の `.workflow/repository.json` が持つ。
//
// 書き込みは `adapters/fs_document.ts` と同じ atomic replacement。同じ directory へ tmp を
// 書いてから rename するので、途中で落ちても読み手は旧 file か新 file のどちらかを見る。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { err, ok, type Result } from "../result.ts";
import { dbDir } from "./provision.ts";

const REGISTRY_NAME = "repositories.json";

export type RegistryEntry = {
  readonly repository_id: string;
  readonly root: string;
};

/** `<root>/.workflow.nosync/repositories.json`。 */
export function registryPath(root: string): string {
  return join(dbDir(root), REGISTRY_NAME);
}

/**
 * registry の entry 一覧を読む。
 *
 * - file が無い → `ok([])`。**未 provision の vault を「壊れ」にしない。**
 * - JSON が壊れている、形が contract と違う → `invalid_field_type`。
 */
export function loadRegistry(root: string): Result<RegistryEntry[]> {
  const path = registryPath(root);
  if (!existsSync(path)) return ok([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    return err(
      "invalid_field_type",
      `repositories.json を読めない: ${String(cause)}`,
      "repositories",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err(
      "invalid_field_type",
      "repositories.json は object である必要がある",
      "repositories",
    );
  }
  const repositories = (parsed as Record<string, unknown>)["repositories"];
  if (typeof repositories !== "object" || repositories === null || Array.isArray(repositories)) {
    return err(
      "invalid_field_type",
      "repositories.json の repositories は object である必要がある",
      "repositories",
    );
  }
  const entries: RegistryEntry[] = [];
  for (const [repositoryId, value] of Object.entries(repositories)) {
    const entryRoot = typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)["root"]
      : undefined;
    if (typeof entryRoot !== "string") {
      return err(
        "invalid_field_type",
        `repositories.${repositoryId}.root は string である必要がある`,
        `repositories.${repositoryId}.root`,
      );
    }
    entries.push({ repository_id: repositoryId, root: entryRoot });
  }
  return ok(entries);
}

/**
 * entry を upsert する。
 *
 * - 同じ id が無い → `created`。同じ id で違う root → `updated` (repo の移動を追う)。
 * - id と root が一致する entry が既にある → `present`。**file を書かない。**
 */
export function addRegistryEntry(
  root: string,
  entry: RegistryEntry,
): Result<"created" | "updated" | "present"> {
  const loaded = loadRegistry(root);
  if (!loaded.ok) return loaded;
  const existing = loaded.value.find((candidate) =>
    candidate.repository_id === entry.repository_id
  );
  if (existing !== undefined && existing.root === entry.root) return ok("present");
  const next = existing === undefined
    ? [...loaded.value, entry]
    : loaded.value.map((candidate) =>
      candidate.repository_id === entry.repository_id ? entry : candidate
    );
  writeRegistry(root, next);
  return ok(existing === undefined ? "created" : "updated");
}

/**
 * entry を外す。**registry file を書き換えるだけで、repo の file も DB も消さない。**
 * 無かった id は `absent`。entry が空になっても file は `{"repositories":{}}` として残す
 * (「無い」と「空」を分けないため)。
 */
export function removeRegistryEntry(
  root: string,
  repositoryId: string,
): Result<"removed" | "absent"> {
  const loaded = loadRegistry(root);
  if (!loaded.ok) return loaded;
  const next = loaded.value.filter((entry) => entry.repository_id !== repositoryId);
  if (next.length === loaded.value.length) return ok("absent");
  writeRegistry(root, next);
  return ok("removed");
}

function writeRegistry(root: string, entries: readonly RegistryEntry[]): void {
  const repositories: Record<string, { readonly root: string }> = {};
  for (const entry of entries) {
    repositories[entry.repository_id] = { root: entry.root };
  }
  const target = registryPath(root);
  mkdirSync(dirname(target), { recursive: true });
  writeAtomic(target, `${JSON.stringify({ repositories })}\n`);
}

/**
 * atomic file replacement (fs_document.ts と同じ)。同じ directory へ temp file を書いてから
 * rename する。rename が atomic なのは同一 filesystem 内だけなので、temp を別 directory に
 * 置かない。
 */
function writeAtomic(target: string, content: string): void {
  const temp = `${target}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temp, content, "utf8");
  try {
    renameSync(temp, target);
  } catch (cause) {
    // rename が失敗したら temp を残さない。次の write が拾って古い内容を書き戻す事故を避ける。
    if (existsSync(temp)) unlinkSync(temp);
    throw cause;
  }
}
