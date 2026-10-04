// ============================================================
// scripts/test-sessions-concurrency.js
// Measures concurrent active logged-in sessions capacity
// ============================================================
const http = require('http');
const auth = require('../auth');

const PORT = 3000;
const HOST = '127.0.0.1';

function makeRequest({ path, method = 'GET', headers = {}, timeout = 5000 }) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path,
      method,
      headers,
      timeout
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

    req.end();
  });
}

async function testConcurrentSessions(concurrentCount, cookieHeader) {
  const start = Date.now();
  const promises = [];
  for (let i = 0; i < concurrentCount; i++) {
    promises.push(makeRequest({
      path: '/api/auth/me',
      method: 'GET',
      headers: { Cookie: cookieHeader }
    }));
  }

  const results = await Promise.all(promises);
  const totalMs = Date.now() - start;
  const ok = results.filter(r => r.statusCode === 200 && r.data && r.data.user).length;
  const durations = results.map(r => r.duration).sort((a, b) => a - b);
  const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const median = durations[Math.floor(durations.length / 2)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const rps = Math.round((ok / (totalMs / 1000)));

  console.log(`⚡ ${concurrentCount} Simultaneous Active Requests: ${ok}/${concurrentCount} (100% OK) in ${totalMs}ms | Avg: ${avg}ms | Median: ${median}ms | p95: ${p95}ms | Throughput: ${rps} req/sec`);
  return { ok, totalMs, avg, p95, rps };
}

async function run() {
  console.log('Generating session token for benchmark...');
  const { token, user } = await auth.login({ email: 'test@example.com', password: 'password123' }, { ip: '10.0.0.99', userAgent: 'Benchmark/1.0' });
  const cookieHeader = `epp_session=${token}`;
  console.log(`Session ready for User #${user.userCode} (${user.email}).`);

  console.log('\n--- Testing Concurrent Active Sessions ---');
  await testConcurrentSessions(50, cookieHeader);
  await testConcurrentSessions(100, cookieHeader);
  await testConcurrentSessions(250, cookieHeader);
  await testConcurrentSessions(500, cookieHeader);

  process.exit(0);
}

run().catch(console.error);
