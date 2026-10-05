// ============================================================
// db/pool.js — PostgreSQL connection pool with in-memory fallback
//
// Uses the `pg` driver when DATABASE_URL is configured.
// When DATABASE_URL is not set (e.g. in development or preview mode),
// a robust in-memory mock store handles users, sessions, and
// password_resets so that signup, login, session persistence,
// and chat work smoothly out of the box without crashing.
// ============================================================
const { Pool } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');
const fs = require('fs');
const path = require('path');

let pool = null;
let configError = null;

function sanitizeDatabaseUrl(raw) {
  if (!raw) return raw;
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function stripSslModeParam(urlStr) {
  const idx = urlStr.indexOf('?');
  if (idx === -1) return urlStr;
  const base = urlStr.slice(0, idx);
  const query = urlStr.slice(idx + 1);
  const kept = query
    .split('&')
    .filter(pair => pair && !/^sslmode=/i.test(pair));
  return kept.length ? `${base}?${kept.join('&')}` : base;
}

const rawDatabaseUrl = process.env.DATABASE_URL;
const cleanedUrl = sanitizeDatabaseUrl(rawDatabaseUrl);
const isPostgresUrl = cleanedUrl && (cleanedUrl.startsWith('postgres://') || cleanedUrl.startsWith('postgresql://'));

if (!isPostgresUrl) {
  console.warn('ℹ️  DATABASE_URL is not a PostgreSQL connection URL. In-memory local data store active for accounts and sessions.');
  pool = null;
} else {
  try {
    parseConnectionString(cleanedUrl);
    const wantsSslDisabled = /sslmode=disable/i.test(cleanedUrl);
    const connectionStringForPg = stripSslModeParam(cleanedUrl);
    pool = new Pool({
      connectionString: connectionStringForPg,
      ssl: wantsSslDisabled ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 3000,
      max: parseInt(process.env.DATABASE_POOL_MAX || '10', 10)
    });

    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL pool error:', err.message);
    });
  } catch (err) {
    configError = err.message;
    console.warn('⚠️  Could not connect to PostgreSQL with DATABASE_URL (' + err.message + '). In-memory store active.');
    pool = null;
  }
}

// ============================================================
// IN-MEMORY / LOCAL JSON BACKED STORE FALLBACK
// ============================================================
const mockDataFile = path.join(__dirname, '..', 'english-passport-auth-data.json');
let mockStore = {
  users: [],
  sessions: [],
  password_resets: [],
  email_verifications: [],
  nextUserId: 1
};

function loadMockStore() {
  try {
    if (fs.existsSync(mockDataFile)) {
      const content = fs.readFileSync(mockDataFile, 'utf8');
      const parsed = JSON.parse(content);
      mockStore = {
        users: Array.isArray(parsed.users) ? parsed.users.map(u => ({ ...u, is_verified: u.is_verified !== undefined ? Boolean(u.is_verified) : true })) : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        password_resets: Array.isArray(parsed.password_resets) ? parsed.password_resets : [],
        email_verifications: Array.isArray(parsed.email_verifications) ? parsed.email_verifications : [],
        nextUserId: parsed.nextUserId || 1
      };
    }
  } catch (e) {
    console.warn('Could not load local auth store:', e.message);
  }
}

let mockSaveScheduled = false;
function saveMockStore(immediate = false) {
  if (immediate) {
    try {
      fs.writeFileSync(mockDataFile, JSON.stringify(mockStore, null, 2), 'utf8');
    } catch (e) {
      console.error('Could not save local auth store:', e.message);
    }
    return;
  }
  if (mockSaveScheduled) return;
  mockSaveScheduled = true;
  setTimeout(() => {
    mockSaveScheduled = false;
    try {
      fs.writeFileSync(mockDataFile, JSON.stringify(mockStore, null, 2), 'utf8');
    } catch (e) {
      console.error('Could not save local auth store:', e.message);
    }
  }, 100);
}

loadMockStore();

