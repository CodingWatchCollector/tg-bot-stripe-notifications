import { DatabaseSync } from "node:sqlite";
import first from "../../migrations/0001_students_payments.sql?raw";
import second from "../../migrations/0002_drop_payments_livemode.sql?raw";
import third from "../../migrations/0003_balances.sql?raw";

type Value = string | number | bigint | null;
type Row = Record<string, Value>;
type Method = "first" | "all" | "run" | "batch";

const TRANSACTION_SQL = /^\s*(begin|commit|rollback|savepoint)\b/i;
const READS_ROWS = /^\s*(select|with)\b|\breturning\b/i;

const num = (v: Value | undefined): number => (typeof v === "bigint" ? Number(v) : (v as number));
const clean = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]));

export function createD1Fake() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(first);
  db.exec(second);
  db.exec(third);
  let failing: Method | "any" | null = null;
  let beforeBatch: (() => void) | null = null;

  const guard = (method: Method) => {
    if (failing === "any" || failing === method) {
      failing = null;
      throw new Error("d1 fake: injected failure");
    }
  };

  const checkPlaceholders = (sql: string, params: Value[]) => {
    const seen: number[] = [];
    for (const m of sql.matchAll(/\?(\d*)/g)) {
      const n = Number(m[1]);
      if (m[1] === "" || (!seen.includes(n) && n !== seen.length + 1)) {
        throw new Error("d1 fake: placeholders must be ?1..?n in order of first appearance");
      }
      if (!seen.includes(n)) seen.push(n);
    }
    if (seen.length !== params.length) throw new Error(`d1 fake: expected ${seen.length} bound values, got ${params.length}`);
  };

  const exec = (sql: string, params: Value[]) => {
    if (TRANSACTION_SQL.test(sql)) throw new Error("d1 fake: transaction statements are not allowed");
    checkPlaceholders(sql, params);
    const stmt = db.prepare(sql);
    if (READS_ROWS.test(sql)) {
      const results = stmt.all(...params).map(clean);
      return { results, success: true as const, meta: { changes: 0, last_row_id: 0 } };
    }
    const r = stmt.run(...params);
    return { results: [] as Row[], success: true as const, meta: { changes: num(r.changes), last_row_id: num(r.lastInsertRowid) } };
  };

  interface Statement {
    sql: string;
    params: Value[];
    bind(...params: Value[]): Statement;
    first(col?: string): Promise<unknown>;
    all(): Promise<ReturnType<typeof exec>>;
    run(): Promise<ReturnType<typeof exec>>;
  }

  const statement = (sql: string, params: Value[] = []): Statement => ({
    sql,
    params,
    bind: (...p) => statement(sql, p),
    async first(col) {
      guard("first");
      const row = exec(sql, params).results[0];
      if (row === undefined) return null;
      return col === undefined ? row : (row[col] ?? null);
    },
    async all() {
      guard("all");
      return exec(sql, params);
    },
    async run() {
      guard("run");
      return exec(sql, params);
    },
  });

  const fake = {
    prepare: (sql: string) => statement(sql),
    async batch(stmts: Statement[]) {
      const hook = beforeBatch;
      beforeBatch = null;
      hook?.();
      guard("batch");
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => exec(s.sql, s.params));
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    beforeNextBatch(fn: () => void) {
      beforeBatch = fn;
    },
    failNext(method: Method | "any" = "any") {
      failing = method;
    },
    raw: {
      run: (sql: string, ...params: Value[]) => db.prepare(sql).run(...params),
      all: (sql: string, ...params: Value[]) => db.prepare(sql).all(...params).map(clean),
    },
  };
  return Object.assign(fake, { d1: fake as unknown as D1Database });
}

export type D1Fake = ReturnType<typeof createD1Fake>;
