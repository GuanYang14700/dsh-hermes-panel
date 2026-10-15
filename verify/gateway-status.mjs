/**
 * Gateway-status regression for `POST /hermes/api/refresh`.
 *
 * `hermes cron status` prints one of a fixed set of sentences, and each says
 * something different about whether scheduled jobs will actually fire. The trap
 * this file guards is the one an earlier revision fell into: it asked only "does
 * the output say the gateway is running?", and answered **stopped** when the
 * answer was no. Any rewording of the CLI — or a stdout code page that mangles
 * it — then turns a live gateway into a stopped one, and the panel offers to
 * start something already running.
 *
 * The fixtures are the sentences `hermes_cli/cron.py` actually writes, including
 * the `✓`/`⚠`/em-dash decoration that the parser deliberately does not match, so
 * that it depends on wording rather than on the child's encoding.
 *
 * Usage: node verify/gateway-status.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** What the CLI prints, verbatim, for each state it can be in. */
const FIXTURES = {
  healthy: [
    '✓ Gateway is running — cron jobs will fire automatically',
    '  PID: 14168',
    '  Ticker heartbeat: 3s ago',
    '',
    '  No active jobs',
    '',
  ].join('\n'),
  stalled: [
    '⚠ Gateway is running but the cron ticker looks STALLED — no heartbeat for 4211s (expected every ~60s).',
    '  PID: 14168',
    '  Cron jobs may NOT be firing. Restart: hermes gateway restart',
    '',
  ].join('\n'),
  failing: [
    '⚠ Gateway and cron ticker are running, but no tick has succeeded in 3200s — ticks may be failing.',
    '  PID: 14168',
    "  Check the gateway log for 'Cron tick error'.",
    '',
  ].join('\n'),
  stopped: [
    '✗ Gateway is not running — cron jobs will NOT fire',
    '',
    '  To enable automatic execution:',
    '    hermes gateway install    # Install as a user service',
    '',
  ].join('\n'),
  external: [
    '✓ Cron provider: webhook — jobs fire via the managed scheduler, not the in-process ticker.',
    '  (No ticker heartbeat is expected for an external provider; due jobs are delivered by an authenticated webhook.)',
    '',
  ].join('\n'),
  multiPid: [
    '✓ Gateway is running — cron jobs will fire automatically',
    '  PID: 14168, 25512',
    '',
  ].join('\n'),
};

/**
 * Stand the plugin up over a fixture home that answers `refresh` with one report.
 * @param output - what `hermes cron status` is stubbed to print.
 * @param options - `throwOnStatus` makes the child fail instead.
 * @returns the refresh call and the spawn log.
 */
