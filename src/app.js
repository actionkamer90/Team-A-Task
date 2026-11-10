'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { CATEGORIES, URGENCIES, status, readyToArchive } = require('../public/logic.js');
const auth = require('./auth');

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.status = code;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanDate(v, field) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) {
    throw new HttpError(400, `${field} must be a date like 2026-11-30.`);
  }
  // Reject dates that roll over, such as 2026-11-31.
  const d = new Date(v + 'T00:00:00Z');
  if (d.toISOString().slice(0, 10) !== v) throw new HttpError(400, `${field} ${v} is not a real date.`);
  return v;
}

function cleanPeople(v, field) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 10) throw new HttpError(400, `${field} must be a list of up to 10 names.`);
  const out = [];
  for (const p of v) {
    if (typeof p !== 'string' || !p.trim() || p.length > 60) throw new HttpError(400, `${field} has an invalid name.`);
    if (!out.includes(p.trim())) out.push(p.trim());
  }
  return out;
}

function cleanTask(body, existing) {
  const b = Object.assign({}, existing || {}, body || {});
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title) throw new HttpError(400, 'Give the task a name.');
  if (title.length > 300) throw new HttpError(400, 'Task name is too long (300 characters max).');
  if (!CATEGORIES.includes(b.category)) throw new HttpError(400, 'Category must be one of: ' + CATEGORIES.join(', ') + '.');
  if (!URGENCIES.includes(b.urgency)) throw new HttpError(400, 'Urgency must be one of: ' + URGENCIES.join(', ') + '.');
  const progress = typeof b.progress === 'string' ? b.progress : '';
  if (progress.length > 20000) throw new HttpError(400, 'Progress notes are too long.');
  const pct = Number(b.pct ?? 0);
  if (!Number.isFinite(pct) || pct < 0 || pct > 1) throw new HttpError(400, 'Task percentage must be between 0 and 1.');
  const customer = typeof b.customer === 'string' ? b.customer.trim().slice(0, 120) : '';
  const lead = cleanPeople(b.lead, 'Lead engineer');
  const support = cleanPeople(b.support, 'Support engineer').filter((p) => !lead.includes(p));
  if (!lead.length) throw new HttpError(400, 'Pick a lead engineer.');
  return {
    category: b.category,
    title,
    progress,
    pct,
    urgency: b.urgency,
    customer,
    lead,
    support,
    start: cleanDate(b.start, 'Start date'),
    target: cleanDate(b.target, 'Target date'),
    actual: cleanDate(b.actual, 'Actual date'),
    archived: !!b.archived,
  };
}

function describeChanges(before, after) {
  const labels = {
    title: 'name', category: 'category', urgency: 'urgency', customer: 'customer', pct: 'percentage',
    lead: 'lead', support: 'support', start: 'start date', target: 'target date', actual: 'actual date', progress: 'progress',
  };
  const changed = [];
  for (const [k, label] of Object.entries(labels)) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
      if (k === 'pct') changed.push(`percentage ${Math.round(before.pct * 100)}% → ${Math.round(after.pct * 100)}%`);
      else if (k === 'target' || k === 'actual') changed.push(`${label} ${before[k] || '—'} → ${after[k] || '—'}`);
      else changed.push(label);
    }
  }
  return changed.join(', ');
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

