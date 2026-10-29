/**
 * Health-check regression for `GET /hermes/api/health`.
 *
 * The route wraps Hermes' own `official-web/doctor.ps1 -Json`. Three things
 * about that are easy to get wrong and silent in a browser, so each is checked
 * here against a stub PowerShell instead of the real one:
 *
 *  1. the child's argv — the allow-listed script path, the `-Json` switch, and
 *     the `[Console]::OutputEncoding` preamble that keeps non-ASCII `detail`
 *     strings from arriving as mojibake;
 *  2. parsing — doctor prints progress lines around its JSON payload;
 *  3. failure reporting — unreadable output and a non-zero exit must surface as
 *     an error, never as a fabricated verdict.
 *
 * Entirely hermetic: a throwaway Hermes home under the OS temp directory, and a
 * subprocess stub in place of PowerShell. Part of `npm test`.
 *
 * Usage: node verify/health.mjs
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

/** A doctor report shaped like the real one, with a CJK detail and a preamble line. */
const DOCTOR_OUTPUT = [
  '[doctor] running checks',
  '[',
  '  {"check":"runtime","status":"OK","detail":"hermes-agent 0.19.0"},',
  '  {"check":"dashboard","status":"WARN","detail":"not running - 双击 启动.bat"},',
  '  {"check":"logs","status":"FAIL","detail":"not writable"},',
  '  {"check":"repo hygiene","status":"ok","detail":"secrets not tracked"}',
  ']',
  '',
].join('\n');

/** Build a child handle shaped like the subprocess service's. */
function fakeHandle(stdout, stderr, exitCode) {
  return {
    done: Promise.resolve({ exitCode }),
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length }) },
      stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length }) },
    },
    terminate() {},
    waitForExit: () => Promise.resolve(),
  };
}

/**
 * Stand up the plugin over a throwaway installation.
 * @param options - `doctor` body/exit, whether the first host fails to spawn.
 * @returns the status/health handlers and the argv each spawn received.
 */
