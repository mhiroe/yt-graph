// `VaultScanPort` の filesystem 実装 (cutover CLI が vault / repo root を走査する口)。
//
// **`node:fs` を持つので artifact には入らない** (`src/adapters/fs_document.ts` と同じ境界)。
// `node:fs` / `node:path` は Node 22 と Deno 2 の built-in。外部 package は足さない。

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { err, ok, type Result } from "../result.ts";
import type { VaultScanPort } from "./scan.ts";

/**
 * 走査対象外の directory。
 *
 * **この convention は `f1/sandbox.ts` の `SKIP_DIRECTORIES` が正本。** vault manifest 側が
 * 「`.` で始まる directory + `node_modules`」を除外しているので、cutover の走査も同じ範囲に
 * 揃える (見る集合と書きうる集合を同じにする f1 の考え方)。
 * symlink は辿らない — vault 外へ出る loop を避ける。
 */
function skippableDirectory(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/**
 * `root` 配下の Markdown を走査する `VaultScanPort` を作る。
 *
 * - `files()`: 再帰で拾った `.md` file (case-insensitive) を root 相対 path、
 *   `/` 区切り、sort 済みで返す。
 * - `read()`: file 本文を UTF-8 で読む。失敗は `err` で返し、呼び出し側が `unreadable`
 *   finding に畳む (ここで throw しない)。
 */
export function createFsVaultScan(root: string): VaultScanPort {
  const files = (): readonly string[] => {
    const found: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (skippableDirectory(entry.name)) continue;
          walk(join(directory, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        if (!entry.name.toLowerCase().endsWith(".md")) continue;
        // locator と揃えるため separator は常に `/`。
        const relativePath = relative(root, join(directory, entry.name)).split("\\").join("/");
        found.push(relativePath);
      }
    };
    walk(root);
    return found.sort();
  };
  const read = (path: string): Result<string> => {
    try {
      return ok(readFileSync(join(root, path), "utf8"));
    } catch (cause) {
      return err("document_not_found", `${path} を読めない: ${String(cause)}`, "path");
    }
  };
  return { files, read };
}
