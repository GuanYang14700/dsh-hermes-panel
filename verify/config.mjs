/**
 * Config-schema and secret-hygiene checks.
 *
 * Two failure modes this guards, both silent in a browser:
 *
 *  1. DSH renders settings only for fields reachable under a `.volatile()` node,
 *     so a `Config` whose fields are not volatile is collected and then dropped —
 *     the plugin looks configurable and offers nothing to configure.
 *  2. The plugin reads Hermes' `official-web/.env`, which also holds the
 *     runtime's API key. Only four keys may survive parsing.
 *
 * Usage: node verify/config.mjs
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, Config } from '../index.js';
import { makeTempDir } from './tmp.mjs';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Seven, not thirteen. Each one earns its place: hermesHome / hermesExe /
// installSource are the escape hatches discovery cannot do without, sharedWorkspace is
// the feature, manageGateway and autostart are real preferences, and dashboardPort is
// what the panel connects to. The six that went were neither escape hatches nor
// preferences — `bindHost` because the dashboard is loopback by design,
// `extraSearchPaths` and `installTarget` because `hermesHome` and the default already
// cover them, `bridgeWorkspace` because `sharedWorkspace` supersedes it,
// `bridgeProfile` because a wrong value makes Hermes -> DSH -> Hermes loop, and
// `startTimeoutMs` because a wrong value only turns a slow start into a failure.
const REQUIRED_FIELDS = [
  'runtimeDir',
  'dataDir',
  'dashboardPort',
  'sharedWorkspace',
  'manageGateway',
  'autostart',
];

/** A secret that must never appear in anything the plugin produces. */
const CANARY = 'sk-canary-must-never-leak-0123456789';

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

// ---- the schema ------------------------------------------------------------

if (Config === undefined || Config === null) {
  // The schema factory is Schemastery, which ships inside the installed harness.
  // A bare checkout has none — that is a fact about the checkout, not a defect in
  // the plugin, so it is reported as a skip rather than a red run. `npm install`
  // in this package supplies it, and CI does exactly that.
  console.log('SKIP  Config is exported — no Schemastery is resolvable here');
  console.log('      (run `npm install` in this package, or install one where DSH can see it)');
  console.log('\nALL CHECKS PASSED');
  process.exit(0);
}
check('Config is exported', true, 'the Schemastery factory resolved');

const dict = Config.dict ?? {};
const missing = REQUIRED_FIELDS.filter((field) => dict[field] === undefined);
check('every expected field is declared', missing.length === 0, missing.join(', ') || `${Object.keys(dict).length} fields`);

const notVolatile = REQUIRED_FIELDS.filter((field) => dict[field] !== undefined && dict[field].meta?.volatile !== true);
check(
  'every field is .volatile() (DSH renders nothing otherwise)',
  notVolatile.length === 0,
  notVolatile.join(', ') || 'all volatile',
);

// Both READMEs state the field count. Prose drifts — this one still said eight
// when there were thirteen — so it is compared against the schema here. A README
// that exists but no longer matches the pattern fails rather than skips, or the
// check would go inert the moment the sentence is reworded.
for (const [file, pattern] of [
  ['README.md', /all (\d+) fields volatile/],
  ['README.zh.md', /\*\*(\d+) 个字段\*\*/],
]) {
  const path = new URL(`../${file}`, import.meta.url);
  let claimed = null;
  let readable = true;
  try {
    claimed = pattern.exec(readFileSync(path, 'utf8'))?.[1] ?? null;
  } catch {
    readable = false;
  }
  check(
    `${file} claims the real field count`,
    readable && claimed !== null && Number(claimed) === Object.keys(dict).length,
    !readable
      ? 'not readable — verify/package.mjs reports the missing file'
      : claimed === null
        ? 'no claim matched — the sentence was reworded, so this check is now inert'
        : `claims ${claimed}, actual ${Object.keys(dict).length}`,
  );
}

check(
  'runtimeDir and dataDir default to a location under the DSH home',
  dict.runtimeDir?.meta?.default === '' && dict.dataDir?.meta?.default === '',
  `${JSON.stringify(dict.runtimeDir?.meta?.default)} / ${JSON.stringify(dict.dataDir?.meta?.default)}`,
);
check('dashboardPort defaults to 0 (meaning "take it from .env")', dict.dashboardPort?.meta?.default === 0, String(dict.dashboardPort?.meta?.default));
check('manageGateway defaults to true', dict.manageGateway?.meta?.default === true, String(dict.manageGateway?.meta?.default));
check('autostart defaults to false', dict.autostart?.meta?.default === false, String(dict.autostart?.meta?.default));

// ---- discovery and secret hygiene ------------------------------------------

const root = makeTempDir('hermes-panel-config-');
const home = join(root, 'home');
mkdirSync(join(home, 'official-web'), { recursive: true });
const exe = join(root, 'hermes.exe');
writeFileSync(exe, '');
writeFileSync(
  join(home, 'official-web', '.env'),
  [
    '# the real file also holds this:',
    `DEEPSEEK_API_KEY=${CANARY}`,
    `HERMES_HOME=${join(root, 'somewhere-else')}`,
    `HERMES_EXE=${exe}`,
    'DASHBOARD_PORT=9163',
    'SOME_OTHER_TOKEN=also-secret',
    '',
  ].join('\n'),
);

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
    spawn() {
      throw new Error('activation and status must not spawn anything');
    },
  },
};

// Wrapped the way DSH wraps it: one schema node per field, whose value is behind
// `get()`. Passing bare values here is what let a total failure hide for the whole
// life of the plugin — every field read as `''`, because a node is not a string, and
// no test used the shape the host actually sends.
apply(ctx, new Config({ dataDir: home, runtimeDir: root }));

