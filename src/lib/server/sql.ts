// Database drivers behind one small async interface.
//
//   file   — SQLite file via Node's built-in node:sqlite (local PC / plant server; no native modules).
//   remote — Turso / libSQL over HTTPS via @libsql/client/web (Vercel; pure JS, no native modules).
//
// Every query made inside db.transaction(fn) — also from functions called by fn — automatically runs
// on that transaction (AsyncLocalStorage). Code therefore just calls `db.get(...)` etc. everywhere.
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { Client, InStatement, ResultSet, Transaction } from "@libsql/client/web";

export type Row = Record<string, unknown>;
export type Param = string | number | bigint | null | Uint8Array;
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** Statement-level API (the database itself or an open transaction). */
export interface Sql {
  all(sql: string, ...params: Param[]): Promise<Row[]>;
  get(sql: string, ...params: Param[]): Promise<Row | undefined>;
  run(sql: string, ...params: Param[]): Promise<RunResult>;
  /** Several statements separated by ';' — no parameters. */
  exec(sql: string): Promise<void>;
}

export interface Driver extends Sql {
  readonly kind: "file" | "remote";
  /** Human-readable location for logs / health (never contains credentials). */
  readonly label: string;
  /**
   * BEGIN IMMEDIATE … COMMIT (ROLLBACK on error). Nested calls join the outer transaction.
   * foreignKeysOff: file driver only (SQLite cannot change foreign_keys inside a transaction).
   */
  transaction<T>(fn: () => Promise<T>, opts?: { foreignKeysOff?: boolean }): Promise<T>;
  close(): void;
}

const currentTx = new AsyncLocalStorage<Sql>();

/** Promise-chain mutex: one transaction (or statement) at a time on the single file connection. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

// ---------------------------------------------------------------- file (node:sqlite)

export class FileDriver implements Driver {
  readonly kind = "file" as const;
  private readonly lock = new Mutex();
  private readonly direct: Sql;
  private readonly conn: DatabaseSync;
  readonly label: string;

  // (no TypeScript parameter properties: scripts run this file with Node's type stripping)
  constructor(conn: DatabaseSync, label: string) {
    this.conn = conn;
    this.label = label;
    // node:sqlite is synchronous; wrap it so callers see the same API as the remote driver.
    this.direct = {
      all: async (sql, ...p) => conn.prepare(sql).all(...p) as Row[],
      get: async (sql, ...p) => conn.prepare(sql).get(...p) as Row | undefined,
      run: async (sql, ...p) => {
        const r = conn.prepare(sql).run(...p);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
      exec: async (sql) => {
        conn.exec(sql);
      },
    };
  }

  private route<T>(fn: (s: Sql) => Promise<T>): Promise<T> {
    const tx = currentTx.getStore();
    return tx ? fn(tx) : this.lock.run(() => fn(this.direct));
  }
  all(sql: string, ...p: Param[]) {
    return this.route((s) => s.all(sql, ...p));
  }
  get(sql: string, ...p: Param[]) {
    return this.route((s) => s.get(sql, ...p));
  }
  run(sql: string, ...p: Param[]) {
    return this.route((s) => s.run(sql, ...p));
  }
  exec(sql: string) {
    return this.route((s) => s.exec(sql));
  }

  transaction<T>(fn: () => Promise<T>, opts: { foreignKeysOff?: boolean } = {}): Promise<T> {
    if (currentTx.getStore()) return fn();
    return this.lock.run(async () => {
      if (opts.foreignKeysOff) this.conn.exec("PRAGMA foreign_keys = OFF;");
      try {
        this.conn.exec("BEGIN IMMEDIATE");
        try {
          const result = await currentTx.run(this.direct, fn);
          this.conn.exec("COMMIT");
          return result;
        } catch (err) {
          this.conn.exec("ROLLBACK");
          throw err;
        }
      } finally {
        if (opts.foreignKeysOff) this.conn.exec("PRAGMA foreign_keys = ON;");
      }
    });
  }

  close() {
    this.conn.close();
  }
}

// ---------------------------------------------------------------- remote (Turso / libSQL)

function toRows(rs: ResultSet): Row[] {
  return rs.rows.map((r) => {
    const o: Row = {};
    rs.columns.forEach((c, i) => {
      const v = r[i];
      o[c] = typeof v === "bigint" ? Number(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : v;
    });
    return o;
  });
}

function sqlOn(target: { execute(stmt: InStatement): Promise<ResultSet>; executeMultiple(sql: string): Promise<void> }): Sql {
  const stmt = (sql: string, params: Param[]): InStatement => ({ sql, args: params as never });
  return {
    all: async (sql, ...p) => toRows(await target.execute(stmt(sql, p))),
    get: async (sql, ...p) => toRows(await target.execute(stmt(sql, p)))[0],
    run: async (sql, ...p) => {
      const rs = await target.execute(stmt(sql, p));
      return { changes: rs.rowsAffected, lastInsertRowid: Number(rs.lastInsertRowid ?? 0) };
    },
    exec: (sql) => target.executeMultiple(sql),
  };
}

export class RemoteDriver implements Driver {
  readonly kind = "remote" as const;
  private readonly direct: Sql;
  private readonly client: Client;
  readonly label: string;

  constructor(client: Client, label: string) {
    this.client = client;
    this.label = label;
    this.direct = sqlOn(client);
  }

  private s(): Sql {
    return currentTx.getStore() ?? this.direct;
  }
  all(sql: string, ...p: Param[]) {
    return this.s().all(sql, ...p);
  }
  get(sql: string, ...p: Param[]) {
    return this.s().get(sql, ...p);
  }
  run(sql: string, ...p: Param[]) {
    return this.s().run(sql, ...p);
  }
  exec(sql: string) {
    return this.s().exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (currentTx.getStore()) return fn();
    const tx: Transaction = await this.client.transaction("write"); // BEGIN IMMEDIATE on the server
    try {
      const result = await currentTx.run(sqlOn(tx), fn);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    } finally {
      tx.close();
    }
  }

  close() {
    this.client.close();
  }
}
