'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;

// Rate limit: theo IP và toàn hệ thống (chống dò mật khẩu bằng nhiều IP).
const IP_MAX_FAILS = 5;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_LOCK_MS = 15 * 60 * 1000;
const GLOBAL_MAX_FAILS = 30;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_LOCK_MS = 15 * 60 * 1000;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DATA_DIR, 0o700);
}

function writePrivateJson(file, value) {
  ensureDataDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    const [algo, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt' || !saltHex || !hashHex) return resolve(false);
    const expected = Buffer.from(hashHex, 'hex');
    crypto.scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT_PARAMS, (err, actual) => {
      if (err) return resolve(false);
      resolve(crypto.timingSafeEqual(actual, expected));
    });
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqualStrings(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function loadAuthConfig() {
  let raw;
  try {
    raw = fs.readFileSync(AUTH_FILE, 'utf8');
  } catch {
    throw new Error(`Chưa có ${AUTH_FILE}. Chạy "npm run set-password" trước.`);
  }
  const cfg = JSON.parse(raw);
  if (!cfg.username || !cfg.passwordHash) throw new Error(`${AUTH_FILE} thiếu username/passwordHash`);
  return cfg;
}

function saveAuthConfig(username, password) {
  writePrivateJson(AUTH_FILE, { username, passwordHash: hashPassword(password) });
  // Đổi mật khẩu thì đăng xuất mọi phiên cũ.
  writePrivateJson(SESSIONS_FILE, {});
}

class SessionStore {
  constructor() {
    this.sessions = new Map(); // sha256(token) hex -> { expires }
    try {
      const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      for (const [id, s] of Object.entries(saved)) this.sessions.set(id, s);
    } catch {
      // chưa có file thì bắt đầu rỗng
    }
    this.prune();
  }

  persist() {
    writePrivateJson(SESSIONS_FILE, Object.fromEntries(this.sessions));
  }

  prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, s] of this.sessions) {
      if (s.expires <= now) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  create() {
    const token = crypto.randomBytes(32).toString('base64url');
    const id = sha256(token).toString('hex');
    this.sessions.set(id, { expires: Date.now() + SESSION_TTL_MS });
    this.persist();
    return { token, id, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) };
  }

  // Trả về id phiên nếu token hợp lệ, ngược lại null.
  check(token) {
    if (!token) return null;
    const id = sha256(token).toString('hex');
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expires <= Date.now()) {
      this.sessions.delete(id);
      this.persist();
      return null;
    }
    return id;
  }

  valid(id) {
    const s = this.sessions.get(id);
    return Boolean(s && s.expires > Date.now());
  }

  destroy(id) {
    if (this.sessions.delete(id)) this.persist();
  }
}

class LoginLimiter {
  constructor() {
    this.byIp = new Map(); // ip -> { count, first, lockedUntil }
    this.globalFails = [];
    this.globalLockedUntil = 0;
  }

  // Số giây phải chờ nếu đang bị khóa, 0 nếu được thử.
  retryAfter(ip) {
    const now = Date.now();
    const waits = [this.globalLockedUntil - now];
    const entry = this.byIp.get(ip);
    if (entry) waits.push(entry.lockedUntil - now);
    const ms = Math.max(0, ...waits);
    return Math.ceil(ms / 1000);
  }

  fail(ip) {
    const now = Date.now();
    let entry = this.byIp.get(ip);
    if (!entry || now - entry.first > IP_WINDOW_MS) {
      entry = { count: 0, first: now, lockedUntil: 0 };
      this.byIp.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count >= IP_MAX_FAILS) {
      entry.lockedUntil = now + IP_LOCK_MS;
      entry.count = 0;
      entry.first = now;
    }

    this.globalFails = this.globalFails.filter((t) => now - t < GLOBAL_WINDOW_MS);
    this.globalFails.push(now);
    if (this.globalFails.length >= GLOBAL_MAX_FAILS) {
      this.globalLockedUntil = now + GLOBAL_LOCK_MS;
      this.globalFails = [];
    }

    // Dọn bớt IP cũ để Map không phình mãi.
    if (this.byIp.size > 10000) {
      for (const [k, v] of this.byIp) {
        if (now - v.first > IP_WINDOW_MS && v.lockedUntil < now) this.byIp.delete(k);
      }
    }
  }

  success(ip) {
    this.byIp.delete(ip);
  }
}

module.exports = {
  AUTH_FILE,
  loadAuthConfig,
  saveAuthConfig,
  verifyPassword,
  safeEqualStrings,
  SessionStore,
  LoginLimiter,
};
