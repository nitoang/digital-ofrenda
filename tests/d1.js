// A D1-shaped wrapper over node:sqlite, so the Worker's real SQL runs on SQLite (the engine D1 uses).
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function d1() {
  const db = new DatabaseSync(':memory:');
  const dir = path.join(__dirname, '..', 'server', 'migrations');
  for (const f of fs.readdirSync(dir).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
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
module.exports = { d1 };
