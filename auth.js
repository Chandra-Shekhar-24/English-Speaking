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
const sheets = require('./sheets');
const mailer = require('./mailer');
const activity = require('./activity');

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
    isVerified: row.is_verified !== undefined ? Boolean(row.is_verified) : true,
    avatarUrl: row.avatar_url || null,
    createdAt: row.created_at
  };
}

async function generateUniqueUserCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const code = String(crypto.randomInt(1000, 10000));
    const existing = await query('SELECT id FROM users WHERE user_code = $1', [code]);
    if (!existing.rows || !existing.rows.length) {
      return code;
    }
  }
  const allCodes = await query('SELECT user_code FROM users');
  const used = new Set((allCodes.rows || []).map(r => String(r.user_code)));
  for (let i = 1000; i <= 9999; i++) {
    const c = String(i);
    if (!used.has(c)) return c;
  }
  throw httpError(500, 'User ID pool exhausted');
}

async function signup({ email, password, displayName }, appUrl) {
  if (!isValidEmail(email)) throw httpError(400, 'Enter a valid email address');
  if (!isValidPassword(password)) throw httpError(400, 'Password must be at least 8 characters');
  if (!displayName || !displayName.trim()) throw httpError(400, 'Enter your name');

  const existingEmail = await query('SELECT id, user_code, is_verified, display_name FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existingEmail.rows && existingEmail.rows.length) {
    const existing = existingEmail.rows[0];
    if (existing.is_verified) {
      throw httpError(409, 'An account with this email already exists. Please sign in or reset your password.');
    }
    // Existing unverified account: regenerate verification link and send
    const verifyToken = generateToken();
    const verifyOtp = String(crypto.randomInt(100000, 1000000));
    const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await query('DELETE FROM email_verifications WHERE user_id = $1', [existing.id]).catch(() => {});
    await query('INSERT INTO email_verifications (user_id, token_hash, expires_at, otp_code) VALUES ($1, $2, $3, $4)', [existing.id, hashToken(verifyToken), verifyExpiresAt, verifyOtp]);
    const emailRes = await mailer.sendVerificationEmail({
      user: { id: existing.id, email: email.toLowerCase(), userCode: existing.user_code, displayName: existing.display_name },
      token: verifyToken,
      otp: verifyOtp,
      appUrl
    });
    return {
      user: publicUser(existing),
      needsVerification: true,
      userCode: existing.user_code,
      email: email.toLowerCase(),
      otp: verifyOtp,
      delivered: Boolean(emailRes && emailRes.delivered),
      sandboxRestricted: Boolean(emailRes && emailRes.sandboxRestricted),
      verifyUrl: (emailRes && emailRes.verifyUrl) || null,
      message: `Verification code sent to ${email}. Please enter the 6-digit OTP code to activate your account.`
    };
  }

  // Automatically generate unique persistent 4-digit User ID
  const userCode = await generateUniqueUserCode();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const result = await query(
    `INSERT INTO users (user_code, email, display_name, password_hash, is_verified)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_code, email, display_name, is_verified, avatar_url, created_at`,
    [userCode, email.toLowerCase(), displayName.trim(), passwordHash, false]
  );
  const user = result.rows[0];

  // Create verification token & 6-digit numeric OTP
  const verifyToken = generateToken();
  const verifyOtp = String(crypto.randomInt(100000, 1000000));
  const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await query(
    `INSERT INTO email_verifications (user_id, token_hash, expires_at, otp_code) VALUES ($1, $2, $3, $4)`,
    [user.id, hashToken(verifyToken), verifyExpiresAt, verifyOtp]
  );

  const emailRes = await mailer.sendVerificationEmail({
    user: {
      id: user.id,
      email: user.email,
      userCode: user.user_code,
      displayName: user.display_name
    },
    token: verifyToken,
    otp: verifyOtp,
    appUrl
  });

  const pubUser = publicUser(user);
  sheets.upsertUser(pubUser).catch(() => {});

  activity.logEvent({
    userCode: user.user_code,
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    category: 'auth',
    type: 'signup_pending_verification',
    title: 'New User Registered (Pending OTP Verification)',
    summary: `Assigned ID #${user.user_code} to ${user.email}`,
    details: { userCode: user.user_code, email: user.email }
  });

  const isDelivered = Boolean(emailRes && emailRes.delivered);
  const isSandbox = Boolean(emailRes && emailRes.sandboxRestricted);

  return {
    user: pubUser,
    needsVerification: true,
    userCode: user.user_code,
    email: user.email,
    delivered: isDelivered,
    sandboxRestricted: isSandbox,
    message: `Account created! We've sent a 6-digit verification code to ${user.email}. Please check your email inbox and enter the code below to activate your account.`
  };
}

