// `IterationHistoryPort` の git 実装 — iteration.repair の first-commit
// reconstruction recipe (0.24.0-era defect、ul-browser 2026-09-30 の手動 repair
// を実装化) が使う metadata の出所。
//
// generated stamp を持つ file が 1 枚も無い iteration dir は seq / created_at を
// frontmatter から復元できない。その場合の記録源は「その dir を初めて commit した
// commit」だけ: `git log --diff-filter=A --format=%aI --reverse -- <dir>` の先頭
// commit の author date を `created_at` に使う (ISO8601 UTC へ正規化)。
//
// **この file は `src/contract.ts` から辿れない** (`fs_iteration.ts` と同じ境界)。
// git を呼べない環境 (非 git repo、spawn 不可、`--allow-run` 無し) は `err` を返し、
// repair 側が従来どおり fail closed する。

import { err, ok, type Result } from "../result.ts";
import type { IterationHistoryPort } from "../iterations.ts";

/**
 * `git log` 経由で dir の first commit metadata を読む port を作る。
 *
 * - dir が一度も commit されていなければ `ok(undefined)`。
 * - git binary 不在 / repo でない / spawn 禁止なら `err` (記録無しとは区別する)。
 * - 返すのは author date。`%aI` は local offset 付きなので UTC (`...Z`) へ正規化する
 *   (stamp の `iteration_created` と同じ形)。
 */
export function createGitIterationHistory(root: string): IterationHistoryPort {
  const decoder = new TextDecoder();
  return {
    firstCommit(dir: string): Result<string | undefined> {
      let output: Deno.CommandOutput;
      try {
        output = new Deno.Command("git", {
          args: [
            "-C",
            root,
            "log",
            "--diff-filter=A",
            "--format=%aI",
            "--reverse",
            "--",
            dir,
          ],
          stdout: "piped",
          stderr: "piped",
        }).outputSync();
      } catch (cause) {
        return err(
          "unsupported_feature",
          `git log を起動できない (spawn 不可 / git 不在): ${String(cause)}`,
          "dir",
        );
      }
      if (!output.success) {
        const stderr = decoder.decode(output.stderr).trim();
        return err(
          "unsupported_feature",
          `git log が失敗した: ${stderr === "" ? `exit ${output.code}` : stderr}`,
          "dir",
        );
      }
      const first = decoder.decode(output.stdout).split("\n").find((line) => line.trim() !== "");
      if (first === undefined) return ok(undefined);
      const parsed = new Date(first.trim());
      if (Number.isNaN(parsed.getTime())) {
        return err(
          "invalid_field_type",
          `git の %aI が解読できない: ${first}`,
          "dir",
        );
      }
      return ok(parsed.toISOString());
    },
  };
}
