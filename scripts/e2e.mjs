/**
 * Startet den Worker lokal (workerd + lokale D1/KV in einem frischen Ordner),
 * führt tests/e2e.test.ts dagegen aus und beendet den Worker wieder.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 8790 + Math.floor(Math.random() * 100);
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'splitapp-e2e-'));
fs.mkdirSync('dist/web', { recursive: true });
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const migrate = spawnSync(npx, ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist], {
  stdio: 'inherit',
  env: { ...process.env, CI: '1' },
});
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const worker = spawn(npx, ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', 'WEB_URL:http://localhost:5173/'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CI: '1' },
});
let log = '';
worker.stdout.on('data', (d) => (log += d));
worker.stderr.on('data', (d) => (log += d));

const base = `http://127.0.0.1:${port}`;
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  try {
    ready = (await fetch(`${base}/healthz`)).ok;
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!ready) {
  console.error('Worker startet nicht:\n', log);
  worker.kill();
  process.exit(1);
}

const test = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/e2e.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, E2E_URL: base },
});
worker.kill();
fs.rmSync(persist, { recursive: true, force: true });
process.exit(test.status ?? 1);
