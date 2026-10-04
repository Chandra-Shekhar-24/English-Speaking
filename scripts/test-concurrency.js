// ============================================================
// scripts/test-concurrency.js — Benchmark Concurrent Logins & Active Sessions
// ============================================================
const http = require('http');

const PORT = 3000;
const HOST = '127.0.0.1';

function makeRequest({ path, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const reqHeaders = Object.assign({}, headers);
    if (payload) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const start = Date.now();
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers: reqHeaders,
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const duration = Date.now() - start;
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data: json || data,
          duration
        });
      });
    });

    req.on('error', (err) => {
      resolve({ statusCode: 0, error: err.message, duration: Date.now() - start });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ statusCode: 408, error: 'Request timeout', duration: Date.now() - start });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

async function runConcurrencyTest(concurrencyCount) {
  console.log(`\n============================================================`);
  console.log(`🚀 RUNNING CONCURRENCY TEST: ${concurrencyCount} SIMULTANEOUS USERS`);
  console.log(`============================================================`);

  const initialMem = process.memoryUsage();
  const startTime = Date.now();

  // Step 1: Fire all logins concurrently from realistic distinct client IPs
  const loginPromises = [];
  for (let i = 0; i < concurrencyCount; i++) {
    loginPromises.push(
      makeRequest({
        path: '/api/auth/login',
        method: 'POST',
        headers: {
          'x-forwarded-for': `192.168.${Math.floor(i / 250) + 1}.${(i % 250) + 1}`
        },
        body: { email: 'test@example.com', password: 'password123' }
      })
    );
  }

  const loginResults = await Promise.all(loginPromises);
  const totalLoginTime = Date.now() - startTime;

  let successfulLogins = 0;
  let failedLogins = 0;
  const loginCookies = [];
  const durations = [];

  for (const res of loginResults) {
    durations.push(res.duration);
    if (res.statusCode === 200 && res.headers['set-cookie']) {
      successfulLogins++;
      const cookieHeader = res.headers['set-cookie'];
      const rawCookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
      const match = rawCookie ? rawCookie.match(/epp_session=[^;]+/) : null;
      if (match) loginCookies.push(match[0]);
    } else {
      failedLogins++;
    }
  }

  durations.sort((a, b) => a - b);
  const avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const medianDuration = durations[Math.floor(durations.length / 2)];
  const p95Duration = durations[Math.floor(durations.length * 0.95)];

  console.log(`📊 Logins: ${successfulLogins}/${concurrencyCount} Successful (${failedLogins} failed)`);
  console.log(`⏱️ Total Time: ${totalLoginTime}ms | Avg Latency: ${avgDuration}ms | Median: ${medianDuration}ms | 95th Percentile: ${p95Duration}ms`);

  // Step 2: Validate all sessions concurrently via /api/auth/me
  const sessionStartTime = Date.now();
  const sessionPromises = loginCookies.map(cookie =>
    makeRequest({
      path: '/api/auth/me',
      method: 'GET',
      headers: { Cookie: cookie }
    })
  );

  const sessionResults = await Promise.all(sessionPromises);
  const totalSessionTime = Date.now() - sessionStartTime;

  let validSessions = 0;
  for (const s of sessionResults) {
    if (s.statusCode === 200 && s.data && s.data.user) {
      validSessions++;
    }
  }

  const finalMem = process.memoryUsage();
  const memDeltaMB = Math.round((finalMem.rss - initialMem.rss) / 1024 / 1024);

  console.log(`🔑 Concurrent Active Sessions Verified: ${validSessions}/${loginCookies.length}`);
  console.log(`⚡ Session Verification Throughput: ${Math.round((validSessions / (totalSessionTime / 1000)))} req/sec`);
  console.log(`💾 Memory Usage Delta: ~${memDeltaMB} MB`);

  return {
    concurrencyCount,
    successfulLogins,
    failedLogins,
    avgDuration,
    medianDuration,
    p95Duration,
    validSessions,
    throughput: Math.round((validSessions / (totalSessionTime / 1000)))
  };
}

async function main() {
  try {
    // Warm up
    await makeRequest({ path: '/api/auth/me' });

    console.log('Testing concurrency levels...');
    const res25 = await runConcurrencyTest(25);
    const res50 = await runConcurrencyTest(50);
    const res100 = await runConcurrencyTest(100);

    console.log('\n============================================================');
    console.log('🏁 FINAL CONCURRENCY BENCHMARK SUMMARY');
    console.log('============================================================');
    console.log(`Level 1 (25 simultaneous): ${res25.successfulLogins}/25 logins OK | Latency: ${res25.avgDuration}ms`);
    console.log(`Level 2 (50 simultaneous): ${res50.successfulLogins}/50 logins OK | Latency: ${res50.avgDuration}ms`);
    console.log(`Level 3 (100 simultaneous): ${res100.successfulLogins}/100 logins OK | Latency: ${res100.avgDuration}ms`);
    console.log('============================================================\n');

    process.exit(0);
  } catch (err) {
    console.error('Benchmark error:', err);
    process.exit(1);
  }
}

main();
