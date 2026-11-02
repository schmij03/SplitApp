import { AppError } from './errors.js';

export type Row = Record<string, any>;
type Param = string | number | null | undefined | boolean;

const norm = (p: Param) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p);

/** Dünne Hülle um Cloudflare D1. */
export class Db {
  constructor(public readonly d1: D1Database) {}

  stmt(sql: string, ...params: Param[]): D1PreparedStatement {
    return this.d1.prepare(sql).bind(...params.map(norm));
  }

  async first<T = Row>(sql: string, ...params: Param[]): Promise<T | undefined> {
    return ((await this.stmt(sql, ...params).first<T>()) ?? undefined) as T | undefined;
  }

  async all<T = Row>(sql: string, ...params: Param[]): Promise<T[]> {
    return (await this.stmt(sql, ...params).all<T>()).results;
  }

  async run(sql: string, ...params: Param[]): Promise<D1Result> {
    return this.stmt(sql, ...params).run();
  }

  /** Mehrere Anweisungen atomar (D1 führt einen Batch als Transaktion aus). */
  async batch(stmts: D1PreparedStatement[]): Promise<D1Result[]> {
    return this.d1.batch(stmts);
  }

  /**
   * Fügt einen Datensatz samt abhängigen Zeilen atomar ein. D1 kennt keine interaktiven Transaktionen,
   * daher wird die nächste ID vorab bestimmt; kollidiert sie mit einer parallelen Anfrage, wird es erneut versucht.
   */
  async insertWithId(table: 'groups' | 'expenses', build: (id: number) => D1PreparedStatement[]): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await this.first<{ id: number }>(`SELECT COALESCE(MAX(id), 0) + 1 AS id FROM ${table}`);
      const id = row!.id;
      try {
        await this.batch(build(id));
        return id;
      } catch (err) {
        if (!String(err).includes(`UNIQUE constraint failed: ${table}.id`)) throw err;
      }
    }
    throw new AppError(503, 'Gerade viel los, bitte nochmals versuchen.');
  }
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);
