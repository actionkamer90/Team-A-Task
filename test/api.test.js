'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, repo } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');

function setup() {
  const store = repo(open(':memory:'));
  store.createUser({ username: 'admin', name: 'Admin', role: 'admin', passwordHash: hashPassword('admin-pass') });
  store.createUser({ username: 'ena', name: 'Ena', role: 'engineer', passwordHash: hashPassword('ena-pass-1') });
  store.createUser({ username: 'boss', name: 'Boss', role: 'viewer', passwordHash: hashPassword('boss-pass-1') });
  const app = createApp(store);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => { app.closeEvents(); server.close(r); });
  return { store, base, close };
}

function client(base) {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'X-Requested-With': 'tracker', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, json, text };
  };
}

const task = { title: 'RHB Health Check', category: 'Tickets', urgency: 'High', customer: 'RHB', lead: ['Ena'], support: ['Izz'], start: '2026-11-01', target: '2026-11-20' };

test('sign in, roles and task lifecycle', async () => {
  const { base, close } = setup();
  try {
    const anon = client(base);
    assert.equal((await anon('GET', '/api/tasks')).status, 401);
    assert.equal((await anon('POST', '/api/login', { username: 'ena', password: 'wrong' })).status, 401);

    const ena = client(base);
    assert.equal((await ena('POST', '/api/login', { username: 'ENA', password: 'ena-pass-1' })).status, 200);
    const created = await ena('POST', '/api/tasks', task);
    assert.equal(created.status, 201);
    assert.equal(created.json.task.no, 1);
    assert.equal(created.json.task.updatedBy, 'Ena');

    // Validation
    assert.equal((await ena('POST', '/api/tasks', { ...task, target: '2026-11-31' })).status, 400);
    assert.equal((await ena('POST', '/api/tasks', { ...task, lead: [] })).status, 400);
    assert.equal((await ena('POST', '/api/tasks', { ...task, no: 1 })).status, 409);

    // Update with a stale copy is refused
    const t = created.json.task;
    const upd = await ena('PUT', '/api/tasks/1', { ...t, pct: 0.5 });
    assert.equal(upd.status, 200);
    assert.equal((await ena('PUT', '/api/tasks/1', { ...t, pct: 0.7 })).status, 409);

    // Engineers can't delete; viewers can't edit
    assert.equal((await ena('DELETE', '/api/tasks/1')).status, 403);
    const boss = client(base);
    await boss('POST', '/api/login', { username: 'boss', password: 'boss-pass-1' });
    assert.equal((await boss('GET', '/api/tasks')).json.tasks.length, 1);
    assert.equal((await boss('PUT', '/api/tasks/1', { pct: 1 })).status, 403);
    assert.equal((await boss('PUT', '/api/settings', { wOnTime: 1 })).status, 403);

    // History is recorded
    const hist = await boss('GET', '/api/tasks/1/activity');
    assert.deepEqual(hist.json.activity.map((a) => a.action), ['updated', 'created']);
    assert.match(hist.json.activity[0].detail, /percentage 0% → 50%/);

    // Archive finished tasks
    await ena('PUT', '/api/tasks/1', { ...upd.json.task, actual: '2026-11-01' });
    const arch = await ena('POST', '/api/tasks/archive-finished');
    assert.equal(arch.json.archived, 1);

    // CSV export
    const csv = await boss('GET', '/api/export.csv?which=archive');
    assert.equal(csv.status, 200);
    assert.match(csv.text, /RHB Health Check/);
    assert.match(csv.text, /Completed Early/);

    // Admin can delete
    const admin = client(base);
    await admin('POST', '/api/login', { username: 'admin', password: 'admin-pass' });
    assert.equal((await admin('DELETE', '/api/tasks/1')).status, 200);
  } finally {
    await close();
  }
});

test('requests without the app header are refused (CSRF)', async () => {
  const { base, close } = setup();
  try {
    const ena = client(base);
    await ena('POST', '/api/login', { username: 'ena', password: 'ena-pass-1' });
    const r = await ena('POST', '/api/tasks', task, { 'X-Requested-With': 'evil' });
    assert.equal(r.status, 403);
  } finally {
    await close();
  }
});

test('user management keeps at least one admin', async () => {
  const { base, close } = setup();
  try {
    const admin = client(base);
    await admin('POST', '/api/login', { username: 'admin', password: 'admin-pass' });
    const users = (await admin('GET', '/api/users')).json.users;
    const me = users.find((u) => u.username === 'admin');
    assert.equal((await admin('PUT', '/api/users/' + me.id, { role: 'viewer' })).status, 400);

    const add = await admin('POST', '/api/users', { username: 'izz', name: 'Izz', role: 'engineer', password: 'izz-pass-1' });
    assert.equal(add.status, 201);
    assert.equal((await admin('POST', '/api/users', { username: 'izz', name: 'Izz 2', role: 'engineer', password: 'izz-pass-1' })).status, 409);

    // Deactivated users are signed out and can't sign in
    const izz = client(base);
    await izz('POST', '/api/login', { username: 'izz', password: 'izz-pass-1' });
    await admin('PUT', '/api/users/' + add.json.user.id, { active: false });
    assert.equal((await izz('GET', '/api/tasks')).status, 401);
    assert.equal((await izz('POST', '/api/login', { username: 'izz', password: 'izz-pass-1' })).status, 401);
  } finally {
    await close();
  }
});