async function verifyOtp({ email, otp }, meta = {}) {
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanOtp = (otp || '').trim();
  if (!cleanEmail) throw httpError(400, 'Email address or User ID is required');
  if (!cleanOtp) throw httpError(400, 'Please enter the 6-digit OTP code');

  let user = null;
  if (/^[0-9]{4}$/.test(cleanEmail)) {
    const resByCode = await query('SELECT * FROM users WHERE user_code = $1', [cleanEmail]);
    user = resByCode.rows && resByCode.rows[0];
  }
  if (!user) {
    const userRes = await query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    user = userRes.rows && userRes.rows[0];
  }
  if (!user) throw httpError(404, 'No account found with this email or User ID');

  if (user.is_verified) {
    const token = await createSession(user.id, meta);
    return { user: publicUser(user), token, message: 'Account is already verified!' };
  }

  const verRes = await query(
    `SELECT * FROM email_verifications 
     WHERE user_id = $1 AND (otp_code = $2 OR token_hash = $3) AND verified_at IS NULL`,
    [user.id, cleanOtp, hashToken(cleanOtp)]
  );
  const record = verRes.rows && verRes.rows[0];
  if (!record) {
    throw httpError(400, 'Invalid or expired OTP verification code. Please check your inbox or click Resend.');
  }

  const expiresTime = new Date(record.expires_at).getTime();
  if (expiresTime && expiresTime < Date.now()) {
    throw httpError(400, 'OTP verification code has expired. Please click Resend OTP to receive a new code.');
  }

  await query('UPDATE email_verifications SET verified_at = now() WHERE id = $1', [record.id]);
  await query('UPDATE users SET is_verified = true, updated_at = now() WHERE id = $1', [user.id]);
  user.is_verified = true;

  const token = await createSession(user.id, meta);

  activity.logEvent({
    userCode: user.user_code,
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    category: 'auth',
    type: 'email_verified_otp',
    title: 'Account Activated via OTP',
    summary: `Account #${user.user_code} (${user.email}) activated via OTP code ${cleanOtp}`
  });

  return { user: publicUser(user), token };
}

async function verifyEmail(token) {
  const cleanToken = (token || '').trim();
  if (!cleanToken) throw httpError(400, 'Verification token is required');

  const recordRes = await query(
    `SELECT * FROM email_verifications WHERE token_hash = $1 AND verified_at IS NULL`,
    [hashToken(cleanToken)]
  );
  const record = recordRes.rows && recordRes.rows[0];
  if (!record) {
    throw httpError(400, 'This verification link is invalid, expired, or has already been used.');
  }

  const expiresTime = new Date(record.expires_at).getTime();
  if (expiresTime && expiresTime < Date.now()) {
    throw httpError(400, 'This verification link has expired.');
  }

  await query('UPDATE email_verifications SET verified_at = now() WHERE id = $1', [record.id]);
  await query('UPDATE users SET is_verified = true, updated_at = now() WHERE id = $1', [record.user_id]);

  const userRes = await query('SELECT * FROM users WHERE id = $1', [record.user_id]);
  const user = userRes.rows && userRes.rows[0];
  if (!user) throw httpError(404, 'User account not found');

  activity.logEvent({
    userCode: user.user_code,
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    category: 'auth',
    type: 'email_verified',
    title: 'Account Activated via Email Verification',
    summary: `Account #${user.user_code} (${user.email}) is now active`
  });

  return publicUser(user);
}

