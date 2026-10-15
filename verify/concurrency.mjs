/**
 * Lifecycle serialization regression.
 *
 * The panel disables its buttons while a command is in flight, but that is a
 * convenience, not a lock: two simultaneous `POST /hermes/api/start` used to
 * spawn two dashboards and two gateways. `serialize()` coalesces them onto the
 * in-flight run, and this proves it against a stub subprocess.
 *
 * The gateway is switched off and the dashboard port is left empty, so the run
 * finishes quickly (the start times out waiting for a port that never opens)
 * and nothing real is started.
 *
 * Usage: node verify/concurrency.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';
import { makeTempDir } from './tmp.mjs';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

// ---- throwaway installation ------------------------------------------------

const root = makeTempDir('hermes-panel-concurrency-');
const home = join(root, 'home');
mkdirSync(join(home, 'official-web'), { recursive: true });
const exe = join(root, 'hermes.exe');
writeFileSync(exe, '');
writeFileSync(
  join(home, 'official-web', '.env'),
  [`HERMES_HOME=${home}`, `HERMES_EXE=${exe}`, 'DASHBOARD_PORT=9477', ''].join('\n'),
);

// ---- plugin under test -----------------------------------------------------

const routes = new Map();
const disposers = [];
/** Every argv the plugin tried to run. */
const spawnedArgv = [];

/** A child handle shaped like the subprocess service's, that never settles. */
function fakeHandle() {
  return {
    done: new Promise(() => {}),
    collected: {
      stdout: { readFrom: () => undefined },
      stderr: { readFrom: () => undefined },
    },
    terminate() {},
    waitForExit: () => new Promise(() => {}),
  };
}

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
      spawnedArgv.push(spec.argv.join(' '));
      return fakeHandle();
    },
  },
};

apply(ctx, {
  dataDir: home,
  runtimeDir: home,
  manageGateway: false,
  dashboardPort: 9477,
});

let lastStatus = 0;
const request = async (path, method = 'POST') => {
  const route = routes.get(`exact:${path}`);
  await route.handler(
    { method, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
    {
      writeHead(code) {
        lastStatus = code;
      },
      end() {},
    },
  );
};

const before = spawnedArgv.length;
await Promise.all([request('/hermes/api/start'), request('/hermes/api/start'), request('/hermes/api/start')]);

const dashboardSpawns = spawnedArgv.filter((argv) => argv.includes(' dashboard ')).length;
check('three concurrent starts answered 2xx', lastStatus === 200, `HTTP ${lastStatus}`);
check('three concurrent starts spawned exactly one dashboard', dashboardSpawns === 1, `${dashboardSpawns} spawn(s): ${spawnedArgv.slice(before).join(' ; ')}`);
check('no gateway was spawned (manageGateway off)', !spawnedArgv.some((argv) => argv.includes('gateway run')), spawnedArgv.join(' ; '));

// A second, later start must be allowed to try again — the lock is not sticky.
lastStatus = 0;
await request('/hermes/api/start');
const afterSecond = spawnedArgv.filter((argv) => argv.includes(' dashboard ')).length;
check('the lock releases after the run settles', afterSecond === 2, `${afterSecond} dashboard spawn(s)`);

for (const dispose of disposers) dispose();
rmSync(root, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
if (failures === 0) {
  console.log(`(package root: ${PACKAGE_DIR})`);
}
process.exit(failures === 0 ? 0 : 1);
