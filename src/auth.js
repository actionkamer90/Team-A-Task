'use strict';
const crypto = require('node:crypto');

const SESSION_DAYS = 14;
const COOKIE = 'tt_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Simple in-memory limiter for login attempts: 10 failures per 15 minutes per IP + username.
function loginLimiter() {
  const hits = new Map();
  const WINDOW = 15 * 60 * 1000;
  const MAX = 10;
  return {
    blocked(key) {
      const h = hits.get(key);
      if (!h) return false;
      if (Date.now() - h.first > WINDOW) {
        hits.delete(key);
        return false;
      }
      return h.count >= MAX;
    },
    fail(key) {
      const h = hits.get(key);
      if (!h || Date.now() - h.first > WINDOW) hits.set(key, { first: Date.now(), count: 1 });
      else h.count++;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

const ROLE_RANK = { viewer: 1, engineer: 2, admin: 3 };

module.exports = { SESSION_DAYS, COOKIE, ROLE_RANK, hashPassword, verifyPassword, parseCookies, loginLimiter };
