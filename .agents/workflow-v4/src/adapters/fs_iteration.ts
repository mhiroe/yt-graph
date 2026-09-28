// filesystem 上の iteration layout を `IterationFsPort` として見せる runtime binding。
//
// **この file は `src/contract.ts` から辿れない** (`fs_document.ts` と同じ境界)。
// fs は SQLite transaction に乗らないので、ここが失敗した時の整合は DB state から
// `iteration.repair` が組み直す。skeleton / symlink はこの port が担い、
// Markdown 本文 (`*.md`) は `DocumentPort` のまま分離する。

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync as realpathSyncNode,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { err, ok, type Result } from "../result.ts";
import {
  ITERATION_SKELETON_DIRS,
  type IterationActiveFact,
  type IterationCurrentFact,
  type IterationDirFact,
  type IterationFsPort,
  type IterationMemberFact,
  type IterationTreeScan,
} from "../iterations.ts";

/**
 * 走査対象外の directory。`f1/sandbox.ts` の `SKIP_DIRECTORIES` / `fs_scan.ts` の
 * `skippableDirectory` と同じ convention — vault の見る範囲と揃える。
 * **tree -> DB rebuild への影響**: この下に置かれた generated stamp は rebuild の
 * 入力にならない (membership が欠けるだけで iteration 行は dir skeleton から復元
 * される)。committed tree に stamp が隠れ dir / node_modules に置かれることは
 * 想定しない — 裁定済みの default。
 */
function skippableDirectory(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

/**
 * symlink `link` (repo root 相対) の生 target を link の dir 基準で解決し、
 * repo root 相対に正規化して返す。root の外を指す / 絶対 path なら undefined。
 */
function resolveLinkTarget(link: string, rawTarget: string): string | undefined {
  if (isAbsolute(rawTarget)) return undefined;
  const fromDir = link.split("/").slice(0, -1);
  const segments = [...fromDir, ...rawTarget.split("/")];
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) return undefined; // root を出る
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  const rel = normalized.join("/");
  return rel === "" ? undefined : rel;
}

/**
 * repo root の外を指す path を拒否する。fs_document.ts の `resolveInsideRoot` と
 * 同じ方針 (lexical + realpath) を、この port が必要とする最小形で持つ。
 */
function resolveInsideRoot(root: string, relative: string): Result<string> {
  if (isAbsolute(relative)) {
    return err("locator_escapes_repository", `絶対 path は受け付けない: ${relative}`, "path");
  }
  const segments = relative.split("/");
  if (
    relative.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return err(
      "locator_escapes_repository",
      `repo 内の安全な相対 path ではない: ${relative}`,
      "path",
    );
  }
  const rootReal = existsSync(root) ? realpathSync(root) : resolve(root);
  const target = resolve(rootReal, relative);
  if (!(target === rootReal || target.startsWith(rootReal + sep))) {
    return err("locator_escapes_repository", `repo root の外を指す path: ${relative}`, "path");
  }
  return ok(target);
}

/**
 * `IterationFsPort` の filesystem 実装。
 *
 * - `createSkeleton` は `<dir>` が既に在れば fail closed。既存 dir の中を
 *   勝手に埋めない (`iteration.open` の「target dir が在れば閉じて失敗」裁定)。
 * - `writeSymlink` は既存が symlink の時だけ張り替える。実体 file/dir を
 *   上書きしない。
 * - 全部 repo root 相対で受ける。絶対 path / `..` はここで弾く。
 */