function harness(output, options = {}) {
  const root = makeTempDir('hermes-panel-gateway-');
  const home = join(root, 'home');
  mkdirSync(join(home, 'official-web'), { recursive: true });
  const exe = join(root, 'hermes.exe');
  writeFileSync(exe, '');
  writeFileSync(
    join(home, 'official-web', '.env'),
    [`HERMES_HOME=${home}`, `HERMES_EXE=${exe}`, 'DASHBOARD_PORT=9150', ''].join('\n'),
  );

  const routes = new Map();
  const disposers = [];
  const argvSeen = [];
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
        argvSeen.push(spec.argv);
        spawnSpecs.push(spec);
        const reader = (text) => ({ readFrom: (offset) => ({ text: text.slice(offset), nextOffset: text.length }) });
        if (options.throwOnStatus === true && spec.argv.includes('status')) {
          return {
            done: Promise.reject(new Error('spawn ENOENT')),
            collected: { stdout: reader(''), stderr: reader('') },
            terminate() {},
            waitForExit: () => Promise.resolve(),
          };
        }
        return {
          done: Promise.resolve({ exitCode: 0 }),
          collected: { stdout: reader(output), stderr: reader('') },
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
    refresh,
    argvSeen,
    spawnSpecs,
    cleanup() {
      for (const dispose of disposers) dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---- each sentence the CLI can print ---------------------------------------

{
  const h = harness(FIXTURES.healthy);
  const { gateway } = await h.refresh();
  check('a healthy gateway is running', gateway.status === 'running', gateway.status);
  check('and reports healthy', gateway.detail === 'healthy', String(gateway.detail));
  check('with no warning', gateway.warning === null, String(gateway.warning));
  check('the PID is captured', gateway.pid === 14168, String(gateway.pid));

  // The status sentences carry `✓`/`⚠`/an em dash; the parser must not depend on
  // them, and pinning UTF-8 keeps the child's stdout stable in the first place.
  const statusSpec = h.spawnSpecs.find((spec) => spec.argv.includes('status'));
  check('the CLI is spawned with UTF-8 output pinned', statusSpec?.env?.PYTHONIOENCODING === 'utf-8', String(statusSpec?.env?.PYTHONIOENCODING));
  h.cleanup();
}

{
  const h = harness(FIXTURES.stalled);
  const { gateway } = await h.refresh();
  check('a stalled ticker still counts as running', gateway.status === 'running', gateway.status);
  check('and is flagged as stalled', gateway.detail === 'stalled', String(gateway.detail));
  check('the warning says the heartbeat stopped', String(gateway.warning).includes('心跳已停'), String(gateway.warning));
  check('the warning keeps the measured age', String(gateway.warning).includes('4211'), String(gateway.warning));
  check('the PID survives', gateway.pid === 14168, String(gateway.pid));
  h.cleanup();
}

{
  const h = harness(FIXTURES.failing);
  const { gateway } = await h.refresh();
  check('a failing ticker still counts as running', gateway.status === 'running', gateway.status);
  check('and is flagged as failing', gateway.detail === 'failing', String(gateway.detail));
  check('the warning says no tick succeeded', String(gateway.warning).includes('tick 成功'), String(gateway.warning));
  check('the warning keeps the measured age', String(gateway.warning).includes('3200'), String(gateway.warning));
  h.cleanup();
}

{
  const h = harness(FIXTURES.stopped);
  const { gateway } = await h.refresh();
  check('only the sentence that denies it reports stopped', gateway.status === 'stopped', gateway.status);
  check('a stopped gateway carries no PID', gateway.pid === null && gateway.pids.length === 0, JSON.stringify(gateway.pids));
  h.cleanup();
}

{
  const h = harness(FIXTURES.external);
  const { gateway } = await h.refresh();
  check('an external provider counts as running', gateway.status === 'running', gateway.status);
  check('and is named as such', gateway.detail === 'external-provider', String(gateway.detail));
  check('it reports no PID, because it has none', gateway.pids.length === 0, JSON.stringify(gateway.pids));
  h.cleanup();
}

{
  const h = harness(FIXTURES.multiPid);
  const { gateway } = await h.refresh();
  check('every PID on the line is kept', gateway.pids.join(',') === '14168,25512', gateway.pids.join(','));
  check('the first PID is the primary one', gateway.pid === 14168, String(gateway.pid));
  h.cleanup();
}

// ---- the regression this file exists for -----------------------------------

{
  const unknown = 'Something the parser has never seen before.\n';
  const h = harness(unknown);
  const { gateway } = await h.refresh();
  check('an unrecognized report is NOT reported as stopped', gateway.status === 'unknown', gateway.status);
  check('it is named as unparsed', gateway.detail === 'unparsed', String(gateway.detail));
  check('the raw tail is kept for diagnosis', typeof gateway.raw === 'string' && gateway.raw.includes('never seen before'), String(gateway.raw).slice(0, 40));
  h.cleanup();
}

{
  const h = harness('', { throwOnStatus: true });
  const { gateway } = await h.refresh();
  check('a CLI that cannot run is unknown, not stopped', gateway.status === 'unknown', gateway.status);
  check('and says the probe failed', gateway.detail === 'probe-failed', String(gateway.detail));
  check('with the error recorded', typeof gateway.error === 'string' && gateway.error.length > 0, String(gateway.error));
  h.cleanup();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
if (failures === 0) {
  console.log(`(package root: ${PACKAGE_DIR})`);
}
process.exit(failures === 0 ? 0 : 1);
