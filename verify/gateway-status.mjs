/**
 * Gateway-status regression for `POST /hermes/api/refresh`.
 *
 * The probe reads the gateway's own files instead of asking `hermes cron status`:
 * `<home>/gateway_state.json` carries the PID, the gateway state and the platform
 * states, and `<home>/state/gateway.heartbeat` is touched every ~30s, so its mtime
 * is the age of the last tick.
 *
 * The CLI stopped being the source of truth because on Windows 11 its process
 * discovery (`wmic` / `Get-CimInstance Win32_Process`) comes back empty when spawned
 * from a DSH-hosted shell — on 2026-10-16 two gateways were live while `cron status`
 * said none was. The trap this file guards is the one that survived that change: a
 * missing, stale or unreadable heartbeat must not be flattened into `stopped` while
 * the process is alive, because the panel would then offer to start something that
 * is already running.
 *
 * Usage: node verify/gateway-status.mjs
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

/** A PID that is certainly not running: Windows caps the real range well below this. */
const DEAD_PID = 99999999;

/**
 * Stand the plugin up over a fixture home and answer one `refresh`.
 *
 * @param options - what to place inside the home:
 *   `state` is written to `gateway_state.json` verbatim (`undefined` writes nothing,
 *   a string is written as-is so a torn file can be simulated);
 *   `heartbeatSecondsAgo` writes `state/gateway.heartbeat` and backdates its mtime.
 * @returns the refresh call, the spawn log, and a cleanup function.
 */
