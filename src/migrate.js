// Applies the SQL files in migrations/ on first use, so a fresh D1 database needs no manual setup.
// Applied files are recorded in hp_migrations; each file runs in one batch (a transaction).
import m0001 from '../migrations/0001_init.sql';
import m0002 from '../migrations/0002_kick.sql';

const MIGRATIONS = [['0001_init', m0001], ['0002_kick', m0002]];

let ready = null;
export function migrate(env) {
  ready ||= run(env).catch(err => { ready = null; throw err; });
  return ready;
}

async function run(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS hp_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)').run();
  const { results } = await env.DB.prepare('SELECT name FROM hp_migrations').all();
  const applied = new Set(results.map(r => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (applied.has(name)) continue;
    const statements = sql.replace(/--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
    await env.DB.batch([
      ...statements.map(s => env.DB.prepare(s)),
      env.DB.prepare('INSERT INTO hp_migrations (name, applied_at) VALUES (?, ?)').bind(name, Date.now()),
    ]);
  }
}
