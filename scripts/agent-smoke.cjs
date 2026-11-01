#!/usr/bin/env node
/**
 * Bundled agent smoke test (Windows CI).
 *
 * Runs the bundled agent.cjs with an isolated ARCHSYNC_DATA_DIR, then asserts:
 *   1. /healthz returns 200
 *   2. / (web dist) returns 200
 *   3. registry.sqlite is created inside ARCHSYNC_DATA_DIR (not app resources)
 *
 * This is the same bundle electron-builder packages, so the test exercises the
 * identical resource resolution and startup logic as the shipped desktop app.
 * Exit 0 = all checks passed; exit 1 = any failure (with message).
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'archsync-smoke-'));
const agentPath = path.join(root, 'apps', 'desktop', 'dist-electron', 'agent', 'agent.cjs');

if (!fs.existsSync(agentPath)) {
  console.error(`agent bundle missing: ${agentPath}`);
  process.exit(1);
}

const reservation = net.createServer();
reservation.listen(0, '127.0.0.1', () => {
  const port = reservation.address().port;
  reservation.close(() => run(port));
});

function run(port) {
const child = spawn(process.execPath, [agentPath], {
  env: {
    ...process.env,
    ARCHSYNC_DATA_DIR: dataDir,
    ARCHSYNC_PYTHON_ASSETS: path.join(root, 'apps', 'desktop', 'dist-electron', 'python-assets'),
    WORKSPACE_ROOT: dataDir,
    ARCHSYNC_WEB_DIST: path.join(root, 'apps', 'web', 'dist'),
    PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => process.stdout.write(`[agent] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[agent] ${d}`));

const start = Date.now();
let phase = 0;
let done = false;

function fail(msg) {
  console.error(`smoke FAIL: ${msg}`);
  child.kill();
  process.exit(1);
}

function get(path, cb) {
  http.get(`http://127.0.0.1:${port}${path}`, (res) => cb(res.statusCode)).on('error', (e) => {
    if (Date.now() - start > 45000) fail(`request ${path} timed out: ${e.message}`);
    else setTimeout(() => get(path, cb), 500);
  });
}

get('/healthz', (code) => {
  if (code !== 200) fail(`healthz returned ${code}`);
  console.log('smoke: healthz 200 OK');
  phase = 1;
  get('/', (code2) => {
    if (code2 !== 200) fail(`web dist returned ${code2}`);
    console.log('smoke: web dist 200 OK');
    phase = 2;
    get('/api/v1/registry', (code3) => {
      if (code3 !== 200) fail(`registry returned ${code3}`);
      console.log('smoke: registry 200 OK');
      finish();
    });
  });
});

function finish() {
  const sqlitePath = path.join(dataDir, 'registry.sqlite');
  if (!fs.existsSync(sqlitePath)) fail(`registry.sqlite missing in ARCHSYNC_DATA_DIR (${dataDir})`);
  console.log(`smoke: sqlite OK at ${sqlitePath}`);
  console.log('smoke PASS: bundled agent started, served web, created sqlite in data dir');
  done = true;
  child.kill();
  process.exit(0);
}

setTimeout(() => {
  if (!done) fail(`timed out at phase ${phase}`);
}, 60000);

child.on('exit', (code) => {
  if (!done) fail(`agent exited early with code ${code}`);
});
}