async function resendVerificationEmail(identifier, appUrl) {
  const clean = (identifier || '').trim();
  if (!clean) throw httpError(400, 'Please enter your email or 4-digit User ID');

  let user = null;
  if (/^[0-9]{4}$/.test(clean)) {
    const res = await query('SELECT * FROM users WHERE user_code = $1', [clean]);
    user = res.rows && res.rows[0];
  }
  if (!user) {
    const res = await query('SELECT * FROM users WHERE email = $1', [clean.toLowerCase()]);
    user = res.rows && res.rows[0];
  }
  if (!user) throw httpError(404, 'No account found with this email or User ID');

  if (user.is_verified) {
    return { alreadyVerified: true, message: 'This account is already verified! You can sign in immediately.' };
  }

  const verifyToken = generateToken();
  const verifyOtp = String(crypto.randomInt(100000, 1000000));
  const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await query('DELETE FROM email_verifications WHERE user_id = $1', [user.id]).catch(() => {});
  await query(
    'INSERT INTO email_verifications (user_id, token_hash, expires_at, otp_code) VALUES ($1, $2, $3, $4)',
    [user.id, hashToken(verifyToken), verifyExpiresAt, verifyOtp]
  );

  const emailRes = await mailer.sendVerificationEmail({
    user: { id: user.id, email: user.email, userCode: user.user_code, displayName: user.display_name },
    token: verifyToken,
    otp: verifyOtp,
    appUrl
  });

  const emailMasked = user.email.slice(0, 2) + '***@' + (user.email.split('@')[1] || '');
  const isDelivered = Boolean(emailRes && emailRes.delivered);
  const isSandbox = Boolean(emailRes && emailRes.sandboxRestricted);

  return {
    ok: true,
    userCode: user.user_code,
    emailMasked,
    delivered: isDelivered,
    sandboxRestricted: isSandbox,
    message: `A fresh 6-digit verification code has been sent to your email (${emailMasked}). Please check your inbox and enter the code below.`
  };
}

async function createSession(userId, meta = {}) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hashToken(token), expiresAt, meta.userAgent || null, meta.ip || null]
  );
  return token;
}

async function login({ email, password }, meta = {}) {
  const result = await query('SELECT * FROM users WHERE email = $1', [(email || '').toLowerCase()]);
  const user = result.rows[0];
  if (!user) throw httpError(401, 'Invalid email or password');
  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) throw httpError(401, 'Invalid email or password');

  if (user.is_verified === false) {
    const err = httpError(403, 'Your account is pending email verification. Please check your inbox and click the verification link to activate your account.');
    err.needsVerification = true;
    err.email = user.email;
    err.userCode = user.user_code;
    throw err;
  }

  const token = await createSession(user.id, meta);

  const pubUser = publicUser(user);
  setImmediate(() => {
    mailer.sendLoginAlertEmail({
      user: pubUser,
      ip: meta.ip,
      userAgent: meta.userAgent
    }).catch(e => console.error('Login email dispatch error:', e.message));
  });

  return { token, user: pubUser };
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