export function createFsIterationPort(root: string): IterationFsPort {
  return {
    exists(relPath: string): boolean {
      const resolved = resolveInsideRoot(root, relPath);
      if (!resolved.ok) return false;
      // lstat で symlink 自身の存在も拾う (stat だと dangling link を見落とす)。
      return existsSync(resolved.value) || isLink(resolved.value);
    },

    createSkeleton(iterDir: string): Result<{ created: boolean }> {
      const resolved = resolveInsideRoot(root, iterDir);
      if (!resolved.ok) return resolved;
      if (existsSync(resolved.value) || isLink(resolved.value)) {
        return err(
          "invalid_iteration_label",
          `iteration dir は既に存在する (上書きしない): ${iterDir}`,
          "name",
        );
      }
      // 親は作るが、iteration dir 自身は recursive でない mkdir で「既存」を確実に失敗させる。
      mkdirSync(dirname(resolved.value), { recursive: true });
      try {
        mkdirSync(resolved.value);
      } catch {
        return err(
          "invalid_iteration_label",
          `iteration dir を作れなかった (既に在る?): ${iterDir}`,
          "name",
        );
      }
      for (const sub of ITERATION_SKELETON_DIRS) {
        mkdirSync(join(resolved.value, sub));
      }
      return ok({ created: true });
    },

    writeSymlink(link: string, target: string): Result<{ changed: boolean }> {
      const resolved = resolveInsideRoot(root, link);
      if (!resolved.ok) return resolved;
      const existing = lstatSyncSafe(resolved.value);
      if (existing !== undefined) {
        if (!existing.isSymbolicLink()) {
          return err(
            "invalid_locator",
            `symlink の張り替え先が symlink でない実体 (上書きしない): ${link}`,
            "path",
          );
        }
        if (readlinkSync(resolved.value) === target) {
          return ok({ changed: false });
        }
        rmSync(resolved.value);
      }
      mkdirSync(dirname(resolved.value), { recursive: true });
      symlinkSync(target, resolved.value);
      return ok({ changed: true });
    },

    readSymlink(link: string): Result<string | undefined> {
      const resolved = resolveInsideRoot(root, link);
      if (!resolved.ok) return resolved;
      const existing = lstatSyncSafe(resolved.value);
      if (existing === undefined) return ok(undefined);
      if (!existing.isSymbolicLink()) {
        return err(
          "invalid_locator",
          `readSymlink の対象が symlink でない: ${link}`,
          "path",
        );
      }
      return ok(readlinkSync(resolved.value));
    },

    removeSymlink(link: string): Result<{ changed: boolean }> {
      const resolved = resolveInsideRoot(root, link);
      if (!resolved.ok) return resolved;
      const existing = lstatSyncSafe(resolved.value);
      if (existing === undefined) return ok({ changed: false });
      if (!existing.isSymbolicLink()) {
        return err(
          "invalid_locator",
          `removeSymlink の対象が symlink でない実体 (消さない): ${link}`,
          "path",
        );
      }
      rmSync(resolved.value);
      return ok({ changed: true });
    },

    listSymlinks(dir: string): Result<readonly string[]> {
      const resolved = resolveInsideRoot(root, dir);
      if (!resolved.ok) return resolved;
      const existing = lstatSyncSafe(resolved.value);
      if (existing === undefined) return ok([]);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        return err(
          "invalid_locator",
          `listSymlinks の対象が dir でない (managed dir の外側を触らない): ${dir}`,
          "path",
        );
      }
      const names: string[] = [];
      for (const entry of readdirSync(resolved.value, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) {
          // managed `active/` の中の非 symlink は fail closed — repair の prune が
          // 実体 file/dir を消してしまわないよう、ここで読み取りを止める。
          return err(
            "invalid_locator",
            `${dir} の中に symlink でない entry がある: ${entry.name}`,
            "path",
          );
        }
        names.push(entry.name);
      }
      return ok(names);
    },

    ensureSkeleton(iterDir: string): Result<{ created: boolean }> {
      const resolved = resolveInsideRoot(root, iterDir);
      if (!resolved.ok) return resolved;
      if (isLink(resolved.value)) {
        return err(
          "invalid_iteration_label",
          `iteration dir の位置が symlink (埋めない): ${iterDir}`,
          "name",
        );
      }
      // git は空 dir を commit しないので、committed tree では subdir が欠けうる。
      // repair は欠けた分だけを補う — 既存を消したり上書きしたりはしない。
      mkdirSync(resolved.value, { recursive: true });
      let created = false;
      for (const sub of ITERATION_SKELETON_DIRS) {
        const subPath = join(resolved.value, sub);
        if (existsSync(subPath)) continue;
        mkdirSync(subPath);
        created = true;
      }
      return ok({ created });
    },

    scanTree(): Result<IterationTreeScan> {
      const rootReal = existsSync(root) ? realpathSync(root) : resolve(root);
      const dirs: IterationDirFact[] = [];
      const currents: IterationCurrentFact[] = [];
      const actives: IterationActiveFact[] = [];
      const members: IterationMemberFact[] = [];
      const shapeDirs: string[] = [];

      const walk = (directory: string, relative: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const entryRel = relative === "" ? entry.name : `${relative}/${entry.name}`;
          const entryAbs = join(directory, entry.name);
          if (entry.isSymbolicLink()) {
            if (entry.name === "current") {
              const target = resolveLinkTarget(entryRel, readlinkSync(entryAbs));
              currents.push(
                target === undefined
                  ? { link: entryRel, invalid: true }
                  : { link: entryRel, target },
              );
            }
            // symlink dir は辿らない (loop 防止)。
            continue;
          }
          if (entry.name === "current") {
            currents.push({ link: entryRel, invalid: true });
            continue;
          }
          if (!entry.isDirectory()) continue;
          if (skippableDirectory(entry.name)) continue;
          if (entry.name === "active") {
            // `<p>/active/` / `docs/active/` — managed link dir (schema 7)。
            // 中身を active fact として記録し、この dir 自身は辿らない
            // (link 先が別の iteration dir なので、辿ると二重計上になる)。
            for (const inner of readdirSync(entryAbs, { withFileTypes: true })) {
              const linkRel = `${entryRel}/${inner.name}`;
              if (!inner.isSymbolicLink()) {
                actives.push({ link: linkRel, invalid: true });
                continue;
              }
              const target = resolveLinkTarget(linkRel, readlinkSync(join(entryAbs, inner.name)));
              actives.push(
                target === undefined ? { link: linkRel, invalid: true } : { link: linkRel, target },
              );
            }
            continue;
          }
          walk(entryAbs, entryRel);
          // `<p>/<label>/{docs|spec|app}` の形。label / scope の解釈は planner が行う。
          const skeleton = ITERATION_SKELETON_DIRS.filter((sub) =>
            existsSync(join(entryAbs, sub)) && !isLink(join(entryAbs, sub))
          );
          if (skeleton.length > 0 && relative !== "") {
            shapeDirs.push(entryRel);
            dirs.push({ dir: entryRel, skeleton });
          }
        }
      };
      walk(rootReal, "");

      // skeleton subdir 直下の symlink = member link 候補。
      for (const dir of shapeDirs) {
        for (const sub of ITERATION_SKELETON_DIRS) {
          const subAbs = join(rootReal, dir, sub);
          if (!existsSync(subAbs)) continue;
          for (const entry of readdirSync(subAbs, { withFileTypes: true })) {
            if (!entry.isSymbolicLink()) continue;
            const linkRel = `${dir}/${sub}/${entry.name}`;
            const target = resolveLinkTarget(linkRel, readlinkSync(join(subAbs, entry.name)));
            members.push({
              iteration_dir: dir,
              link: linkRel,
              ...(target === undefined ? { escapes: true } : { target }),
            });
          }
        }
      }
      return ok({ dirs, currents, actives, members });
    },
  };
}

function lstatSyncSafe(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function isLink(path: string): boolean {
  return lstatSyncSafe(path)?.isSymbolicLink() === true;
}

function realpathSync(path: string): string {
  try {
    return realpathSyncNode(path);
  } catch {
    return resolve(path);
  }
}
