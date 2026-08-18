// ============================================================
// db/pool.js — PostgreSQL connection pool
//
// Uses the `pg` driver (pure JavaScript, no native compilation —
// unlike better-sqlite3, this will never fail to build on a host
// like Render). Requires a DATABASE_URL environment variable
// pointing at any managed Postgres instance (Neon, Supabase,
// Render Postgres, Railway, RDS, etc).
// ============================================================
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL is not set. Accounts, login, and persistent chat/call history will not work until you configure a PostgreSQL database. See .env.example.');
}

// Most managed Postgres providers require SSL and issue certificates
// that Node's default trust store doesn't always chain cleanly, so we
// disable strict verification for the connection itself (this is the
// standard approach for these providers — the connection is still
// encrypted, just not certificate-pinned).
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
      max: parseInt(process.env.DATABASE_POOL_MAX || '10', 10)
    })
  : null;

if (pool) {
  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err.message);
  });
}

async function query(text, params) {
  if (!pool) {
    const e = new Error('Database not configured (DATABASE_URL missing)');
    e.status = 503;
    throw e;
  }
  return pool.query(text, params);
}

module.exports = { pool, query };
