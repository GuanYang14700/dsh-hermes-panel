/**
 * Regression check for stopping a gateway the panel does NOT own.
 *
 * `verify/host.mjs` covers the lifecycle the panel starts itself. This one
 * covers the other half of `/hermes/api/stop`: a gateway launched outside DSH
 * (the user's `启动.bat` → `hermes gateway run`). That path used to end a single
 * PID with `process.kill()`, which is fragile because `hermes` is a launcher
 * that re-execs python — the first reported PID is not necessarily the process
 * actually running the gateway.
 *
 * The test starts a REAL gateway, hands the plugin a port it does not own, and
 * asserts `/hermes/api/stop` leaves no gateway behind. It never touches the
 * dashboard port (a free, unused port is configured instead), so the user's
 * live dashboard is safe.
 *
 * Usage: node verify/stop-gateway.mjs [sparePort]
 */
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { apply } from '../index.js';
import { requireTarget } from './target.mjs';

const TARGET = requireTarget();
const HERMES_EXE = TARGET.exe;
const HERMES_HOME = TARGET.home;
/** A port nothing listens on: keeps stopDashboard() away from the real 9150. */
const SPARE_PORT = Number(process.argv[2] ?? 9264);

const routes = new Map();
const children = [];
let foreign = null;

const ctx = {
  effect: (callback) => callback(),
  setTimeout: (callback) => setTimeout(callback, 0),
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

/** A response recorder satisfying the surface the route handlers use. */
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
 * @returns the parsed JSON body.
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
 * Ask the CLI, independently of the plugin, whether a gateway is running.
 * @returns true when `hermes cron status` reports a live gateway.
 */
async function gatewayRunning() {
  return new Promise((resolve) => {
    const child = spawn(HERMES_EXE, ['cron', 'status'], {
      cwd: HERMES_HOME,
      env: { ...process.env, HERMES_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      text += String(chunk);
    });
    child.on('close', () => resolve(/gateway is running/i.test(text)));
    child.on('error', () => resolve(false));
  });
}

/** Remove every process this test started. */
function cleanup() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  if (foreign && foreign.pid > 0) {
    try {
      execFileSync('taskkill', ['/PID', String(foreign.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
}

if (await gatewayRunning()) {
  console.log('REFUSING TO RUN: a gateway is already running — stop it first so the test owns the lifecycle.');
  process.exit(2);
}
if (await reachable('127.0.0.1', SPARE_PORT)) {
  console.log(`REFUSING TO RUN: spare port ${SPARE_PORT} is serving — pick another.`);
  process.exit(2);
}

console.log('--- launching a FOREIGN gateway (not through the plugin) ---');
foreign = spawn(HERMES_EXE, ['gateway', 'run'], {
  cwd: HERMES_HOME,
  env: { ...process.env, HERMES_HOME },
  stdio: 'ignore',
  windowsHide: true,
});
check('gateway launcher started', foreign.pid > 0, `pid ${foreign.pid}`);

let up = false;
for (let i = 0; i < 45; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  if (await gatewayRunning()) {
    up = true;
    break;
  }
}
check('gateway is reported running', up, up ? 'cron status says running' : 'never came up');
if (!up) {
  cleanup();
  process.exit(1);
}

console.log('--- activating plugin against a gateway it does not own ---');
apply(ctx, {
  dataDir: HERMES_HOME,
  // Deliberately a port nothing serves: this test is about the gateway path.
  dashboardPort: SPARE_PORT,
  bindHost: '127.0.0.1',
  manageGateway: true,
  autostart: false,
});

const refreshed = await call('/hermes/api/refresh', 'POST');
check('refresh reports the gateway running', refreshed.gateway.status === 'running', JSON.stringify(refreshed.gateway));
check('refresh reports at least one gateway PID', (refreshed.gateway.pids ?? []).length > 0, `pids=${JSON.stringify(refreshed.gateway.pids)}`);
check('status does NOT claim ownership', refreshed.gateway.owned === false, `owned=${refreshed.gateway.owned}`);

console.log('--- POST /hermes/api/stop (the gateway half) ---');
const started = Date.now();
const stopped = await call('/hermes/api/stop', 'POST');
console.log(`     (stop took ${Date.now() - started}ms)`);
check('stop reports the gateway stopped', stopped.gateway.status === 'stopped', JSON.stringify(stopped.gateway));
const stillRunning = await gatewayRunning();
check('stop really ended the gateway (independent CLI check)', stillRunning === false, stillRunning ? 'cron status still says running' : 'gone');

cleanup();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