function createApp(store, opts = {}) {
  const app = express();
  const limiter = auth.loginLimiter();
  const secureCookie = !!opts.secureCookie;
  const clients = new Set();

  app.disable('x-powered-by');
  app.set('trust proxy', opts.trustProxy ? 1 : false);
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  // ---- live updates (Server-Sent Events) ----
  const broadcast = (type) => {
    for (const res of clients) res.write(`event: change\ndata: ${JSON.stringify({ type })}\n\n`);
  };

  // ---- auth helpers ----
  const setSessionCookie = (res, token, maxAgeSec) => {
    res.set('Set-Cookie', `${auth.COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureCookie ? '; Secure' : ''}`);
  };

  app.use('/api', (req, res, next) => {
    const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
    if (token) {
      const s = store.getSession(token);
      if (s) {
        const u = store.getUser(s.user_id);
        if (u && u.active) req.user = { id: u.id, username: u.username, name: u.name, role: u.role };
      }
      req.sessionToken = token;
    }
    // CSRF protection: state-changing requests must carry a custom header,
    // which browsers only send cross-site after a CORS preflight we never allow.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'tracker') {
      return next(new HttpError(403, 'Missing request header.'));
    }
    next();
  });

  const need = (role) => (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Sign in to continue.'));
    if (auth.ROLE_RANK[req.user.role] < auth.ROLE_RANK[role]) {
      return next(new HttpError(403, role === 'admin' ? 'Only admins can do this.' : 'Your account is view-only.'));
    }
    next();
  };

  // ---- routes: session ----
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.post('/api/login', (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const key = req.ip + '|' + username.toLowerCase();
    if (limiter.blocked(key)) throw new HttpError(429, 'Too many failed attempts. Wait 15 minutes and try again.');
    const u = username && store.getUserByName(username);
    if (!u || !u.active || !auth.verifyPassword(password, u.password_hash)) {
      limiter.fail(key);
      throw new HttpError(401, 'Username or password is incorrect.');
    }
    limiter.reset(key);
    store.purgeSessions();
    const token = crypto.randomBytes(32).toString('hex');
    store.createSession(token, u.id, Date.now() + auth.SESSION_DAYS * 864e5);
    setSessionCookie(res, token, auth.SESSION_DAYS * 86400);
    res.json({ user: { id: u.id, username: u.username, name: u.name, role: u.role } });
  });

  app.post('/api/logout', (req, res) => {
    if (req.sessionToken) store.deleteSession(req.sessionToken);
    setSessionCookie(res, '', 0);
    res.json({ ok: true });
  });

  app.get('/api/me', need('viewer'), (req, res) => res.json({ user: req.user }));

  app.put('/api/me/password', need('viewer'), (req, res) => {
    const { current, next: pw } = req.body || {};
    const u = store.getUser(req.user.id);
    if (!auth.verifyPassword(String(current || ''), u.password_hash)) throw new HttpError(400, 'Current password is incorrect.');
    if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
    store.updateUser(u.id, { passwordHash: auth.hashPassword(pw) });
    res.json({ ok: true });
  });

  app.get('/api/events', need('viewer'), (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  // ---- routes: tasks ----
  app.get('/api/tasks', need('viewer'), (req, res) => res.json({ tasks: store.listTasks() }));

  app.post('/api/tasks', need('engineer'), (req, res) => {
    const t = cleanTask(req.body);
    let no = req.body?.no != null && req.body.no !== '' ? Number(req.body.no) : store.nextNo();
    if (!Number.isInteger(no) || no < 1) throw new HttpError(400, 'Task number must be a positive whole number.');
    if (store.getTask(no)) throw new HttpError(409, `Task no ${no} is already used. Pick another number.`);
    store.tx(() => {
      store.insertTask({ ...t, no }, req.user.id);
      store.logActivity(no, req.user.id, 'created', '');
    });
    broadcast('tasks');
    res.status(201).json({ task: store.getTask(no) });
  });

  app.get('/api/tasks/:no/activity', need('viewer'), (req, res) => {
    res.json({ activity: store.listActivity(Number(req.params.no)) });
  });

  app.put('/api/tasks/:no', need('engineer'), (req, res) => {
    const no = Number(req.params.no);
    const before = store.getTask(no);
    if (!before) throw new HttpError(404, 'That task no longer exists.');
    if (req.body?.updatedAt && req.body.updatedAt !== before.updatedAt) {
      throw new HttpError(409, `${before.updatedBy || 'Someone'} changed this task while you were editing. Close it and open it again to see their changes.`);
    }
    const t = cleanTask(req.body, before);
    store.tx(() => {
      store.updateTask(no, t, req.user.id);
      let action = 'updated';
      if (t.archived !== before.archived) action = t.archived ? 'archived' : 'restored';
      store.logActivity(no, req.user.id, action, describeChanges(before, t));
    });
    broadcast('tasks');
    res.json({ task: store.getTask(no) });
  });

  app.delete('/api/tasks/:no', need('admin'), (req, res) => {
    const no = Number(req.params.no);
    if (!store.getTask(no)) throw new HttpError(404, 'That task no longer exists.');
    store.tx(() => {
      store.deleteTask(no);
      store.logActivity(no, req.user.id, 'deleted', '');
    });
    broadcast('tasks');
    res.json({ ok: true });
  });

  app.post('/api/tasks/archive-finished', need('engineer'), (req, res) => {
    const s = store.getSettings();
    const list = readyToArchive(store.listTasks(), s.archiveAfterDays);
    store.tx(() => {
      for (const t of list) {
        store.updateTask(t.no, { ...t, archived: true }, req.user.id);
        store.logActivity(t.no, req.user.id, 'archived', '');
      }
    });
    if (list.length) broadcast('tasks');
    res.json({ archived: list.length });
  });

  app.get('/api/export.csv', need('viewer'), (req, res) => {
    const which = req.query.which === 'archive' ? 'archive' : req.query.which === 'all' ? 'all' : 'active';
    const rows = store.listTasks().filter((t) => (which === 'all' ? true : which === 'archive' ? t.archived : !t.archived));
    const head = ['Task No', 'Categories', 'Main Task / Project', 'Task Progress', 'Task Percentage', 'Urgency', 'Customer',
      'Lead Engineer', 'Support Engineer', 'Start Date', 'Target Date', 'Actual Date', 'Status', 'Archived', 'Last Updated', 'Updated By'];
    const lines = [head.map(csvCell).join(',')];
    for (const t of rows) {
      lines.push([t.no, t.category, t.title, t.progress, Math.round(t.pct * 100) + '%', t.urgency, t.customer, t.lead.join(' / '),
        t.support.join(' / '), t.start, t.target, t.actual, status(t), t.archived ? 'Yes' : 'No', t.updatedAt.slice(0, 10), t.updatedBy]
        .map(csvCell).join(','));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="team-a-tasks-${which}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  });

  // ---- routes: settings ----
  app.get('/api/settings', need('viewer'), (req, res) => res.json({ settings: store.getSettings() }));

  app.put('/api/settings', need('admin'), (req, res) => {
    const b = req.body || {};
    const cur = store.getSettings();
    const list = (v, field) => {
      if (v === undefined) return cur[field];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 120)) {
        throw new HttpError(400, `${field} must be a list of names.`);
      }
      return [...new Set(v.map((x) => x.trim()))];
    };
    const num = (v, field, min, max) => {
      if (v === undefined) return cur[field];
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field} must be between ${min} and ${max}.`);
      return n;
    };
    const next = {
      engineers: list(b.engineers, 'engineers'),
      customers: list(b.customers, 'customers'),
      wOnTime: num(b.wOnTime, 'wOnTime', 0, 1),
      wEarly: num(b.wEarly, 'wEarly', 0, 1),
      tExcellent: num(b.tExcellent, 'tExcellent', 0, 1),
      tGood: num(b.tGood, 'tGood', 0, 1),
      tNeeds: num(b.tNeeds, 'tNeeds', 0, 1),
      archiveAfterDays: Math.round(num(b.archiveAfterDays, 'archiveAfterDays', 0, 365)),
    };
    const saved = store.saveSettings(next);
    broadcast('settings');
    res.json({ settings: saved });
  });

  // ---- routes: users (admin) ----
  app.get('/api/users', need('admin'), (req, res) => res.json({ users: store.listUsers() }));

  const cleanRole = (r) => {
    if (!['admin', 'engineer', 'viewer'].includes(r)) throw new HttpError(400, 'Role must be admin, engineer or viewer.');
    return r;
  };

  app.post('/api/users', need('admin'), (req, res) => {
    const { username, name, role, password } = req.body || {};
    const u = String(username || '').trim();
    if (!/^[A-Za-z0-9._-]{2,40}$/.test(u)) throw new HttpError(400, 'Username: 2–40 letters, numbers, dots, dashes or underscores.');
    if (!String(name || '').trim()) throw new HttpError(400, 'Enter the person’s name.');
    if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    if (store.getUserByName(u)) throw new HttpError(409, `The username ${u} is already taken.`);
    const id = store.createUser({ username: u, name: String(name).trim().slice(0, 80), role: cleanRole(role), passwordHash: auth.hashPassword(password) });
    res.status(201).json({ user: store.listUsers().find((x) => x.id === id) });
  });

  app.put('/api/users/:id', need('admin'), (req, res) => {
    const id = Number(req.params.id);
    const target = store.getUser(id);
    if (!target) throw new HttpError(404, 'That user no longer exists.');
    const b = req.body || {};
    const fields = {};
    if (b.name !== undefined) {
      if (!String(b.name).trim()) throw new HttpError(400, 'Name cannot be empty.');
      fields.name = String(b.name).trim().slice(0, 80);
    }
    if (b.role !== undefined) fields.role = cleanRole(b.role);
    if (b.active !== undefined) fields.active = !!b.active;
    if (b.password !== undefined) {
      if (typeof b.password !== 'string' || b.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
      fields.passwordHash = auth.hashPassword(b.password);
    }
    const losesAdmin = target.role === 'admin' && target.active && ((fields.role && fields.role !== 'admin') || fields.active === false);
    if (losesAdmin && store.countActiveAdmins() <= 1) throw new HttpError(400, 'Keep at least one active admin.');
    store.updateUser(id, fields);
    if (fields.active === false || fields.passwordHash || fields.role) store.deleteUserSessions(id);
    res.json({ user: store.listUsers().find((x) => x.id === id) });
  });

  // ---- static front end ----
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '1h' }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const code = err.status || err.statusCode || 500;
    if (code >= 500) console.error(err);
    res.status(code).json({ error: code >= 500 ? 'Something went wrong on the server. Try again.' : err.message });
  });

  app.closeEvents = () => {
    for (const res of clients) res.end();
    clients.clear();
  };

  return app;
}

module.exports = { createApp, cleanTask, HttpError };