function executeMockQuery(text, params = []) {
  const sql = text.trim();
  const lower = sql.toLowerCase();

  // 1) INSERT INTO users (user_code, email, display_name, password_hash, is_verified)
  if (lower.startsWith('insert into users')) {
    const [userCode, email, displayName, passwordHash, isVerified] = params;
    const now = new Date().toISOString();
    const newUser = {
      id: mockStore.nextUserId++,
      user_code: String(userCode),
      email: String(email).toLowerCase(),
      display_name: displayName,
      password_hash: passwordHash,
      is_verified: isVerified !== undefined ? Boolean(isVerified) : false,
      avatar_url: null,
      created_at: now,
      updated_at: now
    };
    mockStore.users.push(newUser);
    saveMockStore();
    return { rows: [newUser] };
  }

  // 1.5) SELECT ... FROM users (all users)
  if (lower.startsWith('select') && lower.includes('from users') && !lower.includes('where')) {
    return { rows: mockStore.users.map(u => ({ ...u })) };
  }

  // 1.6) SELECT ... FROM sessions (all sessions)
  if (lower.startsWith('select') && lower.includes('from sessions') && !lower.includes('where')) {
    return { rows: mockStore.sessions.map(s => ({ ...s })) };
  }

  // 2) SELECT id FROM users WHERE email = $1 / SELECT * FROM users WHERE email = $1
  if (lower.startsWith('select') && lower.includes('from users') && lower.includes('where email = $1')) {
    const email = String(params[0] || '').toLowerCase();
    const match = mockStore.users.find(u => u.email.toLowerCase() === email);
    return { rows: match ? [match] : [] };
  }

  // 3) SELECT id FROM users WHERE user_code = $1 / SELECT display_name FROM users WHERE user_code = $1
  if (lower.startsWith('select') && lower.includes('from users') && lower.includes('where user_code = $1') && !lower.includes('and id !=')) {
    const userCode = String(params[0] || '');
    const match = mockStore.users.find(u => u.user_code === userCode);
    return { rows: match ? [match] : [] };
  }

  // 4) SELECT id FROM users WHERE user_code = $1 AND id != $2
  if (lower.startsWith('select') && lower.includes('from users') && lower.includes('where user_code = $1 and id !=')) {
    const [userCode, excludeId] = params;
    const match = mockStore.users.find(u => u.user_code === String(userCode) && u.id !== excludeId);
    return { rows: match ? [match] : [] };
  }

  // 5) SELECT user_code FROM users WHERE id = $1
  if (lower.startsWith('select') && lower.includes('from users') && lower.includes('where id = $1')) {
    const id = params[0];
    const match = mockStore.users.find(u => u.id === id);
    return { rows: match ? [match] : [] };
  }

  // 6) UPDATE users SET user_code = $1, updated_at = now() WHERE id = $2 RETURNING ...
  if (lower.startsWith('update users') && lower.includes('set user_code = $1')) {
    const [newCode, userId] = params;
    const user = mockStore.users.find(u => u.id === userId);
    if (user) {
      user.user_code = String(newCode);
      user.updated_at = new Date().toISOString();
      saveMockStore();
      return { rows: [user] };
    }
    return { rows: [] };
  }

  // 7) UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2
  if (lower.startsWith('update users') && lower.includes('set password_hash = $1')) {
    const [hash, userId] = params;
    const user = mockStore.users.find(u => u.id === userId);
    if (user) {
      user.password_hash = hash;
      user.updated_at = new Date().toISOString();
      saveMockStore();
      return { rows: [user] };
    }
    return { rows: [] };
  }

  // 8) DELETE FROM users WHERE user_code = $1 / id = $1
  if (lower.startsWith('delete from users')) {
    const target = params[0];
    const idx = mockStore.users.findIndex(u => String(u.user_code) === String(target) || String(u.id) === String(target));
    if (idx !== -1) {
      const deleted = mockStore.users.splice(idx, 1)[0];
      mockStore.sessions = mockStore.sessions.filter(s => s.user_id !== deleted.id);
      mockStore.password_resets = mockStore.password_resets.filter(r => r.user_id !== deleted.id);
      mockStore.email_verifications = mockStore.email_verifications.filter(v => v.user_id !== deleted.id);
      saveMockStore(true);
      return { rows: [{ id: deleted.id, user_code: deleted.user_code, email: deleted.email }] };
    }
    return { rows: [] };
  }

  // 8.5) UPDATE users SET is_verified = true
  if (lower.startsWith('update users') && lower.includes('is_verified = true')) {
    const id = params[0];
    const user = mockStore.users.find(u => String(u.id) === String(id) || String(u.user_code) === String(id));
    if (user) {
      user.is_verified = true;
      user.updated_at = new Date().toISOString();
      saveMockStore();
      return { rows: [user] };
    }
    return { rows: [] };
  }

  // 9) INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address)
  if (lower.startsWith('insert into sessions')) {
    const [userId, tokenHash, expiresAt, userAgent, ipAddress] = params;
    const session = {
      id: 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      user_id: userId,
      token_hash: tokenHash,
      expires_at: new Date(expiresAt).toISOString(),
      user_agent: userAgent || null,
      ip_address: ipAddress || null,
      created_at: new Date().toISOString()
    };
    mockStore.sessions.push(session);
    saveMockStore();
    return { rows: [session] };
  }

  // 10) SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()
  if (lower.includes('from sessions s') && lower.includes('where s.token_hash = $1')) {
    const tokenHash = params[0];
    const now = Date.now();
    const session = mockStore.sessions.find(s => s.token_hash === tokenHash && new Date(s.expires_at).getTime() > now);
    if (session) {
      const user = mockStore.users.find(u => u.id === session.user_id);
      if (user) return { rows: [user] };
    }
    return { rows: [] };
  }

  // 11) DELETE FROM sessions WHERE token_hash = $1
  if (lower.startsWith('delete from sessions where token_hash = $1')) {
    const tokenHash = params[0];
    mockStore.sessions = mockStore.sessions.filter(s => s.token_hash !== tokenHash);
    saveMockStore();
    return { rows: [] };
  }

  // 12) DELETE FROM sessions WHERE user_id = $1
  if (lower.startsWith('delete from sessions where user_id = $1')) {
    const userId = params[0];
    mockStore.sessions = mockStore.sessions.filter(s => s.user_id !== userId);
    saveMockStore();
    return { rows: [] };
  }

  // 13) INSERT INTO password_resets (user_id, token_hash, expires_at, otp_code)
  if (lower.startsWith('insert into password_resets')) {
    const [userId, tokenHash, expiresAt, otpCode] = params;
    const record = {
      id: 'reset_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      user_id: userId,
      token_hash: tokenHash,
      otp_code: otpCode ? String(otpCode).trim() : null,
      expires_at: new Date(expiresAt).toISOString(),
      used_at: null,
      created_at: new Date().toISOString()
    };
    mockStore.password_resets.push(record);
    saveMockStore();
    return { rows: [record] };
  }

  // 14) SELECT * FROM password_resets
  if (lower.includes('from password_resets')) {
    const now = Date.now();
    if (lower.includes('where user_id = $1')) {
      const userId = params[0];
      const match = mockStore.password_resets.slice().reverse().find(r => {
        if (String(r.user_id) !== String(userId)) return false;
        if (r.used_at) return false;
        if (r.expires_at && new Date(r.expires_at).getTime() <= now) return false;
        for (let i = 1; i < params.length; i++) {
          const val = String(params[i] || '').trim();
          if (val && (String(r.otp_code || '').trim() === val || String(r.token_hash || '').trim() === val)) return true;
        }
        return false;
      });
      return { rows: match ? [match] : [] };
    }
    if (lower.includes('where otp_code') || lower.includes('where token_hash')) {
      const match = mockStore.password_resets.slice().reverse().find(r => {
        if (r.used_at) return false;
        if (r.expires_at && new Date(r.expires_at).getTime() <= now) return false;
        for (let i = 0; i < params.length; i++) {
          const val = String(params[i] || '').trim();
          if (val && (String(r.otp_code || '').trim() === val || String(r.token_hash || '').trim() === val)) return true;
        }
        return false;
      });
      return { rows: match ? [match] : [] };
    }
    const matches = mockStore.password_resets.slice().reverse().filter(r => !r.used_at && (!r.expires_at || new Date(r.expires_at).getTime() > now));
    return { rows: matches };
  }

  // 15) UPDATE password_resets SET used_at = now() WHERE id = $1
  if (lower.startsWith('update password_resets') && lower.includes('where id = $1')) {
    const id = params[0];
    const record = mockStore.password_resets.find(r => r.id === id);
    if (record) {
      record.used_at = new Date().toISOString();
      saveMockStore();
      return { rows: [record] };
    }
    return { rows: [] };
  }

  // 16) INSERT INTO email_verifications (user_id, token_hash, expires_at, otp_code)
  if (lower.startsWith('insert into email_verifications')) {
    const [userId, tokenHash, expiresAt, otpCode] = params;
    const record = {
      id: 'verify_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      user_id: userId,
      token_hash: tokenHash,
      otp_code: otpCode ? String(otpCode).trim() : null,
      expires_at: new Date(expiresAt).toISOString(),
      verified_at: null,
      created_at: new Date().toISOString()
    };
    mockStore.email_verifications.push(record);
    saveMockStore();
    return { rows: [record] };
  }

  // 17) SELECT * FROM email_verifications
  if (lower.includes('from email_verifications')) {
    const now = Date.now();
    if (lower.includes('where user_id = $1')) {
      const userId = params[0];
      const match = mockStore.email_verifications.slice().reverse().find(v => {
        if (String(v.user_id) !== String(userId)) return false;
        if (v.verified_at) return false;
        if (v.expires_at && new Date(v.expires_at).getTime() <= now) return false;
        for (let i = 1; i < params.length; i++) {
          const val = String(params[i] || '').trim();
          if (val && (String(v.otp_code || '').trim() === val || String(v.token_hash || '').trim() === val)) return true;
        }
        return false;
      });
      return { rows: match ? [match] : [] };
    }
    if (lower.includes('where token_hash') || lower.includes('where otp_code')) {
      const match = mockStore.email_verifications.slice().reverse().find(v => {
        if (v.verified_at) return false;
        if (v.expires_at && new Date(v.expires_at).getTime() <= now) return false;
        for (let i = 0; i < params.length; i++) {
          const val = String(params[i] || '').trim();
          if (val && (String(v.otp_code || '').trim() === val || String(v.token_hash || '').trim() === val)) return true;
        }
        return false;
      });
      return { rows: match ? [match] : [] };
    }
    const matches = mockStore.email_verifications.slice().reverse().filter(v => !v.verified_at && (!v.expires_at || new Date(v.expires_at).getTime() > now));
    return { rows: matches };
  }

  // 18) UPDATE email_verifications SET verified_at = now() WHERE id = $1
  if (lower.startsWith('update email_verifications') && lower.includes('where id = $1')) {
    const id = params[0];
    const record = mockStore.email_verifications.find(v => v.id === id);
    if (record) {
      record.verified_at = new Date().toISOString();
      saveMockStore();
      return { rows: [record] };
    }
    return { rows: [] };
  }

  // 19) DELETE FROM email_verifications WHERE user_id = $1
  if (lower.startsWith('delete from email_verifications where user_id = $1')) {
    const userId = params[0];
    mockStore.email_verifications = mockStore.email_verifications.filter(v => v.user_id !== userId);
    saveMockStore();
    return { rows: [] };
  }

  // Default fallback for any DDL or other queries
  return { rows: [] };
}

async function query(text, params) {
  if (pool) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      console.warn('⚠️  PostgreSQL unavailable (' + (err.code || err.message) + ') — switching to in-memory store.');
      pool = null;
      return executeMockQuery(text, params);
    }
  }
  return executeMockQuery(text, params);
}

async function runMigrations() {
  if (!pool) {
    console.log('💾 In-memory user database ready (accounts, login, sessions active) ✅');
    return;
  }
  const schemaPath = path.join(__dirname, 'schema.sql');
  let schemaSql;
  try {
    schemaSql = fs.readFileSync(schemaPath, 'utf8');
  } catch (e) {
    console.error('⚠️  Could not read db/schema.sql:', e.message);
    return;
  }
  try {
    await pool.query(schemaSql);
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT false;').catch(() => {});
    await pool.query('ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS otp_code VARCHAR(10);').catch(() => {});
    await pool.query('ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS otp_code VARCHAR(10);').catch(() => {});
    console.log('🗄️  PostgreSQL database schema verified/created ✅');
  } catch (e) {
    console.warn('⚠️  Auto-migration notice (falling back to in-memory store if needed):', e.message);
  }
}

module.exports = { pool: pool || { query, on: () => {} }, query, runMigrations };
