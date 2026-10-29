/**
 * An installation that is not this author's.
 *
 * The plugin used to recognise a Hermes home by `official-web/.env` alone — one
 * *distribution's* marker, not Hermes' — so on a machine where Hermes was
 * installed the ordinary way (pip/pipx/uv, data in a home directory with
 * `config.yaml`) discovery found nothing and every control in the panel was
 * dead. This pins the two halves of the fix:
 *
 *  1. **Recognition.** A home with `config.yaml` is an installation. The CLI may
 *     come from the config, the distribution's `.env`, a `VENV`, or PATH; a home
 *     with no CLI at all is still found, and reports why nothing can be started.
 *  2. **Capabilities.** 体检 / 查更新 / 升级 / 安装 are the distribution's own
 *     PowerShell scripts. On an upstream install none of them exists, so the
 *     panel must say so — and must not spawn anything when it cannot.
 *
 * Usage: node verify/upstream.mjs
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

/**
 * A throwaway "other machine": a data home plus, optionally, a CLI on PATH.
 * @param options - `distribution` adds the official-web layout, `cli` adds a fake hermes.
 * @returns paths and a cleanup.
 */
function machine(options = {}) {
  const root = makeTempDir('hermes-panel-upstream-');
  const home = join(root, 'home');
  mkdirSync(join(home, 'skills'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  // An upstream installation: data in the home, no official-web anywhere.
  writeFileSync(join(home, 'config.yaml'),
    ['providers:', '  deepseek:', '    api_key: sk-not-a-real-key', 'terminal:', "  cwd: 'C:\\work'", ''].join('\n'));
  writeFileSync(join(home, '.env'), 'DEEPSEEK_API_KEY=sk-not-a-real-key\n');
  writeFileSync(join(home, 'state.db'), 'SQLite format 3\u0000');

  let bin = null;
  let exe = null;
  if (options.cli === true) {
    bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    exe = join(bin, process.platform === 'win32' ? 'hermes.exe' : 'hermes');
    writeFileSync(exe, '');
  }
  if (options.distribution === true) {
    mkdirSync(join(home, 'official-web'), { recursive: true });
    writeFileSync(join(home, 'official-web', '.env'),
      [`HERMES_HOME=${home}`, `HERMES_EXE=${exe ?? ''}`, 'DASHBOARD_PORT=9150', ''].join('\n'));
    for (const script of ['doctor.ps1', 'check-update.ps1', 'update.ps1', 'install.ps1']) {
      writeFileSync(join(home, 'official-web', script), '# stub\n');
    }
  }
  return {
    root,
    home,
    bin,
    exe,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Load the plugin against one machine.
 * @param config - the row config to apply.
 * @returns the route caller, the spawn log, and cleanup.
 */
function load(config) {
  const routes = new Map();
  const disposers = [];
  const spawns = [];
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
        spawns.push(spec.argv.join(' '));
        // Never settles: a spawn that should not happen must not be the only
        // thing keeping a check honest.
        return {
          done: new Promise(() => {}),
          collected: {
            stdout: { readFrom: () => ({ text: '', nextOffset: 0 }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0 }) },
          },
          terminate() {},
          waitForExit: () => new Promise(() => {}),
        };
      },
    },
    get() {
      return undefined;
    },
  };
  apply(ctx, config);
  return {
    spawns,
    async call(path, method = 'GET') {
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
      await route.handler({ method, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } }, res);
      return { status: res.statusCode, body: body === '' ? null : JSON.parse(body) };
    },
    cleanup() {
      for (const dispose of disposers) dispose();
    },
  };
}

/**
 * Run with a PATH that cannot contain a Hermes CLI.
 *
 * Needed because the machine running the suite may well have one on PATH — that
 * is the whole point of the feature — so "no CLI anywhere" has to be arranged
 * rather than assumed.
 * @param body - the work to do with an empty PATH.
 * @returns whatever `body` returns.
 */
function withoutCliPath(body) {
  const original = process.env.PATH;
  const empty = makeTempDir('hermes-panel-nopath-');
  process.env.PATH = empty;
  try {
    return body();
  } finally {
    process.env.PATH = original;
    rmSync(empty, { recursive: true, force: true });
  }
}