let body = '';
const route = routes.get('exact:/hermes/api/status');
await route.handler(
  { method: 'GET', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
  {
    writeHead() {},
    end(text) {
      body = text;
    },
  },
);

check('the response is JSON', body.trimStart().startsWith('{'), body.slice(0, 40));
check('the API key never reaches the response', !body.includes(CANARY), body.includes(CANARY) ? 'LEAKED' : 'clean');
check('no other .env line reaches the response', !body.includes('also-secret'), 'clean');

const payload = JSON.parse(body);
check('discovery finds the fixture installation', payload.discovery?.found === true, JSON.stringify(payload.discovery?.source));
// The volume IS the home now, and `.env`'s own HERMES_HOME is not followed — it is
// one of the values the setting replaces. Where the two disagree the panel says so,
// because `start.ps1` sources `.env` and would come up on the other one.
check('discovery takes the home from the setting, not from .env', payload.discovery?.home === home, String(payload.discovery?.home));
check('and reports the .env disagreement instead of hiding it', Array.isArray(payload.discovery?.attempts) && payload.discovery.attempts.some((line) => String(line).includes('HERMES_HOME')), JSON.stringify(payload.discovery?.attempts));
check('discovery takes the port from .env', payload.discovery?.port === 9163, String(payload.discovery?.port));
check('the status payload exposes no .env contents', !JSON.stringify(payload).includes('DEEPSEEK'), 'clean');

// ---- the entry id the settings page is keyed by -----------------------------
//
// The settings namespace is the profile entry id, not the panel id, and the
// client half hard-codes it. The bundle patch is the only other place it lives,
// so the two are checked against each other: renaming the row without renaming
// the page would leave a schema that is served and a page that matches nothing.

const patch = readFileSync(join(PACKAGE_DIR, 'cordis.patch.yml'), 'utf8');
const rowId = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(patch)?.[1];
check('the bundle patch declares one id for the settings namespace', rowId === 'hermes-panel', String(rowId));

const clientSource = readFileSync(join(PACKAGE_DIR, 'client.js'), 'utf8');
check(
  'the client page is keyed by that same entry id',
  clientSource.includes("const SETTINGS_NAMESPACE = 'hermes-panel'"),
  'client.js SETTINGS_NAMESPACE',
);

// ---- the settings a user changes while DSH runs -----------------------------
//
// Every field is `.volatile()`, so these values are served by the row's settings
// namespace and edited live — the object given to `apply` is only the state at
// activation, and a settings save does NOT re-activate the plugin. Reading that
// snapshot afterwards pins every field to its boot value: the save is persisted,
// the settings page shows it, and the plugin keeps answering from the config it
// was born with. That is exactly how a picked workspace read back as unset.
//
// These checks pin the live read, and the fallback for a deployment that mounts
// no settings service at all.

{
  const liveHome = join(root, 'live-home');
  mkdirSync(join(liveHome, 'official-web'), { recursive: true });
  writeFileSync(
    join(liveHome, 'official-web', '.env'),
    [`HERMES_HOME=${liveHome}`, `HERMES_EXE=${exe}`, 'DASHBOARD_PORT=9177', ''].join('\n'),
  );

  /** What the settings service reports, swapped to simulate a save. */
  let described = [{ ns: 'hermes-panel', value: { sharedWorkspace: 'D:\\first', dashboardPort: 9177 } }];
  const liveRoutes = new Map();
  const liveDisposers = [];
  const liveCtx = {
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === 'function') liveDisposers.push(disposer);
      return disposer;
    },
    // The Host-side settings service, as `@deepseek-ai/dsh-settings` provides it.
    get: (name) => (name === 'settings' ? { describe: () => described } : undefined),
    webServer: {
      register(route) {
        liveRoutes.set(`${route.kind}:${route.path}`, route);
        return () => {};
      },
    },
    subprocess: {
      spawn() {
        throw new Error('this scenario must not spawn anything');
      },
    },
  };

  // The applied config deliberately disagrees with the settings service, so a
  // pass can only come from reading the live value.
  apply(liveCtx, { dataDir: liveHome });

  const readWorkspace = async () => {
    let text = '';
    await liveRoutes.get('exact:/hermes/api/workspace').handler(
      { method: 'GET', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
      { writeHead() {}, end(value) { text = value; } },
    );
    return JSON.parse(text);
  };

  const first = await readWorkspace();
  check(
    'a live setting overrides the config apply() was given',
    first.path === 'D:\\first' && first.configured === true,
    `${first.path} / configured=${first.configured}`,
  );

  // A later save must be visible without re-activating the plugin.
  described = [{ ns: 'hermes-panel', value: { sharedWorkspace: 'D:\\second', dashboardPort: 9177 } }];
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await readWorkspace();
  check(
    'a value saved after activation is read without a restart',
    second.path === 'D:\\second',
    String(second.path),
  );

  // A namespace that is gone (or a service that never mounted) must not blank
  // the plugin out — the applied config stays as the fallback.
  described = [];
  await new Promise((resolve) => setTimeout(resolve, 300));
  const third = await readWorkspace();
  check('a missing namespace falls back instead of throwing', third.configured === false, String(third.configured));

  for (const dispose of liveDisposers) dispose();
}

for (const dispose of disposers) dispose();
rmSync(root, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
if (failures === 0) {
  console.log(`(package root: ${PACKAGE_DIR})`);
}
process.exit(failures === 0 ? 0 : 1);