async function requestPasswordReset(identifier, appUrl) {
  const clean = (identifier || '').trim();
  let user = null;

  if (/^[0-9]{4}$/.test(clean)) {
    const resByCode = await query('SELECT id, email, user_code, display_name FROM users WHERE user_code = $1', [clean]);
    user = resByCode.rows[0];
  }
  if (!user && clean) {
    const resByEmail = await query('SELECT id, email, user_code, display_name FROM users WHERE email = $1', [clean.toLowerCase()]);
    user = resByEmail.rows[0];
  }

  if (!user) {
    return { sent: false, userFound: false };
  }

  const token = generateToken();
  const resetOtp = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at, otp_code) VALUES ($1, $2, $3, $4)`,
    [user.id, hashToken(token), expiresAt, resetOtp]
  );
  const emailRes = await mailer.sendPasswordResetEmail({
    user: {
      id: user.id,
      email: user.email,
      userCode: user.user_code,
      displayName: user.display_name
    },
    token,
    otp: resetOtp,
    appUrl
  });

  let emailMasked = user.email || '';
  if (emailMasked.includes('@')) {
    const parts = emailMasked.split('@');
    const namePart = parts[0];
    const domainPart = parts[1];
    const maskedName = namePart.length <= 2 ? namePart + '***' : namePart.slice(0, 2) + '***' + namePart.slice(-1);
    emailMasked = `${maskedName}@${domainPart}`;
  }

  const isDelivered = Boolean(emailRes && emailRes.delivered);
  const isSandbox = Boolean(emailRes && emailRes.sandboxRestricted);

  return {
    sent: true,
    userFound: true,
    emailMasked,
    email: user.email,
    userCode: user.user_code,
    displayName: user.display_name,
    delivered: isDelivered,
    sandboxRestricted: isSandbox,
    message: `A 6-digit password reset code has been sent to your registered email (${emailMasked}). Please check your inbox and enter the code below.`
  };
}

async function resetPassword(arg1, arg2, arg3) {
  let cleanToken = '';
  let cleanOtp = '';
  let cleanIdent = '';
  let newPassword = '';
  let meta = {};

  if (typeof arg1 === 'object' && arg1 !== null) {
    const inputVal = (arg1.token || arg1.otp || '').trim();
    cleanOtp = (arg1.otp || '').trim();
    if (!cleanOtp && /^[0-9]{6}$/.test(inputVal)) {
      cleanOtp = inputVal;
    }
    cleanToken = inputVal;
    cleanIdent = (arg1.identifier || arg1.email || '').trim().toLowerCase();
    newPassword = (arg1.newPassword || '').trim();
    meta = arg2 || {};
  } else {
    cleanToken = (arg1 || '').trim();
    if (/^[0-9]{6}$/.test(cleanToken)) {
      cleanOtp = cleanToken;
    }
    newPassword = (arg2 || '').trim();
    meta = arg3 || {};
  }

  if (!isValidPassword(newPassword)) throw httpError(400, 'Password must be at least 8 characters');

  let record = null;

  if (cleanIdent && (cleanOtp || cleanToken)) {
    let targetUser = null;
    if (/^[0-9]{4}$/.test(cleanIdent)) {
      const uRes = await query('SELECT id FROM users WHERE user_code = $1', [cleanIdent]);
      targetUser = uRes.rows && uRes.rows[0];
    }
    if (!targetUser) {
      const uRes = await query('SELECT id FROM users WHERE email = $1', [cleanIdent]);
      targetUser = uRes.rows && uRes.rows[0];
    }
    if (targetUser) {
      const otpToTest = cleanOtp || cleanToken;
      const rRes = await query(
        `SELECT * FROM password_resets WHERE user_id = $1 AND (otp_code = $2 OR token_hash = $3) AND used_at IS NULL`,
        [targetUser.id, otpToTest, hashToken(otpToTest)]
      );
      record = rRes.rows && rRes.rows[0];
    }
  }

  if (!record && (cleanOtp || /^[0-9]{6}$/.test(cleanToken))) {
    const otpToTest = cleanOtp || cleanToken;
    const rRes = await query(
      `SELECT * FROM password_resets WHERE otp_code = $1 AND used_at IS NULL`,
      [otpToTest]
    );
    record = rRes.rows && rRes.rows[0];
  }

  if (!record && cleanToken) {
    const hashedInputToken = hashToken(cleanToken);
    const rRes = await query(
      `SELECT * FROM password_resets WHERE (token_hash = $1 OR token_hash = $2) AND used_at IS NULL`,
      [hashedInputToken, cleanToken]
    );
    record = rRes.rows && rRes.rows[0];
  }

  if (!record) throw httpError(400, 'This reset link or OTP code is invalid.');

  const expiresTime = new Date(record.expires_at).getTime();
  if (expiresTime && expiresTime < Date.now()) {
    throw httpError(400, 'This reset link or OTP code has expired.');
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await query('UPDATE users SET password_hash = $1, is_verified = true, updated_at = now() WHERE id = $2', [passwordHash, record.user_id]);
  await query('UPDATE password_resets SET used_at = now() WHERE id = $1', [record.id]);
  await query('DELETE FROM sessions WHERE user_id = $1', [record.user_id]);

  const userRes = await query('SELECT id, email, user_code, display_name FROM users WHERE id = $1', [record.user_id]);
  const user = userRes.rows && userRes.rows[0];
  const sessionToken = user ? await createSession(user.id, meta) : null;

  activity.logEvent({
    userCode: user ? user.user_code : '0000',
    userId: user ? user.id : record.user_id,
    email: user ? user.email : '',
    displayName: user ? user.display_name : '',
    category: 'auth',
    type: 'password_reset_success',
    title: 'Password Successfully Reset',
    summary: `Password reset successfully for account #${user ? user.user_code : ''}`
  });

  return { user: user ? publicUser(user) : null, token: sessionToken };
}

