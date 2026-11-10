'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { open, repo } = require('./db');
const { createApp } = require('./app');
const { hashPassword } = require('./auth');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PORT = Number(process.env.PORT || 3000);

const store = repo(open(path.join(DATA_DIR, 'tracker.db')));

// First start: create the admin account.
if (store.countUsers() === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (!password || password.length < 8) {
    password = crypto.randomBytes(9).toString('base64url');
    generated = true;
  }
  store.createUser({ username, name: process.env.ADMIN_NAME || 'Administrator', role: 'admin', passwordHash: hashPassword(password) });
  console.log(`Created admin account "${username}".`);
  if (generated) {
    console.log(`  Generated password: ${password}`);
    console.log('  Sign in and change it under Team setup → My account.');
  }
}

const app = createApp(store, {
  secureCookie: process.env.COOKIE_SECURE === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true',
});

const server = app.listen(PORT, () => {
  console.log(`Team A Task Tracker listening on port ${PORT} (data in ${DATA_DIR})`);
});

const shutdown = () => {
  app.closeEvents();
  server.close(() => {
    store.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
