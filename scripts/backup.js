#!/usr/bin/env node
'use strict';
// Write a consistent copy of the database to <DATA_DIR>/backups/tracker-YYYY-MM-DD-HHMM.db
// and keep the newest 30 backups. Safe to run while the server is running.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'tracker.db');
const dir = path.join(dataDir, 'backups');
const keep = Number(process.env.BACKUP_KEEP || 30);

if (!fs.existsSync(dbFile)) {
  console.error(`No database at ${dbFile}.`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const out = path.join(dir, `tracker-${stamp}.db`);
const db = new DatabaseSync(dbFile);
if (fs.existsSync(out)) fs.unlinkSync(out);
db.prepare('VACUUM INTO ?').run(out);
db.close();
console.log(`Backup written: ${out}`);

const old = fs.readdirSync(dir).filter((f) => /^tracker-.*\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) fs.unlinkSync(path.join(dir, f));
if (old.length) console.log(`Removed ${old.length} old backup(s).`);
