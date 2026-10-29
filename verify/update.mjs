/**
 * Upgrade regression for the three `/hermes/api/update*` routes.
 *
 * The upgrade is a background job, not a request: `update.ps1 -Apply` runs
 * `pip install --upgrade` against the live virtual environment and can take
 * minutes, so the route starts it and the panel polls. Three properties are
 * worth pinning down, and none of them are visible in a browser:
 *
 *  1. the job commits to one PowerShell host and runs `update.ps1 -Apply`, with
 *     the same UTF-8 preamble the health route uses;
 *  2. starting is idempotent — a second press must not launch a second pip;
 *  3. the child's output is captured for the panel, because that output is where
 *     `update.ps1` prints its rollback command.
 *
 * A real `-Apply` is deliberately NOT part of any test: it would mutate this
 * machine's Python environment. The stop-before-upgrade ordering is likewise
 * untested here, because it needs a live dashboard and the stop path terminates
 * real processes — it is a plain sequence in `startUpdateApply`.
 *
 * Usage: node verify/update.mjs
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

/** What `check-update.ps1` prints, as the real one does. */
const CHECK_TEXT = [
  '[update] runtime   : /venv/python.exe',
  '[update] installed : Hermes Agent v0.19.0 (2026.7.20)',
  '[update] latest    : 0.20.0   requires_python: <3.14,>=3.11',
  '[update] report only - re-run with -Apply to upgrade',
].join('\n');

/** A promise a test resolves by hand. */
function deferred() {
  let settle;
  const promise = new Promise((resolvePromise) => {
    settle = resolvePromise;
  });
  return { promise, settle };
}

/** Build a child handle shaped like the subprocess service's. */
function handleWith(buffer, done) {
  const reader = (key) => ({
    readFrom: (offset) => ({ text: buffer[key].slice(offset), nextOffset: buffer[key].length }),
  });
  return {
    done,
    collected: { stdout: reader('stdout'), stderr: reader('stderr') },
    terminate() {},
    waitForExit: () => Promise.resolve(),
  };
}

/**
 * Stand the plugin up over a throwaway installation with a controllable child.
 * @returns the routes, the spawn log, and the pending upgrade child.
 */