function harness(options = {}) {
  const root = makeTempDir('hermes-panel-gateway-');
  const home = join(root, 'home');
  mkdirSync(join(home, 'official-web'), { recursive: true });
  mkdirSync(join(home, 'state'), { recursive: true });
  const exe = join(root, 'hermes.exe');
  writeFileSync(exe, '');
  writeFileSync(
    join(home, 'official-web', '.env'),
    [`HERMES_HOME=${home}`, `HERMES_EXE=${exe}`, 'DASHBOARD_PORT=9150', ''].join('\n'),
  );

  if (options.state !== undefined) {
    writeFileSync(
      join(home, 'gateway_state.json'),
      typeof options.state === 'string' ? options.state : JSON.stringify(options.state),
    );
  }
  if (typeof options.heartbeatSecondsAgo === 'number') {
    const heartbeat = join(home, 'state', 'gateway.heartbeat');
    writeFileSync(heartbeat, '');
    const at = new Date(Date.now() - options.heartbeatSecondsAgo * 1000);
    utimesSync(heartbeat, at, at);
  }

  const routes = new Map();
  const disposers = [];
  const spawnSpecs = [];

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
        spawnSpecs.push(spec);
        const reader = (text) => ({ readFrom: (offset) => ({ text: text.slice(offset), nextOffset: text.length }) });
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: { stdout: reader(''), stderr: reader('') },
          terminate() {},
          waitForExit: () => Promise.resolve(),
        };
      },
    },
  };

  apply(ctx, { dataDir: home, manageGateway: true });

  const refresh = async () => {
    const route = routes.get('exact:/hermes/api/refresh');
    let body = '';
    await route.handler(
      { method: 'POST', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
      { writeHead() {}, end(text) { body = text; } },
    );
    return JSON.parse(body);
  };

  return {
    home,
    refresh,
    spawnSpecs,
    cleanup() {
      for (const dispose of disposers) dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---- a healthy gateway ------------------------------------------------------

{
  const h = harness({
    state: { pid: process.pid, gateway_state: 'running', platforms: { qq: { state: 'running' } } },
    heartbeatSecondsAgo: 5,
  });
  const { gateway } = await h.refresh();
  check('a fresh heartbeat with a live PID is running', gateway.status === 'running', gateway.status);
  check('and reports healthy', gateway.detail === 'healthy', String(gateway.detail));
  check('with no warning', gateway.warning === null, String(gateway.warning));
  check('the PID is captured', gateway.pid === process.pid, String(gateway.pid));
  check('the heartbeat age is reported', gateway.heartbeatAgeSeconds !== null && gateway.heartbeatAgeSeconds <= 10, String(gateway.heartbeatAgeSeconds));
  check('the source is named', gateway.source === 'gateway_state.json', String(gateway.source));
  check('platform states ride along', (gateway.platforms ?? []).includes('qq=running'), JSON.stringify(gateway.platforms));
  check('the probe spawns no CLI', h.spawnSpecs.length === 0, `${h.spawnSpecs.length} spawn(s)`);
  h.cleanup();
}

// ---- a stale heartbeat ------------------------------------------------------

{
  const h = harness({ state: { pid: process.pid, gateway_state: 'running' }, heartbeatSecondsAgo: 4211 });
  const { gateway } = await h.refresh();
  check('a stale heartbeat is not running', gateway.status !== 'running', gateway.status);
  check('a live PID with no fresh heartbeat is starting, not stopped', gateway.status === 'starting', gateway.status);
  check('the age is the measured one', gateway.heartbeatAgeSeconds >= 4211, String(gateway.heartbeatAgeSeconds));
  check('the PID survives', gateway.pid === process.pid, String(gateway.pid));
  h.cleanup();
}

// ---- a heartbeat outliving its process -------------------------------------

{
  const h = harness({ state: { pid: DEAD_PID, gateway_state: 'running' }, heartbeatSecondsAgo: 10 });
  const { gateway } = await h.refresh();
  check('a dead PID is stopped', gateway.status === 'stopped', gateway.status);
  check('the dead PID is still reported for diagnosis', gateway.pid === DEAD_PID, String(gateway.pid));
  check('the warning says the process is gone', String(gateway.warning).includes('已经不在了'), String(gateway.warning));
  check('the warning keeps the age', String(gateway.warning).includes('10s') || String(gateway.warning).includes('9s'), String(gateway.warning));
  h.cleanup();
}

// ---- a gateway that says it failed ----------------------------------------

{
  const h = harness({ state: { pid: process.pid, gateway_state: 'startup_failed' }, heartbeatSecondsAgo: 5 });
  const { gateway } = await h.refresh();
  check('a failed gateway is not reported as running', gateway.status !== 'running', gateway.status);
  check('it is not silently dropped either', gateway.pid === process.pid, String(gateway.pid));
  h.cleanup();
}

// ---- no files at all -------------------------------------------------------

{
  const h = harness({});
  const { gateway, discovery } = await h.refresh();
  check('no state files still finds the installation', discovery.found === true, String(discovery.found));
  check('no state files means stopped', gateway.status === 'stopped', gateway.status);
  check('with no PID to show', gateway.pid === null && gateway.pids.length === 0, JSON.stringify(gateway.pids));
  check('and no invented heartbeat age', gateway.heartbeatAgeSeconds === null, String(gateway.heartbeatAgeSeconds));
  h.cleanup();
}

// ---- a torn state file -----------------------------------------------------

{
  const h = harness({ state: '{"pid": 14168,', heartbeatSecondsAgo: 5 });
  const { gateway } = await h.refresh();
  check('a torn state file does not throw the refresh', gateway != null, '');
  check('and reports no PID rather than guessing', gateway.pid === null, String(gateway.pid));
  check('with the heartbeat age still read', gateway.heartbeatAgeSeconds !== null, String(gateway.heartbeatAgeSeconds));
  h.cleanup();
}

// ---- a PID with no heartbeat file -----------------------------------------

{
  const h = harness({ state: { pid: process.pid, gateway_state: 'running' } });
  const { gateway } = await h.refresh();
  check('a missing heartbeat file is not a fresh heartbeat', gateway.heartbeatAgeSeconds === null, String(gateway.heartbeatAgeSeconds));
  check('a live PID with no heartbeat is starting', gateway.status === 'starting', gateway.status);
  h.cleanup();
}

// ---- the refresh route stays side-effect free ------------------------------

{
  const h = harness({});
  const first = await h.refresh();
  const second = await h.refresh();
  check('refresh on a home with no gateway never spawns', h.spawnSpecs.length === 0, `${h.spawnSpecs.length} spawn(s)`);
  check('the answer is stable', second.gateway?.status === first.gateway?.status, `${first.gateway?.status} vs ${second.gateway?.status}`);
  h.cleanup();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
if (failures === 0) {
  console.log(`(package root: ${PACKAGE_DIR})`);
}
process.exit(failures === 0 ? 0 : 1);