/** Put a directory first on PATH for the duration of this process. */
function withBin(bin, body) {
  if (bin === null) return body();
  const original = process.env.PATH;
  process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${original ?? ''}`;
  try {
    return body();
  } finally {
    process.env.PATH = original;
  }
}

// ---- 1. an upstream home with a hermes on PATH ------------------------------

{
  const box = machine({ cli: true });
  const h = withBin(box.bin, () => load({ dataDir: box.home, dashboardPort: 0 }));
  const status = await h.call('/hermes/api/status');
  const discovery = status.body?.discovery;
  const capabilities = status.body?.capabilities;

  check('a home with config.yaml is found', discovery?.found === true, String(discovery?.source));
  check('and it is recognised as the upstream layout, not official-web', discovery?.officialWeb === false, String(discovery?.officialWeb));
  check('the CLI comes from PATH', discovery?.exe === box.exe, String(discovery?.exe));
  check('the payload still names a port', Number.isInteger(discovery?.port), String(discovery?.port));
  check('capabilities report the CLI', capabilities?.cli === true, String(capabilities?.cli));
  check('and none of the distribution scripts', capabilities?.health === false && capabilities?.update === false, JSON.stringify(capabilities));

  const health = await h.call('/hermes/api/health');
  check('体检 answers with a reason instead of failing', health.status === 200 && health.body?.available === false,
    `HTTP ${health.status} ${String(health.body?.reason ?? '')}`.slice(0, 90));
  check('and the reason names the missing script', String(health.body?.reason ?? '').includes('doctor.ps1'), String(health.body?.reason ?? '').slice(0, 60));

  const checkUpdate = await h.call('/hermes/api/update/check', 'POST');
  check('查更新 answers with a reason too', checkUpdate.body?.available === false, String(checkUpdate.body?.reason ?? '').slice(0, 60));
  check('naming check-update.ps1', String(checkUpdate.body?.reason ?? '').includes('check-update.ps1'), String(checkUpdate.body?.reason ?? '').slice(0, 60));

  const apply = await h.call('/hermes/api/update/apply', 'POST');
  check('升级 refuses before it starts anything', apply.body?.available === false, String(apply.body?.reason ?? '').slice(0, 60));
  check('nothing was spawned by any of that', h.spawns.length === 0, h.spawns.join(' | ').slice(0, 80));

  const state = await h.call('/hermes/api/update');
  check('the update payload says the capability is absent', state.body?.canUpgrade === false, String(state.body?.canUpgrade));

  h.cleanup();
  box.cleanup();
}

// ---- 2. the same home, with no CLI anywhere ---------------------------------

{
  const box = machine();
  const h = withoutCliPath(() => load({ dataDir: box.home, dashboardPort: 0 }));
  const status = await h.call('/hermes/api/status');
  check('a home with no CLI is still found', status.body?.discovery?.found === true, String(status.body?.discovery?.source));
  check('the payload says there is no CLI', status.body?.capabilities?.cli === false, String(status.body?.discovery?.exe));
  check('and the attempt list says what to fix',
    (status.body?.discovery?.attempts ?? []).some((line) => line.includes('hermesExe')),
    (status.body?.discovery?.attempts ?? [])[0] ?? '');

  const start = await h.call('/hermes/api/start', 'POST');
  check('start refuses instead of spawning nothing', start.body?.dashboard?.status === 'error', String(start.body?.dashboard?.status));
  check('with a message that names the setting', String(start.body?.dashboard?.error ?? '').includes('hermesExe'), String(start.body?.dashboard?.error ?? '').slice(0, 60));
  check('and it really spawned nothing', h.spawns.length === 0, h.spawns.join(' | ').slice(0, 80));

  h.cleanup();
  box.cleanup();
}

// ---- 3. HERMES_HOME in the environment, no config --------------------------

{
  const box = machine({ cli: true });
  const original = process.env.HERMES_HOME;
  process.env.HERMES_HOME = box.home;
  const h = withBin(box.bin, () => load({ dashboardPort: 0 }));
  const status = await h.call('/hermes/api/status');
  check('an exported HERMES_HOME is enough to be found', status.body?.discovery?.found === true, String(status.body?.discovery?.source));
  h.cleanup();
  if (original === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = original;
  box.cleanup();
}

// ---- 4. the distribution layout keeps every capability ----------------------

{
  const box = machine({ cli: true, distribution: true });
  const h = withBin(box.bin, () => load({ dataDir: box.home, dashboardPort: 0 }));
  const status = await h.call('/hermes/api/status');
  const capabilities = status.body?.capabilities;
  check('official-web is still recognised as such', status.body?.discovery?.officialWeb === true, String(status.body?.discovery?.source));
  check('and its maintenance scripts light up', capabilities?.health === true && capabilities?.update === true,
    JSON.stringify(capabilities));
  h.cleanup();
  box.cleanup();
}

// ---- 5. a directory that is not a Hermes home at all ------------------------

{
  const box = machine();
  rmSync(join(box.home, 'config.yaml'), { force: true });
  // Discovery also guesses at `%USERPROFILE%\Hermes` and `…\.hermes`, and the
  // machine running the suite may genuinely have one of those — so point the
  // guess at an empty directory instead of at this developer's home.
  const blank = makeTempDir('hermes-panel-blankhome-');
  const originalProfile = process.env.USERPROFILE;
  const originalHome = process.env.HOME;
  process.env.USERPROFILE = blank;
  process.env.HOME = blank;
  const h = withoutCliPath(() => load({ dataDir: box.home, dashboardPort: 0 }));
  const status = await h.call('/hermes/api/status');
  const discovery = status.body?.discovery ?? {};
  // Discovery may still find a Hermes further up the tree — on the machine this
  // suite is developed on, `Hermes` genuinely sits beside the harness. What is
  // being pinned here is narrower and machine-independent: THIS directory was
  // refused, and it was refused by name.
  check('a directory with neither marker is refused by name',
    (discovery.attempts ?? []).some((line) => line.includes(box.home) && line.includes('config.yaml') && line.includes('official-web')),
    (discovery.attempts ?? [])[0] ?? '');
  check('and it is not what discovery settled on', discovery.home !== box.home, String(discovery.home));
  h.cleanup();
  if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile;
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  rmSync(blank, { recursive: true, force: true });
  box.cleanup();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
if (failures === 0) {
  console.log(`(package root: ${PACKAGE_DIR})`);
}
// A route that waits on a child which never settles would hang the suite rather
// than fail it; this turns that into a red run with a line number's worth of
// context.
const watchdog = setTimeout(() => {
  console.log('\nFAIL  the script did not finish within 60s — a check is waiting on something that never settles');
  process.exit(2);
}, 60000);
watchdog.unref();

process.exit(failures === 0 ? 0 : 1);
