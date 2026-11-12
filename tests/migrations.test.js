// Migration tests. A real deployment is upgraded one migration at a time with people's data already in place, so
// these apply 0001..0012 in steps, put rows in as each table appears, and check that nothing is lost or reshaped.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { d1, migrations } = require('./d1');

const all = migrations();
const upTo = (db, n) => { for (const m of all.slice(0, n)) db.exec(m.sql); return db; };
const open = () => { const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON'); return db; };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rows = (db, sql, ...a) => db.prepare(sql).all(...a).map(r => ({ ...r }));
const row = (db, sql, ...a) => { const r = db.prepare(sql).get(...a); return r && { ...r }; };

// The shape of a database that ignores how it got there: tables with their columns, and indexes with theirs.
function shape(db) {
  const out = {};
  for (const { name } of rows(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    out[name] = {
      columns: rows(db, `PRAGMA table_info(${name})`).map(c => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
      indexes: rows(db, `PRAGMA index_list(${name})`).map(i => [i.name, i.unique, i.partial,
        rows(db, `PRAGMA index_info(${i.name})`).map(c => c.name).join()]).sort(),
      foreignKeys: rows(db, `PRAGMA foreign_key_list(${name})`).map(f => [f.from, f.table, f.to, f.on_delete]).sort(),
    };
  }
  return out;
}

// Rows for the tables each migration introduces. They go in straight after that migration, so every later
// migration has to carry them through.
const T = 1_700_000_000_000;
const TOKEN = 'a'.repeat(43); // a session cookie value, as the Worker issues them
const seed = {
  1: db => {
    db.prepare('INSERT INTO users (id, email, plan, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run('u1', 'ana@example.com', 'platinum', T, T + 5);
    db.prepare('INSERT INTO users (id, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run('u2', 'beto@example.com', T, T);
    db.prepare('INSERT INTO login_challenges (challenge_id, link_hash, code_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run('c1', sha('l'), sha('c'), 'ana@example.com', T, T + 900_000);
    db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha(TOKEN), 'u1', T, T, T + 9e9);
    db.prepare('INSERT INTO altars (id, state, created_at, updated_at) VALUES (?, ?, ?, ?)').run('altar-one', '{"format":"digital-ofrenda","kind":"person","tiers":3,"name":"Abuela","dates":"","items":[]}', T, T + 1);
    db.prepare('INSERT INTO altars (id, state, created_at, updated_at) VALUES (?, NULL, ?, ?)').run('altar-two', T, T);
    db.prepare("INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES ('altar-one', 'u1', 'owner', ?)").run(T);
    db.prepare("INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES ('altar-one', 'u2', 'keeper', ?)").run(T);
    db.prepare("INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES ('altar-two', 'u2', 'owner', ?)").run(T);
    db.prepare("INSERT INTO features (altar_id, name, granted_at) VALUES ('altar-one', 'sevenTiers', ?)").run(T);
    db.prepare("INSERT INTO invites (id, token_hash, altar_id, email, invited_by, created_at, expires_at) VALUES ('i1', ?, 'altar-one', 'new@example.com', 'u1', ?, ?)").run(sha('inv'), T, T + 1e9);
    db.prepare("INSERT INTO successors (altar_id, email, token_hash, designated_by, designated_at, accepted_user_id, accepted_at) VALUES ('altar-one', 'beto@example.com', ?, 'u1', ?, 'u2', ?)").run(sha('succ'), T, T + 2);
    db.prepare("INSERT INTO claims (altar_id, requested_by, requested_at, executes_at) VALUES ('altar-one', 'u2', ?, ?)").run(T, T + 2e9);
  },
  2: db => {
    db.prepare("INSERT INTO email_changes (user_id, new_email, code_hash, created_at, expires_at, window_start) VALUES ('u2', 'b2@example.com', ?, ?, ?, ?)").run(sha('x'), T, T + 9e5, T);
    db.prepare("INSERT INTO purchases (payment_intent, feature, reference, paid_at) VALUES ('pi_1', 'sevenTiers', 'altar-one', ?)").run(T);
    db.prepare("INSERT INTO purchases (payment_intent, feature, reference, paid_at, refunded_at) VALUES ('pi_2', 'platinum', 'u1', ?, ?)").run(T, T + 9);
  },
  3: db => db.prepare("INSERT INTO altar_slugs (slug, altar_id, created_at) VALUES ('abuela-rosa', 'altar-one', ?)").run(T),
  4: db => db.prepare("INSERT INTO view_shares (id, altar_id, shared_by, email_hash, created_at) VALUES ('s1', 'altar-one', 'u1', ?, ?)").run(sha('friend@example.com'), T),
  7: db => {
    db.prepare("INSERT INTO handovers (altar_id, to_email, from_user_id, created_at, expires_at) VALUES ('altar-two', 'later@example.com', 'u2', ?, ?)").run(T, T + 7e9);
    db.prepare("INSERT INTO handover_log (id, user_id, at) VALUES ('h1', 'u2', ?)").run(T);
  },
  8: db => db.prepare("INSERT INTO altar_visits (altar_id, user_id, days, last_day) VALUES ('altar-one', 'u2', 4, 19675)").run(),
  10: db => db.prepare("INSERT INTO mail_suppressions (email_hash, reason, created_at) VALUES (?, 'bounce', ?)").run(sha('gone@example.com'), T),
  13: db => db.prepare("UPDATE purchases SET user_id = 'u1', amount = 900, currency = 'usd' WHERE payment_intent = 'pi_1'").run(),
  11: db => {
    db.prepare("INSERT INTO job_runs (name, started_at, ok_at) VALUES ('daily', ?, ?)").run(T, T + 3);
    db.prepare("INSERT INTO alerts (kind, last_sent_at, suppressed) VALUES ('server_error', ?, 2)").run(T);
  },
};

// A database upgraded one migration at a time, with rows going in on the way.
function stepwise() {
  const db = open();
  all.forEach((m, i) => { db.exec(m.sql); seed[i + 1]?.(db); });
  return db;
}

test('migrations: the files are numbered 0001, 0002, ... with no gap, repeat or stray file', () => {
  assert.ok(all.length >= 12);
  all.forEach((m, i) => assert.match(m.file, new RegExp(`^${String(i + 1).padStart(4, '0')}_[a-z_]+\\.sql$`), m.file));
});

test('migrations: upgrading one step at a time ends with exactly the schema of a fresh install', () => {
  const upgraded = stepwise();
  const fresh = upTo(open(), all.length);
  assert.deepEqual(shape(upgraded), shape(fresh));
  assert.deepEqual(rows(upgraded, 'PRAGMA foreign_key_check'), [], 'no row points at something missing');
  assert.equal(row(upgraded, 'PRAGMA integrity_check').integrity_check, 'ok');
});

test('migrations: a database already holding data keeps every row of every table through all later steps', () => {
  const db = stepwise();
  assert.deepEqual(rows(db, 'SELECT id, email, plan, created_at, last_seen_at FROM users ORDER BY id'), [
    { id: 'u1', email: 'ana@example.com', plan: 'platinum', created_at: T, last_seen_at: T + 5 },
    { id: 'u2', email: 'beto@example.com', plan: null, created_at: T, last_seen_at: T }]);
  assert.equal(row(db, 'SELECT state FROM altars WHERE id = ?', 'altar-one').state.includes('Abuela'), true);
  assert.equal(row(db, 'SELECT state FROM altars WHERE id = ?', 'altar-two').state, null);
  assert.equal(row(db, 'SELECT user_id FROM sessions WHERE id_hash = ?', sha(TOKEN)).user_id, 'u1');
  assert.deepEqual(rows(db, 'SELECT altar_id, user_id, role FROM altar_members ORDER BY altar_id, user_id'), [
    { altar_id: 'altar-one', user_id: 'u1', role: 'owner' }, { altar_id: 'altar-one', user_id: 'u2', role: 'keeper' }, { altar_id: 'altar-two', user_id: 'u2', role: 'owner' }]);
  assert.equal(row(db, "SELECT name FROM features WHERE altar_id = 'altar-one'").name, 'sevenTiers');
  assert.equal(row(db, "SELECT email FROM invites WHERE id = 'i1'").email, 'new@example.com');
  assert.deepEqual(rows(db, 'SELECT payment_intent, refunded_at FROM purchases ORDER BY payment_intent'), [
    { payment_intent: 'pi_1', refunded_at: null }, { payment_intent: 'pi_2', refunded_at: T + 9 }]);
  assert.equal(row(db, "SELECT altar_id FROM altar_slugs WHERE slug = 'abuela-rosa'").altar_id, 'altar-one');
  assert.equal(row(db, "SELECT email_hash FROM view_shares WHERE id = 's1'").email_hash, sha('friend@example.com'));
  assert.equal(row(db, "SELECT days FROM altar_visits WHERE altar_id = 'altar-one'").days, 4);
  assert.equal(row(db, 'SELECT reason FROM mail_suppressions').reason, 'bounce');
  assert.equal(row(db, "SELECT suppressed FROM alerts WHERE kind = 'server_error'").suppressed, 2);
  assert.equal(row(db, "SELECT ok_at FROM job_runs WHERE name = 'daily'").ok_at, T + 3);
});

test('migrations: columns added later give old rows the value the Worker assumes', () => {
  const db = stepwise();
  assert.equal(row(db, "SELECT via_successor v FROM altar_members WHERE user_id = 'u1'").v, 0, '0005: nobody was a successor-made keeper');
  assert.deepEqual(row(db, "SELECT inactive_ms, auto_transfer FROM successors WHERE altar_id = 'altar-one'"), { inactive_ms: 365 * 86_400_000, auto_transfer: 1 }, '0009: a year, automatic, as before');
  assert.deepEqual(row(db, "SELECT auto, reminders_sent FROM claims WHERE altar_id = 'altar-one'"), { auto: 0, reminders_sent: 0 }, '0009: a request made by hand, no reminders yet');
  assert.equal(row(db, "SELECT reminders_sent n FROM handovers WHERE altar_id = 'altar-two'").n, 0);
  assert.deepEqual(row(db, "SELECT user_id, amount, currency, amount_refunded, dispute_status, disputed_at FROM purchases WHERE payment_intent = 'pi_2'"),
    { user_id: null, amount: null, currency: null, amount_refunded: 0, dispute_status: null, disputed_at: null }, '0013: old payments have no buyer or amount, and nothing refunded or disputed');
  assert.equal(row(db, "SELECT visibility v FROM altars WHERE id = 'altar-one'").v, 'link', '0012: every existing ofrenda stays reachable by its link');
  assert.equal(row(db, "SELECT visibility v FROM altars WHERE id = 'altar-two'").v, 'link');
});

test('migrations: 0006 lifts the one-owner rule without disturbing the rows, and the other constraints still hold', () => {
  const before = upTo(open(), 5);
  seed[1](before);
  assert.throws(() => before.prepare("INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES ('altar-one', 'u2', 'owner', 1)").run(), /UNIQUE|constraint/i, 'before: a second owner is refused');
  // (u2 is already a keeper of altar-one, so use a third user to isolate the owner rule)
  before.prepare("INSERT INTO users (id, email, created_at, last_seen_at) VALUES ('u3', 'c@example.com', 1, 1)").run();
  assert.throws(() => before.prepare("INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES ('altar-one', 'u3', 'owner', 1)").run(), /UNIQUE|constraint/i);
  before.exec(all[5].sql);
  before.prepare("INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES ('altar-one', 'u3', 'owner', 1)").run();
  assert.equal(row(before, "SELECT COUNT(*) n FROM altar_members WHERE altar_id = 'altar-one' AND role = 'owner'").n, 2, 'after: two owners');
  assert.throws(() => before.prepare("INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES ('altar-one', 'u3', 'keeper', 1)").run(), /UNIQUE|constraint/i, 'the same person still cannot be a member twice');
  assert.throws(() => before.prepare("INSERT INTO altar_members (altar_id, user_id, role, added_at) VALUES ('altar-one', 'u3', 'admin', 1)").run(), /CHECK|constraint/i);
});

test('migrations: 0012 keeps accepting only the two visibilities', () => {
  const db = stepwise();
  db.prepare("UPDATE altars SET visibility = 'private' WHERE id = 'altar-one'").run();
  assert.throws(() => db.prepare("UPDATE altars SET visibility = 'public' WHERE id = 'altar-one'").run(), /CHECK|constraint/i);
  assert.equal(row(db, "SELECT visibility v FROM altars WHERE id = 'altar-one'").v, 'private');
});

test('migrations: deleting a user or an ofrenda after the upgrade still cascades through every later table', () => {
  const db = stepwise();
  db.prepare("DELETE FROM altars WHERE id = 'altar-one'").run();
  for (const t of ['altar_members', 'features', 'invites', 'successors', 'claims', 'altar_slugs', 'view_shares', 'altar_visits']) {
    assert.equal(row(db, `SELECT COUNT(*) n FROM ${t} WHERE altar_id = 'altar-one'`).n, 0, t);
  }
  db.prepare("DELETE FROM users WHERE id = 'u1'").run();
  assert.deepEqual(row(db, "SELECT user_id, amount FROM purchases WHERE payment_intent = 'pi_1'"), { user_id: null, amount: 900 }, '0013: leaving cuts the link to the buyer and keeps the sale');
  db.prepare("DELETE FROM users WHERE id = 'u2'").run();
  for (const t of ['sessions', 'email_changes', 'handovers', 'handover_log']) {
    assert.equal(row(db, `SELECT COUNT(*) n FROM ${t} WHERE ${t === 'handovers' ? 'from_user_id' : 'user_id'} = 'u2'`).n, 0, t);
  }
  assert.equal(row(db, "SELECT COUNT(*) n FROM purchases").n, 2, 'payment records are not tied to a person');
  assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
});

test('migrations: the Worker runs correctly on a database that was upgraded with data in it', async () => {
  const { createHandler } = await import('../server/worker.mjs');
  const db = stepwise();
  const sent = [];
  const handler = createHandler({ now: () => T + 60_000, mailer: { send: async m => void sent.push(m) }, defer: () => {} });
  const env = { DB: d1(db), APP_URL: 'https://ofrenda.test', TURNSTILE_DISABLED: '1' };
  const call = (method, path, body) => handler(new Request('https://api.test' + path, {
    method, headers: { origin: 'https://ofrenda.test', cookie: `__Host-session=${TOKEN}` }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  const me = await call('GET', '/me');
  assert.equal(me.status, 200, 'a session made before the upgrade still works');
  assert.equal((await me.json()).user.plan, 'platinum');
  const got = await call('GET', '/ofrendas/altar-one');
  assert.equal(got.status, 200);
  assert.equal((await got.json()).name, 'Abuela');
  const saved = await call('PUT', '/ofrendas/altar-one', { format: 'digital-ofrenda', kind: 'person', tiers: 7, name: 'Abuela Rosa', items: [] });
  assert.equal(saved.status, 200, 'the old ofrenda can be edited, and its old sevenTiers upgrade is honoured');
  assert.equal((await call('PUT', '/ofrendas/altar-one/visibility', { visibility: 'private' })).status, 200);
  assert.equal((await (await call('POST', '/ofrendas')).json()).id.length, 12, 'new ofrendas can be made beside the old ones');
});
