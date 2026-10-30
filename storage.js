const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const COLLECTIONS = {
  users: 'map',
  clans: 'map',
  sessions: 'map',
  trades: 'list',
  listings: 'list'
};
const KV_KEYS = ['competition', 'reports', 'news', 'globalChat', 'eventItems', 'ipBans', 'meta'];

function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'manglet.sqlite');
  const sql = new DatabaseSync(dbPath);
  sql.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');

  const tables = [...Object.keys(COLLECTIONS), 'kv'];
  tables.forEach(t => sql.exec(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`));

  const stmts = {};
  tables.forEach(t => {
    stmts[t] = {
      all: sql.prepare(`SELECT id, data FROM ${t} ORDER BY rowid`),
      upsert: sql.prepare(`INSERT INTO ${t} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`),
      remove: sql.prepare(`DELETE FROM ${t} WHERE id = ?`)
    };
  });

  const written = {};
  tables.forEach(t => { written[t] = new Map(); });

  function isEmpty() {
    return tables.every(t => !sql.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get());
  }

  function load() {
    if (isEmpty()) return null;
    const data = {};
    Object.entries(COLLECTIONS).forEach(([t, kind]) => {
      data[t] = kind === 'map' ? {} : [];
      stmts[t].all.all().forEach(row => {
        const value = JSON.parse(row.data);
        if (kind === 'map') data[t][row.id] = value;
        else data[t].push(value);
        written[t].set(row.id, row.data);
      });
    });
    stmts.kv.all.all().forEach(row => {
      data[row.id] = JSON.parse(row.data);
      written.kv.set(row.id, row.data);
    });
    return data;
  }

  function snapshot(db) {
    const rows = {};
    Object.entries(COLLECTIONS).forEach(([t, kind]) => {
      rows[t] = new Map();
      const entries = kind === 'map'
        ? Object.entries(db[t] || {})
        : (db[t] || []).map(item => [String(item.id), item]);
      entries.forEach(([id, value]) => rows[t].set(id, JSON.stringify(value)));
    });
    rows.kv = new Map();
    KV_KEYS.forEach(k => { if (db[k] !== undefined) rows.kv.set(k, JSON.stringify(db[k])); });
    return rows;
  }

  function save(db) {
    const rows = snapshot(db);
    const changes = [];
    tables.forEach(t => {
      rows[t].forEach((json, id) => { if (written[t].get(id) !== json) changes.push([t, id, json]); });
      written[t].forEach((_, id) => { if (!rows[t].has(id)) changes.push([t, id, null]); });
    });
    if (changes.length === 0) return 0;

    sql.exec('BEGIN IMMEDIATE');
    try {
      changes.forEach(([t, id, json]) => {
        if (json === null) stmts[t].remove.run(id);
        else stmts[t].upsert.run(id, json);
      });
      sql.exec('COMMIT');
    } catch (err) {
      sql.exec('ROLLBACK');
      throw err;
    }
    changes.forEach(([t, id, json]) => {
      if (json === null) written[t].delete(id);
      else written[t].set(id, json);
    });
    return changes.length;
  }

  function importJsonIfPresent(db, jsonPath) {
    if (!fs.existsSync(jsonPath)) return false;
    save(db);
    fs.renameSync(jsonPath, jsonPath + '.imported');
    return true;
  }

  function backup(destPath) {
    sql.prepare('VACUUM INTO ?').run(destPath);
  }

  function close() {
    sql.close();
  }

  return { path: dbPath, load, save, importJsonIfPresent, backup, close };
}

module.exports = { openStore };