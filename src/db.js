'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_SETTINGS } = require('../public/logic.js');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','engineer','viewer')),
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  no          INTEGER NOT NULL UNIQUE,
  category    TEXT NOT NULL,
  title       TEXT NOT NULL,
  progress    TEXT NOT NULL DEFAULT '',
  pct         REAL NOT NULL DEFAULT 0,
  urgency     TEXT NOT NULL,
  customer    TEXT NOT NULL DEFAULT '',
  lead        TEXT NOT NULL DEFAULT '[]',
  support     TEXT NOT NULL DEFAULT '[]',
  start_date  TEXT,
  target_date TEXT,
  actual_date TEXT,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  task_no  INTEGER NOT NULL,
  user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at       TEXT NOT NULL,
  action   TEXT NOT NULL,
  detail   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS activity_task ON activity(task_no, at);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

function rowToTask(r, names) {
  return {
    id: r.id,
    no: r.no,
    category: r.category,
    title: r.title,
    progress: r.progress,
    pct: r.pct,
    urgency: r.urgency,
    customer: r.customer,
    lead: JSON.parse(r.lead),
    support: JSON.parse(r.support),
    start: r.start_date,
    target: r.target_date,
    actual: r.actual_date,
    archived: !!r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by != null && names ? names.get(r.updated_by) || null : null,
  };
}

function repo(db) {
  const now = () => new Date().toISOString();
  const userNames = () => new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  return {
    db,
    tx,

    // ---- settings ----
    getSettings() {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'config'").get();
      return Object.assign({}, DEFAULT_SETTINGS, row ? JSON.parse(row.value) : {});
    },
    saveSettings(s) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify(s));
      return this.getSettings();
    },

    // ---- users ----
    countUsers: () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    listUsers: () => db.prepare('SELECT id, username, name, role, active, created_at AS createdAt FROM users ORDER BY name').all()
      .map((u) => ({ ...u, active: !!u.active })),
    getUser: (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
    getUserByName: (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(username),
    createUser({ username, name, role, passwordHash }) {
      const r = db.prepare('INSERT INTO users (username, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(username, name, role, passwordHash, now());
      return Number(r.lastInsertRowid);
    },
    updateUser(id, fields) {
      const map = { name: 'name', role: 'role', active: 'active', passwordHash: 'password_hash' };
      const sets = [];
      const vals = [];
      for (const [k, col] of Object.entries(map)) {
        if (fields[k] !== undefined) {
          sets.push(col + ' = ?');
          vals.push(k === 'active' ? (fields[k] ? 1 : 0) : fields[k]);
        }
      }
      if (sets.length) db.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals, id);
    },
    deleteUser: (id) => db.prepare('DELETE FROM users WHERE id = ?').run(id),
    countActiveAdmins: () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n,

    // ---- sessions ----
    createSession: (token, userId, expiresAt) =>
      db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt),
    getSession: (token) => db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?').get(token, Date.now()),
    deleteSession: (token) => db.prepare('DELETE FROM sessions WHERE token = ?').run(token),
    deleteUserSessions: (userId) => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId),
    purgeSessions: () => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()),

    // ---- tasks ----
    listTasks() {
      const names = userNames();
      return db.prepare('SELECT * FROM tasks ORDER BY no').all().map((r) => rowToTask(r, names));
    },
    getTask(no) {
      const r = db.prepare('SELECT * FROM tasks WHERE no = ?').get(no);
      return r ? rowToTask(r, userNames()) : null;
    },
    nextNo: () => db.prepare('SELECT COALESCE(MAX(no), 0) + 1 AS n FROM tasks').get().n,
    insertTask(t, userId) {
      const ts = t.createdAt || now();
      db.prepare(`INSERT INTO tasks (no, category, title, progress, pct, urgency, customer, lead, support,
          start_date, target_date, actual_date, archived, created_at, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(t.no, t.category, t.title, t.progress, t.pct, t.urgency, t.customer, JSON.stringify(t.lead),
          JSON.stringify(t.support), t.start, t.target, t.actual, t.archived ? 1 : 0, ts, t.updatedAt || ts, userId ?? null);
    },
    updateTask(no, t, userId) {
      db.prepare(`UPDATE tasks SET category = ?, title = ?, progress = ?, pct = ?, urgency = ?, customer = ?, lead = ?,
          support = ?, start_date = ?, target_date = ?, actual_date = ?, archived = ?, updated_at = ?, updated_by = ?
          WHERE no = ?`)
        .run(t.category, t.title, t.progress, t.pct, t.urgency, t.customer, JSON.stringify(t.lead), JSON.stringify(t.support),
          t.start, t.target, t.actual, t.archived ? 1 : 0, now(), userId ?? null, no);
    },
    deleteTask: (no) => db.prepare('DELETE FROM tasks WHERE no = ?').run(no),
    deleteAllTasks: () => { db.exec('DELETE FROM tasks; DELETE FROM activity;'); },

    // ---- activity log ----
    logActivity: (taskNo, userId, action, detail) =>
      db.prepare('INSERT INTO activity (task_no, user_id, at, action, detail) VALUES (?, ?, ?, ?, ?)')
        .run(taskNo, userId ?? null, now(), action, detail || ''),
    listActivity(taskNo) {
      const names = userNames();
      return db.prepare('SELECT * FROM activity WHERE task_no = ? ORDER BY at DESC, id DESC LIMIT 100').all(taskNo)
        .map((a) => ({ at: a.at, action: a.action, detail: a.detail, by: a.user_id != null ? names.get(a.user_id) || null : null }));
    },
  };
}

module.exports = { open, repo };
