// ============================================================
// db/pool.js — PostgreSQL connection pool
//
// Uses the `pg` driver (pure JavaScript, no native compilation —
// unlike better-sqlite3, this will never fail to build on a host
// like Render). Requires a DATABASE_URL environment variable
// pointing at any managed Postgres instance (Neon, Supabase,
// Render Postgres, Railway, RDS, etc).
//
// This file validates DATABASE_URL at startup instead of letting a
// malformed value surface as a cryptic "TypeError: Invalid URL" deep
// inside the first request that touches the database. Common
// copy-paste mistakes (stray whitespace/newlines, wrapping quotes,
// an unencoded special character in the password) are either fixed
// automatically or reported clearly, once, at boot.
// ============================================================
const { Pool } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');

let pool = null;
let configError = null; // human-readable reason the pool isn't usable, if any

function sanitizeDatabaseUrl(raw) {
  if (!raw) return raw;
  let s = raw.trim();
  // Strip a single pair of surrounding quotes some hosts' env-var UIs add
  // when a value is pasted (e.g. `"postgresql://..."`).
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function describeConnectionStringProblem(rawUrl, err) {
  const lines = [
    'DATABASE_URL could not be parsed as a valid PostgreSQL connection string.',
    `Underlying error: ${err.message}`
  ];
  if (!/^postgres(ql)?:\/\//i.test(rawUrl)) {
    lines.push('- It does not start with "postgresql://" or "postgres://". Make sure you copied the full connection string, not just part of it.');
  }
  if (/\s/.test(rawUrl)) {
    lines.push('- It contains whitespace (a space, tab, or line break). Re-copy it as a single line with no surrounding spaces.');
  }
  const passwordMatch = rawUrl.match(/:\/\/[^:]+:([^@]+)@/);
  if (passwordMatch && /[#%?/\\]/.test(passwordMatch[1])) {
    lines.push('- The password segment contains a character (#, %, ?, /, or \\) that must be percent-encoded in a URL. Either regenerate a password without special characters, or copy the connection string directly from your provider\'s dashboard (Neon/Supabase already encode it correctly) instead of typing it by hand.');
  }
  lines.push('Fix the DATABASE_URL environment variable (in Render: Dashboard → your service → Environment) and redeploy.');
  return lines.join('\n');
}

const rawDatabaseUrl = process.env.DATABASE_URL;

if (!rawDatabaseUrl) {
  console.warn('⚠️  DATABASE_URL is not set. Accounts, login, and persistent chat/call history will not work until you configure a PostgreSQL database. See .env.example.');
} else {
  const cleanedUrl = sanitizeDatabaseUrl(rawDatabaseUrl);

  try {
    // Validate up front so a bad value fails loudly and clearly at boot,
    // instead of as a bare "Invalid URL" on whichever request happens to
    // hit the database first.
    parseConnectionString(cleanedUrl);

    // Most managed Postgres providers require SSL and issue certificates
    // that Node's default trust store doesn't always chain cleanly, so we
    // disable strict verification for the connection itself (this is the
    // standard approach for these providers — the connection is still
    // encrypted, just not certificate-pinned).
    pool = new Pool({
      connectionString: cleanedUrl,
      ssl: cleanedUrl.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
      max: parseInt(process.env.DATABASE_POOL_MAX || '10', 10)
    });

    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL pool error:', err.message);
    });
  } catch (err) {
    configError = describeConnectionStringProblem(cleanedUrl, err);
    console.error('❌ ' + configError);
  }
}

async function query(text, params) {
  if (!pool) {
    const e = new Error(configError || 'Database not configured (DATABASE_URL missing)');
    e.status = 503;
    throw e;
  }
  try {
    return await pool.query(text, params);
  } catch (err) {
    // Surface connection-level failures (wrong host, wrong password,
    // network/SSL issues) with a clearer hint than the raw driver error.
    if (err.message === 'Invalid URL' || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      console.error('❌ PostgreSQL connection failed:', err.message, '— double-check DATABASE_URL (host, port, password) in your environment variables.');
    }
    throw err;
  }
}

module.exports = { pool, query };