function harness() {
  const root = makeTempDir('hermes-panel-update-');
  const home = join(root, 'home');
  mkdirSync(join(home, 'official-web'), { recursive: true });
  const exe = join(root, 'hermes.exe');
  writeFileSync(exe, '');
  writeFileSync(
    join(home, 'official-web', '.env'),
    [`HERMES_HOME=${home}`, `HERMES_EXE=${exe}`, 'DASHBOARD_PORT=9150', ''].join('\n'),
  );
  for (const name of ['check-update.ps1', 'update.ps1', 'doctor.ps1']) {
    writeFileSync(join(home, 'official-web', name), '# fixture\n');
  }

  const routes = new Map();
  const disposers = [];
  const argvSeen = [];
  const state = { pending: null, buffer: { stdout: '', stderr: '' } };

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
        const command = String(spec.argv[3] ?? '');
        if (command === 'exit 0') return handleWith(state.buffer, Promise.resolve({ exitCode: 0 }));
        if (command.includes('check-update.ps1')) {
          return handleWith({ stdout: CHECK_TEXT, stderr: '' }, Promise.resolve({ exitCode: 0 }));
        }
        // The upgrade: a child the test decides the fate of.
        state.pending = deferred();
        return handleWith(state.buffer, state.pending.promise);
      },
    },
  };

  apply(ctx, { dataDir: home });

  const call = async (path, method = 'GET') => {
    const route = routes.get(`exact:${path}`);
    if (route === undefined) throw new Error(`route ${path} is not registered`);
    let body = '';
    const res = {
      statusCode: 0,
      writeHead(code) {
        this.statusCode = code;
      },
      end(text) {
        body = text;
      },
    };
    await route.handler(
      { method, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
      res,
    );
    return { status: res.statusCode, body: body === '' ? null : JSON.parse(body) };
  };

  return {
    routes,
    argvSeen,
    state,
    call,
    cleanup() {
      for (const dispose of disposers) dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the version report ----------------------------------------------------

{
  const h = harness();
  check('the update routes are registered', ['/hermes/api/update', '/hermes/api/update/check', '/hermes/api/update/apply'].every((path) => h.routes.has(`exact:${path}`)));

  const initial = await h.call('/hermes/api/update');
  check('before anything runs the job is idle', initial.body?.update?.phase === 'idle', String(initial.body?.update?.phase));
  check('and no report is held yet', initial.body?.report === null, JSON.stringify(initial.body?.report));

  const checked = await h.call('/hermes/api/update/check', 'POST');
  check('the version check answers 200', checked.status === 200, `HTTP ${checked.status}`);
  check('the version check reports success', checked.body?.available === true && checked.body?.exitCode === 0, JSON.stringify({ a: checked.body?.available, c: checked.body?.exitCode }));
  check('the version check returns the script text', typeof checked.body?.text === 'string' && checked.body.text.includes('installed :'), String(checked.body?.text).slice(0, 60));
  const checkArgv = h.argvSeen.find((argv) => String(argv[3] ?? '').includes('check-update.ps1')) ?? [];
  check('the version check runs check-update.ps1', String(checkArgv[3] ?? '').endsWith('check-update.ps1\''), String(checkArgv[3] ?? '').slice(-40));

  const after = await h.call('/hermes/api/update');
  check('the report is held for the panel', typeof after.body?.report === 'string' && after.body.report.includes('0.20.0'), String(after.body?.report).slice(0, 40));
  h.cleanup();
}

// ---- the upgrade job -------------------------------------------------------

{
  const h = harness();
  const spawned = () => h.argvSeen.filter((argv) => String(argv[3] ?? '').includes('update.ps1')).length;

  const started = await h.call('/hermes/api/update/apply', 'POST');
  check('starting the upgrade answers 200', started.status === 200, `HTTP ${started.status}`);
  check('the job reports itself running', started.body?.update?.phase === 'running', String(started.body?.update?.phase));
  check('nothing was running, so nothing was stopped', started.body?.update?.wasRunning === false, String(started.body?.update?.wasRunning));

  const applyArgv = h.argvSeen.find((argv) => String(argv[3] ?? '').includes('update.ps1')) ?? [];
  const command = String(applyArgv[3] ?? '');
  check('the job runs update.ps1 -Apply', command.includes('update.ps1') && command.endsWith('-Apply'), command.slice(-30));
  check('the job pins UTF-8 output like every other maintenance call', command.startsWith('[Console]::OutputEncoding'), command.slice(0, 50));

  const again = await h.call('/hermes/api/update/apply', 'POST');
  check('a second press does not launch a second pip', spawned() === 1, `${spawned()} spawn(s)`);
  check('the second press reports the job already in flight', again.body?.update?.phase === 'running', String(again.body?.update?.phase));

  // One pump tick picks the child's output up; that output is where update.ps1
  // prints the rollback command, so the panel has to receive it.
  h.state.buffer.stdout = '[update] upgrading ...\n[update] ERR: pip 升级失败（退出码 2）\n[update] rollback: robocopy "snap" "home" /E\n';
  await tick(600);
  const running = await h.call('/hermes/api/update');
  const output = running.body?.update?.output ?? [];
  check('the job captures the child output', output.some((line) => line.includes('rollback:')), output.slice(-2).join(' | '));

  h.state.pending.settle({ exitCode: 2 });
  await tick();
  const failed = await h.call('/hermes/api/update');
  check('a non-zero exit ends the job as an error', failed.body?.update?.phase === 'error', String(failed.body?.update?.phase));
  check('the exit code is reported', failed.body?.update?.exitCode === 2, String(failed.body?.update?.exitCode));
  check('the job records when it finished', typeof failed.body?.update?.finishedAt === 'number', String(failed.body?.update?.finishedAt));

  // The lock is not sticky: a retry after a failure must be allowed.
  const retry = await h.call('/hermes/api/update/apply', 'POST');
  check('a failed upgrade can be retried', spawned() === 2 && retry.body?.update?.phase === 'running', `${spawned()} spawn(s), ${retry.body?.update?.phase}`);
  // Let the pump pick the retry's stream up before the child settles: once the
  // job ends there is no handle left to drain, so anything not captured by then
  // is gone.
  await tick(600);
  h.state.pending.settle({ exitCode: 0 });
  await tick();
  const done = await h.call('/hermes/api/update');
  check('a clean exit ends the job as done', done.body?.update?.phase === 'done', String(done.body?.update?.phase));
  check('a finished job keeps its output for the panel', (done.body?.update?.output ?? []).length > 0, `${(done.body?.update?.output ?? []).length} line(s)`);
  h.cleanup();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
if (failures === 0) {
  console.log(`(package root: ${PACKAGE_DIR})`);
}
process.exit(failures === 0 ? 0 : 1);
