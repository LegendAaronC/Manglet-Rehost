'use strict';

const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const COLLECTIONS = {
  users:    'map',
  clans:    'map',
  sessions: 'map',
  trades:   'list',
  listings: 'list'
};
const KV_KEYS = ['competition', 'reports', 'news', 'globalChat', 'eventItems', 'ipBans', 'meta'];
const ALL_TABLES = [...Object.keys(COLLECTIONS), 'kv'];

function openSQLiteStore(dataDir) {
  const { DatabaseSync } = require('node:sqlite');

  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'manglet.sqlite');
  const sql = new DatabaseSync(dbPath);
  sql.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');

  ALL_TABLES.forEach(t =>
    sql.exec(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
  );

  const stmts = {};
  ALL_TABLES.forEach(t => {
    stmts[t] = {
      all:    sql.prepare(`SELECT id, data FROM ${t} ORDER BY rowid`),
      upsert: sql.prepare(`INSERT INTO ${t} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`),
      remove: sql.prepare(`DELETE FROM ${t} WHERE id = ?`)
    };
  });

  const written = {};
  ALL_TABLES.forEach(t => { written[t] = new Map(); });

  function isEmpty() {
    return ALL_TABLES.every(t => !sql.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get());
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
    ALL_TABLES.forEach(t => {
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

function openPostgresStore(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, max: 5 });

  let ready = false;
  const queue = [];
  let flushing = false;

  async function ensureSchema() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const t of ALL_TABLES) {
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function pgLoad() {
    const data = {};
    const client = await pool.connect();
    let kvRows = [];
    try {
      for (const [t, kind] of Object.entries(COLLECTIONS)) {
        data[t] = kind === 'map' ? {} : [];
        const res = await client.query(`SELECT id, data FROM ${t}`);
        res.rows.forEach(row => {
          const value = JSON.parse(row.data);
          if (kind === 'map') data[t][row.id] = value;
          else data[t].push(value);
        });
      }
      const kvRes = await client.query(`SELECT id, data FROM kv`);
      kvRows = kvRes.rows;
      kvRows.forEach(row => { data[row.id] = JSON.parse(row.data); });
    } finally {
      client.release();
    }

    const collectionEmpty = Object.entries(COLLECTIONS).every(([t, kind]) =>
      kind === 'map' ? Object.keys(data[t]).length === 0 : data[t].length === 0
    );
    if (collectionEmpty && kvRows.length === 0) return null;
    return data;
  }

  async function pgSave(db) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const [t, kind] of Object.entries(COLLECTIONS)) {
        const entries = kind === 'map'
          ? Object.entries(db[t] || {})
          : (db[t] || []).map(item => [String(item.id), item]);

        if (entries.length > 0) {
          for (const [id, value] of entries) {
            await client.query(
              `INSERT INTO ${t} (id, data) VALUES ($1, $2)
               ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
              [id, JSON.stringify(value)]
            );
          }
        }

        const currentIds = entries.map(([id]) => id);
        if (currentIds.length > 0) {
          await client.query(
            `DELETE FROM ${t} WHERE id <> ALL($1::text[])`,
            [currentIds]
          );
        } else {
          await client.query(`DELETE FROM ${t}`);
        }
      }

      for (const k of KV_KEYS) {
        if (db[k] !== undefined) {
          await client.query(
            `INSERT INTO kv (id, data) VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
            [k, JSON.stringify(db[k])]
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    while (queue.length > 0) {
      const last = queue[queue.length - 1];
      queue.length = 0;
      try {
        await pgSave(last.db);
        last.resolve(0);
      } catch (err) {
        last.reject(err);
      }
    }
    flushing = false;
  }

  let cachedData = undefined;

  async function init() {
    await ensureSchema();
    cachedData = await pgLoad();
    ready = true;
    return cachedData;
  }

  function load() {
    if (!ready) throw new Error('store.init() must be awaited before load()');
    return cachedData;
  }

  function save(db) {
    return new Promise((resolve, reject) => {
      queue.push({ db, resolve, reject });
      flushQueue().catch(err => console.error('pg flush error:', err));
    }).catch(err => {
      console.error('pg save error:', err.message);
    });
  }

  function importJsonIfPresent(db, jsonPath) {
    if (!fs.existsSync(jsonPath)) return false;
    save(db);
    fs.renameSync(jsonPath, jsonPath + '.imported');
    return true;
  }

  function backup(destPath) {
    console.warn(`[storage] Postgres backup requested — writing JSON snapshot to ${destPath}.json`);
    const data = cachedData || {};
    fs.writeFileSync(destPath + '.json', JSON.stringify(data, null, 2));
  }

  function close() {
    pool.end().catch(() => {});
  }

  return { path: connectionString, init, load, save, importJsonIfPresent, backup, close };
}

function openStore(dataDir) {
  const pgUrl = process.env.DATABASE_URL;
  if (pgUrl) {
    console.log('using postgres');
    return openPostgresStore(pgUrl);
  }
  console.log('using sqlite');
  return openSQLiteStore(dataDir);
}

module.exports = { openStore };