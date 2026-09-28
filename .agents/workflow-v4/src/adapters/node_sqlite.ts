// `node:sqlite` を `SqlDriver` へ束ねる runtime binding。
//
// **この file は `src/mod.ts` から公開しない。** 公開入口が runtime module を辿ると、
// wishboard の bundler が browser 向け build で `node:sqlite` を解決しようとして壊れる。
// 依存ゼロ方針を保つ境界はここ 1 file であり、必要な runtime だけがこの path を直接 import する。
//
// `node:sqlite` は Node 22 と Deno 2 が持つ built-in module であり、外部 package を足さない。

import { DatabaseSync } from "node:sqlite";
import type { SqlDriver, SqlStatement, SqlValue } from "../sql/driver.ts";

export type OpenSqliteOptions = {
  /** `":memory:"` か file path。DB は repo ごと・device ごとに置く。 */
  readonly location: string;
};

/** `node:sqlite` の `DatabaseSync` を `SqlDriver` として見せる。SQL の意味は解釈しない。 */
export function openNodeSqliteDriver(options: OpenSqliteOptions): SqlDriver {
  const database = new DatabaseSync(options.location);
  return {
    exec(sql: string): void {
      database.exec(sql);
    },
    prepare(sql: string): SqlStatement {
      const statement = database.prepare(sql);
      return {
        run(...params: readonly SqlValue[]): void {
          statement.run(...(params as SqlValue[]));
        },
        all(...params: readonly SqlValue[]) {
          return statement.all(...(params as SqlValue[])) as readonly Record<string, unknown>[];
        },
        get(...params: readonly SqlValue[]) {
          return statement.get(...(params as SqlValue[])) as Record<string, unknown> | undefined;
        },
      };
    },
    close(): void {
      database.close();
    },
  };
}
