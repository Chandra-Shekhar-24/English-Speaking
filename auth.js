// ============================================================
// auth.js — authentication system
//
// - bcryptjs for password hashing (pure JS, no native compile —
//   deliberately NOT `bcrypt`, which is a native addon and would
//   risk the exact same Render build failure we already hit once
//   with better-sqlite3).
// - Session tokens: a random 32-byte token is given to the client
//   (httpOnly cookie); only its SHA-256 hash is stored server-side,
//   so a database leak alone can't be replayed as a valid session.
// - Password reset: single-use, time-limited tokens. Email delivery
//   is pluggable via RESEND_API_KEY — with no key configured, the
//   reset link is printed to the server console instead, so the
//   whole flow is testable locally without any external service.
// ============================================================
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query } = require('./db/pool');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const BCRYPT_ROUNDS = 12;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidEmail(email) { return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function isValidUserCode(code) { return typeof code === 'string' && /^[0-9]{4}$/.test(code); }
function isValidPassword(pw) { return typeof pw === 'string' && pw.length >= 8; }

// ------------------------------------------------------------
// Simple in-memory rate limiter (per key, e.g. "login:<ip>").
// Good enough for a single server instance. If this app grows to
// multiple instances behind a load balancer, replace with a
// Redis-backed limiter so all instances share the same counters.
// ------------------------------------------------------------
const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || [];
  const recent = bucket.filter(t => now - t < windowMs);
  if (recent.length >= max) return false;
  recent.push(now);
  rateBuckets.set(key, recent);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of rateBuckets) {
    const recent = arr.filter(t => now - t < 15 * 60 * 1000);
    if (recent.length === 0) rateBuckets.delete(key); else rateBuckets.set(key, recent);
  }
}, 5 * 60 * 1000).unref();

function publicUser(row) {
  return {
    id: row.id,
    userCode: row.user_code,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url || null,
    createdAt: row.created_at
  };
}

async function signup({ email, password, displayName, userCode }) {
  if (!isValidEmail(email)) throw httpError(400, 'Enter a valid email address');
  if (!isValidPassword(password)) throw httpError(400, 'Password must be at least 8 characters');
  if (!displayName || !displayName.trim()) throw httpError(400, 'Enter your name');
  if (!isValidUserCode(userCode)) throw httpError(400, 'User ID must be exactly 4 digits');

  const existingEmail = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existingEmail.rows.length) throw httpError(409, 'An account with this email already exists');

  const existingCode = await query('SELECT id FROM users WHERE user_code = $1', [userCode]);
  if (existingCode.rows.length) throw httpError(409, 'That User ID is already taken — pick another');

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = await query(
    `INSERT INTO users (user_code, email, display_name, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_code, email, display_name, avatar_url, created_at`,
    [userCode, email.toLowerCase(), displayName.trim(), passwordHash]
  );
  return publicUser(result.rows[0]);
}

async function login({ email, password }, meta = {}) {
  const result = await query('SELECT * FROM users WHERE email = $1', [(email || '').toLowerCase()]);
  const user = result.rows[0];
  // Same error for "no such user" and "wrong password" — avoids leaking
  // which emails have accounts.
  if (!user) throw httpError(401, 'Invalid email or password');
  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) throw httpError(401, 'Invalid email or password');

  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, hashToken(token), expiresAt, meta.userAgent || null, meta.ip || null]
  );
  return { token, user: publicUser(user) };
}

async function logout(token) {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

async function getUserByToken(token) {
  if (!token) return null;
  const result = await query(
    `SELECT u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  return result.rows[0] ? publicUser(result.rows[0]) : null;
}

async function requestPasswordReset(email) {
  const result = await query('SELECT id, email FROM users WHERE email = $1', [(email || '').toLowerCase()]);
  const user = result.rows[0];
  // Always report success whether or not the account exists — prevents
  // using this endpoint to discover registered emails.
  if (!user) return { sent: true };

  const token = generateToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, hashToken(token), expiresAt]
  );
  await sendPasswordResetEmail(user.email, token);
  return { sent: true };
}

async function resetPassword(token, newPassword) {
  if (!isValidPassword(newPassword)) throw httpError(400, 'Password must be at least 8 characters');
  const result = await query(
    `SELECT * FROM password_resets WHERE token_hash = $1 AND expires_at > now() AND used_at IS NULL`,
    [hashToken(token || '')]
  );
  const record = result.rows[0];
  if (!record) throw httpError(400, 'This reset link is invalid or has expired');

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [passwordHash, record.user_id]);
  await query('UPDATE password_resets SET used_at = now() WHERE id = $1', [record.id]);
  // Reset = "I might have lost control of my account", so sign out
  // every existing session, not just issue a new password.
  await query('DELETE FROM sessions WHERE user_id = $1', [record.user_id]);
}

async function changeUserCode(userId, newCode) {
  if (!isValidUserCode(newCode)) throw httpError(400, 'User ID must be exactly 4 digits');
  const existing = await query('SELECT id FROM users WHERE user_code = $1 AND id != $2', [newCode, userId]);
  if (existing.rows.length) throw httpError(409, 'That User ID is already taken');
  await query('UPDATE users SET user_code = $1, updated_at = now() WHERE id = $2', [newCode, userId]);
  return newCode;
}

// Pluggable email delivery. With RESEND_API_KEY set, sends via Resend's
// HTTP API (no extra dependency needed — plain fetch). Without it,
// prints the reset link to the server console so the flow still works
// end-to-end during local development.
async function sendPasswordResetEmail(email, token) {
  const resetUrl = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password.html?token=${token}`;
  if (!process.env.RESEND_API_KEY) {
    console.log(`\n📧 [DEV MODE — set RESEND_API_KEY to send real emails] Password reset link for ${email}:\n   ${resetUrl}\n`);
    return;
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'no-reply@example.com',
        to: email,
        subject: 'Reset your password',
        html: `<p>We received a request to reset your password.</p><p><a href="${resetUrl}">Click here to reset it</a> (expires in 1 hour). If you didn't request this, you can ignore this email.</p>`
      })
    });
    if (!response.ok) { console.error('Resend email failed:', response.status, await response.text()); }
  } catch (e) { console.error('Email send error:', e.message); }
}

module.exports = {
  signup, login, logout, getUserByToken,
  requestPasswordReset, resetPassword, changeUserCode,
  rateLimit, httpError
};
