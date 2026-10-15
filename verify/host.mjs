/**
 * Host-half verification for `@local/dsh-hermes-panel` (native Hermes target).
 *
 * Runs the plugin's REAL `apply` against a stub Cordis context whose
 * `subprocess` service is backed by `node:child_process`, then drives the
 * `/hermes/api/*` handlers and fetches the dashboard for real.
 *
 * `manageGateway` is forced OFF so this test can never stop the user's live
 * messaging gateway/cron scheduler.
 *
 * Usage: node verify/host.mjs [port]   (default 9150; pass a spare port while
 *        the real dashboard is running)
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { apply } from '../index.js';
import { requireTarget } from './target.mjs';

const TARGET = requireTarget();
const HERMES_EXE = TARGET.exe;
const HERMES_HOME = TARGET.home;
/**
 * Port under test. Defaults to the real 9150, but the dashboard the user
 * actually runs usually occupies that one — pass a spare port
 * (`node verify/host.mjs 9266`) to exercise the full lifecycle while it is up.
 * 9151–9250 are Windows-reserved and cannot be bound.
 */
const DASHBOARD_PORT = Number(process.argv[2] ?? process.env.HERMES_PANEL_TEST_PORT ?? 9150);

/** @type {Map<string, {kind: string, path: string, handler: Function}>} */
const routes = new Map();
const children = [];

/** Minimal `webServer` + `subprocess` stub shaped like the real contracts. */
const ctx = {
  effect(callback) {
    return callback();
  },
  webServer: {
    register(route) {
      const key = `${route.kind}:${route.path}`;
      if (routes.has(key)) throw new Error(`duplicate route ${key}`);
      routes.set(key, route);
      return () => routes.delete(key);
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
      children.push(child);
      const buffers = { stdout: '', stderr: '' };
      child.stdout.on('data', (chunk) => {
        buffers.stdout += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        buffers.stderr += String(chunk);
      });
      const reader = (stream) => ({
        readFrom(offset) {
          const text = buffers[stream].slice(offset);
          return { text, nextOffset: buffers[stream].length, lossy: false };
        },
      });
      return {
        stdin: undefined,
        stdout: child.stdout,
        stderr: child.stderr,
        control: undefined,
        collected: { stdout: reader('stdout'), stderr: reader('stderr') },
        done: new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))),
        terminate() {
          child.kill();
        },
        async waitForExit() {
          return new Promise((resolve) => child.on('close', () => resolve(true)));
        },
      };
    },
  },
};

/** A response recorder satisfying the `http.ServerResponse` surface used here. */
function recorder() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status;
      return this;
    },
    end(text) {
      this.body = text ?? '';
      return this;
    },
  };
}

/**
 * Invoke one registered route.
 * @param path - route path.
 * @param method - HTTP method.
 * @returns the recorded response.
 */
async function call(path, method) {
  const route = routes.get(`exact:${path}`);
  if (!route) throw new Error(`route not registered: ${path}`);
  const res = recorder();
  await route.handler({ method, url: path, headers: {} }, res);
  return JSON.parse(res.body);
}

/**
 * Test whether a TCP endpoint accepts a connection.
 * @param host - target host.
 * @param port - target port.
 * @param timeoutMs - per-attempt budget.
 * @returns true when accepted.
 */
function reachable(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

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

console.log('--- preconditions ---');
const preexisting = await reachable('127.0.0.1', DASHBOARD_PORT);
if (preexisting) {
  console.log(`REFUSING TO RUN: port ${DASHBOARD_PORT} is already serving — stop it first so the test owns the lifecycle.`);
  process.exit(2);
}
check('dashboard port is free before the test', true, `${DASHBOARD_PORT} free`);

console.log('--- activating plugin with stub context ---');
apply(ctx, {
  dataDir: HERMES_HOME,
  dashboardPort: DASHBOARD_PORT,
  bindHost: '127.0.0.1',
  // Critical: this test must never stop the user's live gateway.
  manageGateway: false,
  autostart: false,
});

check('registers 5 routes', routes.size === 5, [...routes.keys()].join(', '));

const before = await call('/hermes/api/status', 'GET');
check('status starts stopped', before.dashboard.status === 'stopped', JSON.stringify(before.dashboard));

console.log('--- POST /hermes/api/start ---');
const started = await call('/hermes/api/start', 'POST');
check('start reports the dashboard running', started.dashboard.status === 'running', started.dashboard.error ?? '');
check(
  'start exposes the native dashboard url',
  started.url === `http://127.0.0.1:${DASHBOARD_PORT}/`,
  String(started.url),
);
if (started.dashboard.status !== 'running') {
  console.log('startup failed; skipping dashboard assertions');
  for (const child of children) child.kill();
  process.exit(1);
}

console.log('--- fetching the native dashboard ---');
const page = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}/`);
const html = await page.text();
check('dashboard responds', page.status === 200, `HTTP ${page.status}`);
check('serves the NATIVE Hermes dashboard', /Hermes Agent\s*-\s*Dashboard/i.test(html), html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '(no title)');
check('no X-Frame-Options (frameable as-is)', page.headers.get('x-frame-options') === null, String(page.headers.get('x-frame-options')));
const csp = page.headers.get('content-security-policy');
check('no Content-Security-Policy (frameable as-is)', csp === null, String(csp));

const assetMatch = html.match(/(?:src|href)="(\/assets\/[^"]+)"/);
if (assetMatch) {
  const asset = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}${assetMatch[1]}`);
  check(`serves its own asset ${assetMatch[1]}`, asset.ok, `HTTP ${asset.status}`);
} else {
  check('finds a root-absolute asset in the shell', false, 'no /assets/ reference');
}

console.log('--- loopback-only binding ---');
const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;
if (lanAddress) {
  const leaked = await reachable(lanAddress, DASHBOARD_PORT);
  check(
    'dashboard is NOT reachable on the LAN address',
    leaked === false,
    `${lanAddress}:${DASHBOARD_PORT} ${leaked ? 'REACHABLE — leaked to the network' : 'refused'}`,
  );
} else {
  check('found a LAN address to test against', false, 'no non-internal IPv4 interface');
}

console.log('--- POST /hermes/api/refresh (gateway management disabled) ---');
const refreshed = await call('/hermes/api/refresh', 'POST');
check('refresh returns a snapshot', typeof refreshed.gateway === 'object', JSON.stringify(refreshed.gateway));

console.log('--- POST /hermes/api/stop ---');
const stopped = await call('/hermes/api/stop', 'POST');
check('stop reports the dashboard stopped', stopped.dashboard.status === 'stopped', JSON.stringify(stopped.dashboard));
const orphan = await reachable('127.0.0.1', DASHBOARD_PORT);
check('stop really closed the port (no orphan left behind)', orphan === false, orphan ? 'still listening — orphaned' : 'port closed');

for (const child of children) {
  if (!child.killed) child.kill();
}
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