async function changeUserCode(userId, newCode) {
  if (!isValidUserCode(newCode)) throw httpError(400, 'User ID must be exactly 4 digits');
  const existing = await query('SELECT id FROM users WHERE user_code = $1 AND id != $2', [newCode, userId]);
  if (existing.rows.length) throw httpError(409, 'That User ID is already taken');
  const current = await query('SELECT user_code FROM users WHERE id = $1', [userId]);
  const oldCode = current.rows[0] ? current.rows[0].user_code : null;
  const result = await query(
    'UPDATE users SET user_code = $1, updated_at = now() WHERE id = $2 RETURNING id, user_code, email, display_name, avatar_url, created_at',
    [newCode, userId]
  );
  const user = publicUser(result.rows[0]);
  sheets.upsertUser(user, oldCode).catch(() => {});
  return newCode;
}

async function deleteUser(userCode) {
  const target = String(userCode || '').trim();
  if (!target) throw httpError(400, 'User ID is required');
  const userRes = await query('SELECT * FROM users WHERE user_code = $1', [target]);
  const user = userRes.rows && userRes.rows[0];
  if (!user) throw httpError(404, 'No account found with User ID #' + target);

  await query('DELETE FROM sessions WHERE user_id = $1', [user.id]).catch(() => {});
  await query('DELETE FROM password_resets WHERE user_id = $1', [user.id]).catch(() => {});
  await query('DELETE FROM email_verifications WHERE user_id = $1', [user.id]).catch(() => {});
  await query('DELETE FROM users WHERE id = $1', [user.id]);
  sheets.deleteUserRow(user.user_code).catch(() => {});

  activity.logEvent({
    userCode: user.user_code,
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    category: 'auth',
    type: 'account_deleted',
    title: 'User Account Permanently Deleted',
    summary: `Account #${user.user_code} (${user.email}) was deleted`
  });

  return publicUser(user);
}

async function deleteMyAccount(token) {
  if (!token) throw httpError(401, 'Authentication required');
  const user = await getUserByToken(token);
  if (!user) throw httpError(401, 'Invalid or expired session');
  return await deleteUser(user.userCode);
}

module.exports = {
  signup, login, logout, getUserByToken, createSession,
  requestPasswordReset, resetPassword, verifyEmail, verifyOtp, resendVerificationEmail,
  deleteUser, deleteMyAccount, changeUserCode, rateLimit, httpError
};