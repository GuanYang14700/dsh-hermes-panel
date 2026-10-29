/**
 * Regression check for stopping a dashboard the panel does NOT own.
 *
 * `verify/host.mjs` only covers the lifecycle the panel starts itself, where
 * `terminate()` on the tracked child handle is enough. The failure that
 * prompted this test is the other case: the dashboard was launched outside
 * DSH (`启动.bat` → `official-web\start.ps1`, or a previous
 * DSH process), so the panel has no handle, and the historical fallback
 * `hermes dashboard --stop` is a no-op on Windows without `wmic`.
 *
 * This test therefore launches a REAL dashboard on a spare port, hands the
 * plugin a port it does not own, and asserts that POST /hermes/api/stop still
 * frees the port and leaves no process behind. It never touches 9150.
 *
 * Usage: node verify/stop-foreign.mjs [port]
 */
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { apply } from '../index.js';
import { requireTarget } from './target.mjs';

const TARGET = requireTarget();
const HERMES_EXE = TARGET.exe;
const HERMES_HOME = TARGET.home;
const PORT = Number(process.argv[2] ?? 9260);

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
function reachable(host, port, timeoutMs = 1500) {
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

/**
 * Remove every process still holding the test port.
 * @param launcherPid - the foreign launcher, if it was started.
 */
function cleanup(launcherPid) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  if (launcherPid > 0) {
    try {
      execFileSync('taskkill', ['/PID', String(launcherPid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
}

if (await reachable('127.0.0.1', PORT)) {
  console.log(`REFUSING TO RUN: port ${PORT} is already serving — pick a free port.`);
  process.exit(2);
}

console.log(`--- launching a FOREIGN dashboard on ${PORT} (not through the plugin) ---`);
const foreign = spawn(
  HERMES_EXE,
  ['dashboard', '--tui', '--host', '127.0.0.1', '--port', String(PORT), '--no-open', '--skip-build'],
  {
    cwd: HERMES_HOME,
    env: { ...process.env, HERMES_HOME, HERMES_DASHBOARD_TUI: '1' },
    stdio: 'ignore',
    windowsHide: true,
  },
);
check('foreign dashboard launcher started', foreign.pid > 0, `pid ${foreign.pid}`);

let up = false;
for (let i = 0; i < 60; i += 1) {
  if (await reachable('127.0.0.1', PORT)) {
    up = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
check(`foreign dashboard is serving on ${PORT}`, up, up ? 'listening' : 'never came up');
if (!up) {
  cleanup(foreign.pid);
  process.exit(1);
}

console.log('--- activating plugin against a port it does not own ---');
apply(ctx, {
  dataDir: HERMES_HOME,
  dashboardPort: PORT,
  bindHost: '127.0.0.1',
  // Critical: this test must never stop the user's live gateway.
  manageGateway: false,
  autostart: false,
});

const before = await call('/hermes/api/status', 'GET');
check('status sees the dashboard running', before.dashboard.status === 'running', JSON.stringify(before.dashboard));
check('status does NOT claim ownership', before.dashboard.owned === false, `owned=${before.dashboard.owned}`);

console.log('--- POST /hermes/api/stop (the case that used to be a no-op) ---');
const started = Date.now();
const stopped = await call('/hermes/api/stop', 'POST');
const took = Date.now() - started;
check('stop reports the dashboard stopped', stopped.dashboard.status === 'stopped', JSON.stringify(stopped.dashboard));
const orphan = await reachable('127.0.0.1', PORT);
check('stop really closed the port (no orphan left behind)', orphan === false, orphan ? 'still listening — orphaned' : 'port closed');
console.log(`     (stop took ${took}ms)`);

cleanup(foreign.pid);
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
