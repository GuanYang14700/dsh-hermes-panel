/**
 * End-to-end health check against the real installation.
 *
 * `verify/health.mjs` proves the route against a stubbed PowerShell; this proves
 * the part a stub cannot: that the real `doctor.ps1 -Json` output is located,
 * parsed, and that its non-ASCII details survive the trip through a real
 * PowerShell host. It is read-only — `doctor.ps1` inspects, it never changes.
 *
 * Resolves the installation the same way the plugin does (`verify/target.mjs`,
 * which is deliberately an independent implementation), so it needs a real
 * Hermes. Part of `npm run test:e2e`.
 *
 * Usage: node verify/health-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { apply } from '../index.js';
import { requireTarget } from './target.mjs';

const TARGET = requireTarget();

let failures = 0;
/**
 * Record one assertion outcome.
 * @param label - what was checked.
 * @param ok - assertion result.
 * @param detail - evidence to print.
 */
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const routes = new Map();
const disposers = [];

const ctx = {
  effect(callback) {
    const disposer = callback();
    if (typeof disposer === 'function') disposers.push(disposer);
    return disposer;
  },
  webServer: {
    register(route) {
      routes.set(`${route.kind}:${route.path}`, route);
      return () => routes.delete(`${route.kind}:${route.path}`);
    },
  },
  subprocess: {
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const buffers = { stdout: '', stderr: '' };
      child.stdout.on('data', (chunk) => {
        buffers.stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        buffers.stderr += String(chunk);
      });
      const reader = (stream) => ({
        readFrom(offset) {
          return { text: buffers[stream].slice(offset), nextOffset: buffers[stream].length, lossy: false };
        },
      });
      return {
        collected: { stdout: reader('stdout'), stderr: reader('stderr') },
        done: new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))),
        terminate() {
          child.kill();
        },
        waitForExit: () => new Promise((resolve) => child.on('close', () => resolve(true))),
      };
    },
  },
};

apply(ctx, { dataDir: TARGET.home });

let body = '';
const started = Date.now();
await routes.get('exact:/hermes/api/health').handler(
  { method: 'GET', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
  { writeHead() {}, end(text) { body = text; } },
);
const elapsed = Date.now() - started;
const payload = JSON.parse(body);

check('health answered', payload !== null && typeof payload === 'object', '');
check('the installation was found', payload.available === true, String(payload.available));
check('no error was reported', payload.error === undefined, String(payload.error));
check('the checks parsed', Array.isArray(payload.checks) && payload.checks.length > 0, `${payload?.checks?.length} check(s)`);
check(
  'every check carries name, status and detail',
  (payload.checks ?? []).every((entry) => typeof entry.check === 'string' && typeof entry.status === 'string' && typeof entry.detail === 'string'),
  '',
);
check(
  'statuses are the ones the report uses',
  (payload.checks ?? []).every((entry) => ['OK', 'WARN', 'FAIL'].includes(String(entry.status).toUpperCase())),
  [...new Set((payload.checks ?? []).map((entry) => entry.status))].join(', '),
);
const totals = (payload.summary?.ok ?? 0) + (payload.summary?.warn ?? 0) + (payload.summary?.fail ?? 0) + (payload.summary?.other ?? 0);
check('the summary counts every check', totals === (payload.checks ?? []).length, `${JSON.stringify(payload.summary)} over ${payload?.checks?.length}`);

// The whole reason this script exists: a real PowerShell wrote this text, and
// the encoding preamble is what keeps Chinese details from becoming mojibake.
const details = (payload.checks ?? []).map((entry) => entry.detail).join(' | ');
check('no replacement characters survived', !details.includes('\uFFFD'), details.slice(0, 160));

const runtimeCheck = (payload.checks ?? []).find((entry) => entry.check === 'runtime');
check('the report describes this installation', typeof runtimeCheck?.detail === 'string' && runtimeCheck.detail.includes('hermes'), String(runtimeCheck?.detail));

console.log(`\nran through ${payload.host} in ${elapsed} ms — ${JSON.stringify(payload.summary)}`);
for (const entry of payload.checks ?? []) {
  console.log(`  ${String(entry.status).padEnd(4)}  ${String(entry.check).padEnd(16)} ${entry.detail}`);
}

for (const dispose of disposers) dispose();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
