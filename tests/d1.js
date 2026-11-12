// A D1-shaped wrapper over node:sqlite, so the Worker's real SQL runs on SQLite (the engine D1 uses).
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = path.join(__dirname, '..', 'server', 'migrations');
const migrations = () => fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort().map(file => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS, file), 'utf8') }));

// A fresh in-memory database with every migration applied; or pass your own `db` (already migrated as far as you like).
function d1(db) {
  if (!db) { db = new DatabaseSync(':memory:'); for (const m of migrations()) db.exec(m.sql); }
  const plain = r => (r === undefined ? null : { ...r });
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    first: async () => plain(db.prepare(sql).get(...args)),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...args).map(plain) }),
  });
  return {
    raw: db,
    prepare: sql => stmt(sql),
    batch: async list => { const out = []; db.exec('BEGIN'); try { for (const s of list) out.push(await s.run()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return out; },
  };
}
module.exports = { d1, migrations };