function harness(options = {}) {
  const root = makeTempDir('hermes-panel-health-');
  const home = join(root, 'home');
  mkdirSync(join(home, 'official-web'), { recursive: true });
  const exe = join(root, 'hermes.exe');
  writeFileSync(exe, '');
  writeFileSync(
    join(home, 'official-web', '.env'),
    [`HERMES_HOME=${home}`, `HERMES_EXE=${exe}`, 'DASHBOARD_PORT=9150', ''].join('\n'),
  );
  writeFileSync(join(home, 'official-web', 'doctor.ps1'), '# fixture\n');

  const routes = new Map();
  const disposers = [];
  const argvSeen = [];
  let spawnCount = 0;

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
        spawnCount += 1;
        if (options.spawnThrows === true) throw new Error('spawn ENOENT');
        // "This machine has no pwsh": the probe for it fails and the fallback
        // host is then cached and used for the script too.
        if (options.failFirstHost === true && spec.argv[0] === 'pwsh') throw new Error('spawn ENOENT');
        // The host probe is `exit 0` and must succeed whatever the fixture says
        // about the script under test; otherwise a fixture's non-zero exit would
        // read as "no PowerShell works here" instead of "the script failed".
        if (String(spec.argv[3] ?? '') === 'exit 0') return fakeHandle('', '', 0);
        return fakeHandle(
          options.doctor ?? DOCTOR_OUTPUT,
          options.stderr ?? '',
          options.exitCode ?? 0,
        );
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
    call,
    cleanup() {
      for (const dispose of disposers) dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---- the happy path --------------------------------------------------------

{
  const h = harness();
  check('the health route is registered', h.routes.has('exact:/hermes/api/health'));

  const { status, body } = await h.call('/hermes/api/health');
  check('health answers 200', status === 200, `HTTP ${status}`);
  check('health reports the installation as available', body?.available === true, String(body?.available));
  check('health parsed the checks', Array.isArray(body?.checks) && body.checks.length === 4, `${body?.checks?.length} check(s)`);
  check('health used a PowerShell host', body?.host === 'pwsh', String(body?.host));

  const summary = body?.summary ?? {};
  check(
    'health summarizes case-insensitively and counts the rest',
    summary.ok === 2 && summary.warn === 1 && summary.fail === 1 && summary.other === 0,
    JSON.stringify(summary),
  );

  // The host is probed once, then every later call reuses it: an upgrade has to
  // commit to one host before it starts, so the choice cannot be per-call.
  check('the PowerShell host is probed before the script runs', String(h.argvSeen[0]?.[3] ?? '') === 'exit 0', String(h.argvSeen[0]?.[3]));

  const doctorArgv = h.argvSeen.find((argv) => String(argv[3] ?? '').includes('doctor.ps1')) ?? [];
  const command = String(doctorArgv[3] ?? '');
  check('the child is PowerShell with -NoProfile', doctorArgv[0] === 'pwsh' && doctorArgv[1] === '-NoProfile', doctorArgv.slice(0, 2).join(' '));
  check(
    'the command pins UTF-8 output before calling the script',
    command.startsWith('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;'),
    command.slice(0, 60),
  );
  check('the command runs doctor.ps1 with -Json', command.includes('doctor.ps1') && command.endsWith('-Json'), command.slice(-40));
  check(
    'the command quotes the absolute script path',
    /&\s*'[^']*official-web[\\/]doctor\.ps1'\s+-Json$/.test(command),
    command.slice(-70),
  );

  const cjk = (body?.checks ?? []).map((entry) => entry.detail).join(' ');
  check('non-ASCII detail survives the round trip', cjk.includes('双击 启动.bat') && !cjk.includes('\uFFFD'), cjk);
  h.cleanup();
}

// ---- a non-zero exit is reported, not hidden --------------------------------

{
  const h = harness({ exitCode: 2 });
  const { body } = await h.call('/hermes/api/health');
  check('a non-zero exit is reported', typeof body?.error === 'string' && body.error.includes('2'), String(body?.error));
  check('a non-zero exit still returns the parsed checks', Array.isArray(body?.checks), String(body?.checks?.length));
  h.cleanup();
}

// ---- unreadable output hands back the raw text ------------------------------

{
  const h = harness({ doctor: 'doctor blew up before printing anything\n' });
  const { status, body } = await h.call('/hermes/api/health');
  check('unparseable output answers 200 with an error', status === 200 && typeof body?.error === 'string', `${status} ${String(body?.error)}`);
  check('unparseable output keeps no invented checks', body?.checks === null, JSON.stringify(body?.checks));
  check('unparseable output hands back the raw tail', typeof body?.raw === 'string' && body.raw.includes('blew up'), String(body?.raw).slice(0, 40));
  h.cleanup();
}

// ---- a missing pwsh falls back to powershell.exe ----------------------------

{
  const h = harness({ failFirstHost: true });
  const { body } = await h.call('/hermes/api/health');
  check('a host that cannot spawn falls back to the next', body?.host === 'powershell.exe', String(body?.host));
  check('the fallback still parses the report', Array.isArray(body?.checks) && body.checks.length === 4, String(body?.checks?.length));
  h.cleanup();
}

// ---- a host that cannot run the script at all -------------------------------
//
// The "no installation" branch of the route is not reachable from this
// repository: discovery falls back to a `Hermes` sibling of any ancestor of the
// package, so pointing `hermesHome` at an empty directory still finds the real
// checkout next door. This covers the next path along — the script cannot be
// spawned — and asserts the route reports it rather than throwing.

{
  const h = harness({ spawnThrows: true });
  const { status, body } = await h.call('/hermes/api/health');
  check(
    'a PowerShell that cannot spawn is reported, not thrown',
    status === 200 && typeof body?.error === 'string' && body.checks === null,
    `${status} ${String(body?.error).slice(0, 60)}`,
  );
  h.cleanup();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
if (failures === 0) {
  console.log(`(package root: ${PACKAGE_DIR})`);
}
process.exit(failures === 0 ? 0 : 1);
