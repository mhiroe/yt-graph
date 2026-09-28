// SQL driver の論理境界。runtime 固有の SQLite binding をこの interface の後ろへ隔離する。
//
// この file と `sql/` 配下は依存ゼロを保つ。実際の binding は `adapters/` に置き、`mod.ts` から
// 公開しない。wishboard の bundler が `mod.ts` を読んでも runtime module を辿らない形を維持する。

/** SQLite が受け取れる値。JSON は呼び出し側で string 化してから渡す。 */
export type SqlValue = string | number | null;

export type SqlRow = Readonly<Record<string, unknown>>;

export interface SqlStatement {
  run(...params: readonly SqlValue[]): void;
  all(...params: readonly SqlValue[]): readonly SqlRow[];
  get(...params: readonly SqlValue[]): SqlRow | undefined;
}

/**
 * driver は SQL の実行だけを担い、workflow の意味を解釈しない。
 * transaction 制御を driver 側の API ではなく `exec("BEGIN")` 系で行うのは、
 * runtime ごとに transaction helper の形が違うため。
 */
export interface SqlDriver {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

/** row から string を取り出す。型が違えば undefined を返し、既定値へ落とさない。 */
export function rowString(row: SqlRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === "string" ? value : undefined;
}

/** row から整数を取り出す。SQLite が bigint を返す runtime も許容する。 */
export function rowInteger(row: SqlRow, column: string): number | undefined {
  const value = row[column];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}
