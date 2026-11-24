#!/usr/bin/env node
// Starts a packaged SPX-GC build and checks that it serves pages.
//
// Usage: node scripts/smoke-test.js pkg-builds/spx-gc-<version>-<target>
//
// The build folder is copied to a temp dir first, because on first start the
// app writes config.json and LOG/ next to the executable.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 5656; // default port written to a freshly generated config.json
const TIMEOUT_MS = 60000;
const CHECKS = [
  { url: '/', what: 'rendered page (embedded views/)' },
  { url: '/img/spx_online.png', what: 'static file (embedded static/)' },
];

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${PORT}${url}`, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

async function waitForServer(child) {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    if (child.exitCode !== null) throw new Error(`process exited early with code ${child.exitCode}`);
    try {
      return await get('/');
    } catch (e) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`server did not respond on port ${PORT} within ${TIMEOUT_MS / 1000}s`);
}

async function main() {
  const buildDir = process.argv[2];
  if (!buildDir) throw new Error('usage: node scripts/smoke-test.js <build folder>');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spx-gc-smoke-'));
  fs.cpSync(path.resolve(buildDir), workDir, { recursive: true });
  const exe = path.join(workDir, process.platform === 'win32' ? 'spx-gc.exe' : 'spx-gc');
  console.log(`Starting ${exe}`);

  const child = spawn(exe, [], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  let failed = false;
  try {
    await waitForServer(child);
    for (const check of CHECKS) {
      const res = await get(check.url);
      const ok = res.status === 200;
      console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${res.status} ${check.url} - ${check.what}`);
      if (!ok) failed = true;
    }
  } catch (e) {
    console.error(`  FAIL ${e.message}`);
    failed = true;
  } finally {
    child.kill();
  }

  if (failed) {
    console.error('\n--- application output ---\n' + output);
    process.exit(1);
  }
  console.log('Smoke test passed.');
  fs.rmSync(workDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
