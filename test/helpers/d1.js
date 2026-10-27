// A small stand-in for Cloudflare D1, backed by Node's built-in SQLite,
// so Worker tests run real SQL against the real migration.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const clean = (args) => args.map((a) => (a === undefined ? null : a));

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { const s = new Statement(this.db, this.sql); s.args = clean(args); return s; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args), success: true }; }
  async first(col) { const r = this.db.prepare(this.sql).get(...this.args); return r === undefined ? null : col ? r[col] : r; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; }
}

export function createD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../worker/migrations/0001_init.sql', import.meta.url), 'utf8'));
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
