// ============================================================
// scripts/test-login-concurrency.js
// Measures how many new distinct logins per second the server handles
// ============================================================
const http = require('http');

const PORT = 3000;
const HOST = '127.0.0.1';

function loginRequest(index) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ email: 'test@example.com', password: 'password123' });
    const start = Date.now();
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        // Simulate realistic distinct public IP per user to test distinct client throughput
        'x-forwarded-for': `49.37.${Math.floor(index / 200) + 1}.${(index % 200) + 1}`
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const duration = Date.now() - start;
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ statusCode: res.statusCode, duration, user: json ? json.user : null });
      });
    });

    req.on('error', (err) => resolve({ statusCode: 0, error: err.message, duration: Date.now() - start }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ statusCode: 408, error: 'timeout', duration: Date.now() - start });
    });

    req.write(payload);
    req.end();
  });
}

async function testSimultaneousLogins(count) {
  const start = Date.now();
  const promises = [];
  for (let i = 0; i < count; i++) {
    promises.push(loginRequest(i));
  }

  const results = await Promise.all(promises);
  const totalMs = Date.now() - start;
  const ok = results.filter(r => r.statusCode === 200).length;
  const durations = results.map(r => r.duration).sort((a, b) => a - b);
  const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const median = durations[Math.floor(durations.length / 2)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const loginsPerSec = Math.round((ok / (totalMs / 1000)));

  console.log(`🔐 ${count} Simultaneous Login Burst: ${ok}/${count} Success in ${totalMs}ms | Avg: ${avg}ms | Median: ${median}ms | p95: ${p95}ms | Rate: ${loginsPerSec} logins/sec`);
  return { count, ok, totalMs, avg, p95, loginsPerSec };
}

async function main() {
  console.log('--- Testing Simultaneous Login Burst Capacity ---');
  await testSimultaneousLogins(10);
  await testSimultaneousLogins(25);
  await testSimultaneousLogins(50);
  console.log('Login burst test complete.');
  process.exit(0);
}

main().catch(console.error);
