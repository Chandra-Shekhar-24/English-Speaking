// ============================================================
// scripts/test-real-sessions.js
// Measures concurrent active logged-in sessions via real HTTP
// ============================================================
const http = require('http');

const PORT = 3000;
const HOST = '127.0.0.1';

function request({ path, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve) => {
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
        resolve({ statusCode: res.statusCode, headers: res.headers, data: json || data, duration });
      });
    });

    req.on('error', (err) => resolve({ statusCode: 0, error: err.message, duration: Date.now() - start }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ statusCode: 408, error: 'timeout', duration: Date.now() - start });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

async function testConcurrentActiveUsers(batchSize, cookieHeader) {
  const start = Date.now();
  const promises = [];
  for (let i = 0; i < batchSize; i++) {
    promises.push(request({
      path: '/api/auth/me',
      method: 'GET',
      headers: { Cookie: cookieHeader }
    }));
  }

  const results = await Promise.all(promises);
  const totalMs = Date.now() - start;
  const verifiedUsers = results.filter(r => r.statusCode === 200 && r.data && r.data.user && r.data.user.email);
  const durations = results.map(r => r.duration).sort((a, b) => a - b);
  const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const median = durations[Math.floor(durations.length / 2)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const rps = Math.round((verifiedUsers.length / (totalMs / 1000)));

  console.log(`⚡ ${batchSize} Concurrent Active Users: ${verifiedUsers.length}/${batchSize} verified in ${totalMs}ms | Avg: ${avg}ms | Median: ${median}ms | p95: ${p95}ms | Throughput: ${rps} req/sec`);
  return { batchSize, verified: verifiedUsers.length, totalMs, avg, p95, rps };
}

async function run() {
  console.log('Logging in via HTTP endpoint to establish real server session...');
  const loginRes = await request({
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'x-forwarded-for': '172.16.0.42' },
    body: { email: 'test@example.com', password: 'password123' }
  });

  const cookieHeader = loginRes.headers['set-cookie'];
  const cookieStr = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  const match = cookieStr ? cookieStr.match(/epp_session=[^;]+/) : null;

  if (!match) {
    console.error('Login failed:', loginRes.statusCode, loginRes.data);
    process.exit(1);
  }

  const cookie = match[0];
  console.log('✅ Real session created on server. Session cookie:', cookie.slice(0, 24) + '...');

  console.log('\n--- Benchmarking Concurrent Logged-In Active Users ---');
  await testConcurrentActiveUsers(50, cookie);
  await testConcurrentActiveUsers(100, cookie);
  await testConcurrentActiveUsers(250, cookie);
  await testConcurrentActiveUsers(500, cookie);
  await testConcurrentActiveUsers(1000, cookie);

  console.log('\nBenchmark completed successfully.');
  process.exit(0);
}

run().catch(console.error);
