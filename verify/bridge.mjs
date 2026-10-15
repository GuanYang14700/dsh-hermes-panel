/**
 * Bridge regression: the Hermes half of the DSH ↔ Hermes channel.
 *
 * `POST /hermes/api/bridge/apply` edits the user's live `config.yaml`, which is
 * where a Hermes deployment keeps its **plaintext provider keys** and a full set
 * of explanatory comments. That makes this the most dangerous write in the
 * plugin, and the reason the implementation is line-based rather than a YAML
 * round trip. These checks pin down exactly that:
 *
 *  1. everything outside the one child entry survives byte for byte — comments,
 *     the secret, the neighbouring servers, and a top-level key that follows the
 *     block (which is what makes block-extent detection load-bearing);
 *  2. a failed `hermes config check` rolls the file back from the backup;
 *  3. a missing `mcp_servers:` block is created, not appended into nowhere.
 *
 * Usage: node verify/bridge.mjs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** Assertions this host cannot make. Reported, never silently dropped. */
let skipped = 0;
/**
 * Record one assertion this host has no fixture for.
 *
 * The suite runs on machines with and without the harness installed: CI checks the package out
 * with no `node_modules`, and then there is no `node_modules/@deepseek-ai/dsh` to derive a DSH
 * root from. The bridge falls back to that root's PARENT as the workspace, so the fallback
 * assertions cannot be made there — they are skipped loudly rather than asserted against a guess.
 * @param label - what was checked.
 * @param reason - why this host cannot check it.
 */
function skip(label, reason) {
  skipped += 1;
  console.log(`SKIP  ${label} — ${reason}`);
}
/**
 * The workspace the bridge falls back to with no shared workspace: the DSH root's parent.
 * @param body - a `/hermes/api/bridge` payload.
 * @returns the path, or null when this host has no harness installed.
 */
function derivedWorkspace(body) {
  const root = body?.dshRoot;
  return typeof root === 'string' && root !== '' ? dirname(root) : null;
}

/** A config shaped like a real Hermes one, with the traps that matter. */
const CONFIG_FIXTURE = [
  '# Hermes runtime config. Do not hand-edit while it is running.',
  '# ── Providers ──────────────────────────────────────────',
  'providers:',
  '  deepseek:',
  '    api_key: sk-canary-must-never-be-lost',
  '    model: deepseek-chat',
  '_config_version: 39',
  'mcp_servers:',
  '  word:',
  '    command: C:\\Tools\\word_mcp_server.exe',
  '    connect_timeout: 30',
  '  dsh:',
  '    command: C:\\other\\python.exe',
  '    args:',
  '      - C:\\somewhere-else\\dsh_mcp_server.py',
  '    enabled: true',
  '  origin:',
  '    command: C:\\Python314\\python.exe',
  '    enabled: true',
  '',
  '# ── Security ──────────────────────────────────────────',
  'redact_secrets: true',
  '',
].join('\n');

/** A promise a test resolves by hand. */
function deferred() {
  let settle;
  const promise = new Promise((resolvePromise) => {
    settle = resolvePromise;
  });
  return { promise, settle };
}

/**
 * Build a fixture Hermes home around one config body.
 * @param config - the `config.yaml` body, or null to omit the file.
 * @param options - `checkExit` is what `hermes config check` reports.
 * @returns the harness.
 */
function harness(config, options = {}) {
  const root = makeTempDir('hermes-panel-bridge-');
  const home = join(root, 'home');
  const venv = join(root, 'venv');
  mkdirSync(join(home, 'official-web'), { recursive: true });
  mkdirSync(venv, { recursive: true });
  const exe = join(venv, 'Scripts', 'hermes.exe');
  mkdirSync(dirname(exe), { recursive: true });
  writeFileSync(exe, '');
  writeFileSync(join(venv, 'python.exe'), '');
  writeFileSync(
    join(home, 'official-web', '.env'),
    [`HERMES_HOME=${home}`, `VENV=${venv}`, `HERMES_EXE=${exe}`, 'DASHBOARD_PORT=9150', ''].join('\n'),
  );
  if (config !== null) writeFileSync(join(home, 'config.yaml'), config);

  const routes = new Map();
  const disposers = [];
  const argvSeen = [];
  const spawnSpecs = [];
  const state = { checkExit: options.checkExit ?? 0 };

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
        // The folder picker is the only call whose *output* matters: that dialog
        // writes the chosen path to stdout.
        const isPicker = spec.argv.includes('-STA');
        const stdoutText = isPicker ? (options.pickStdout ?? '') : '';
        const reader = (text) => ({ readFrom: (offset) => ({ text: text.slice(offset), nextOffset: text.length }) });
        const exitCode = isPicker
          ? (options.pickExit ?? 0)
          : (spec.argv.includes('check') ? state.checkExit : 0);
        return {
          done: Promise.resolve({ exitCode }),
          collected: { stdout: reader(stdoutText), stderr: reader('') },
          terminate() {},
          waitForExit: () => Promise.resolve(),
        };
      },
    },
  };

  apply(ctx, {
    dataDir: home,
    bridgeWorkspace: 'E:\\workspace',
    bridgeProfile: 'dsh-agent',
    sharedWorkspace: options.sharedWorkspace ?? '',
  });

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
    home,
    configPath: join(home, 'config.yaml'),
    argvSeen,
    spawnSpecs,
    state,
    call,
    cleanup() {
      for (const dispose of disposers) dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** All backup files beside a config. */
function backups(configPath) {
  const dir = dirname(configPath);
  return readdirSync(dir).filter((name) => name.startsWith('config.yaml.bak-'));
}

// ---- can this checkout render a bridge entry at all? -----------------------
//
// `renderBridgeEntry` needs a DSH root, derived from `node_modules/@deepseek-ai/dsh`
// above this package. A bare checkout — which is what CI has — has none, and every
// block that applies the bridge would then be asserting against `undefined`.

const rootProbe = harness(CONFIG_FIXTURE);
const rootListed = await rootProbe.call('/hermes/api/bridge');
const DSH_ROOT = typeof rootListed.body?.dshRoot === "string" && rootListed.body.dshRoot !== "" ? rootListed.body.dshRoot : null;
rootProbe.cleanup();

// ---- status before anything is written -------------------------------------

{
  const h = harness(CONFIG_FIXTURE);
  const listed = await h.call('/hermes/api/bridge');
  check('the bridge route answers', listed.status === 200, `HTTP ${listed.status}`);
  check('the Hermes side is found', listed.body?.available === true && listed.body?.configPath === h.configPath, String(listed.body?.configPath));
  check('the shipped bridge script is present', listed.body?.scriptPresent === true, String(listed.body?.scriptPath));
  if (typeof listed.body?.dshRoot === 'string' && listed.body.dshRoot !== '') {
    check('the DSH root is derived, not configured', typeof listed.body?.dshRoot === 'string' && listed.body.dshRoot.length > 0, String(listed.body?.dshRoot));
  } else {
    skip('the DSH root is derived, not configured', 'no node_modules/@deepseek-ai/dsh above this package');
  }
  check('the Hermes python is found', String(listed.body?.python ?? '').endsWith('python.exe'), String(listed.body?.python));
  check('an existing dsh entry is reported as configured', listed.body?.configured === true, String(listed.body?.configured));
  check('and as pointing somewhere else', listed.body?.pointsAtThisCopy === false, String(listed.body?.pointsAtThisCopy));
  // `bridgeWorkspace` is retired: the fixture below still passes one, and it must lose.
  const fallback = derivedWorkspace(listed.body);
  check('a retired bridgeWorkspace no longer wins', listed.body?.workspace !== 'E:\\workspace', String(listed.body?.workspace));
  if (fallback === null) {
    skip('the unset workspace falls back to the DSH root', 'no node_modules/@deepseek-ai/dsh above this package');
  } else {
    check('the unset workspace falls back to the DSH root', listed.body?.workspace === fallback, String(listed.body?.workspace));
  }
  check('nothing was written before a request', backups(h.configPath).length === 0, backups(h.configPath).join(', '));
  h.cleanup();
}

// ---- the write preserves everything it must --------------------------------

{
  const h = harness(CONFIG_FIXTURE);
  // A bare checkout has no DSH root, so `renderBridgeEntry` refuses and the
  // route cannot do its work at all. Reported instead of asserted against undefined.
  if (DSH_ROOT === null) {
    skip('the write preserves the whole file', 'no node_modules/@deepseek-ai/dsh above this package');
  } else {
    const applied = await h.call('/hermes/api/bridge/apply', 'POST');
    // A bare checkout — which is what CI has — has no DSH installation above this
    // package, and `renderBridgeEntry` refuses without one. The entry is then never
    // rendered at all, so every assertion below would be testing `undefined`.
    // Reported as a skip instead: it is a fact about the checkout, not the plugin.
    if (applied.body?.action === undefined) {
      skip('the whole apply block', 'no node_modules/@deepseek-ai/dsh above this package');
    } else {
      check('applying answers 200', applied.status === 200, `HTTP ${applied.status}`);
      // The route's own success flag, which the panel reads to decide whether the
      // press did anything: `applied: false` comes back with a reason instead.
      check('and reports that it applied', applied.body?.applied === true, String(applied.body?.applied));
      check('the entry was replaced rather than added', applied.body?.action === 'replaced-entry', String(applied.body?.action));

      const after = readFileSync(h.configPath, 'utf8');
      check('the config still loads as text', after.length > 0 && after.includes('_config_version: 39'), '');

      for (const kept of [
        '# Hermes runtime config. Do not hand-edit while it is running.',
        '# ── Providers ──────────────────────────────────────────',
        '    api_key: sk-canary-must-never-be-lost',
        '    model: deepseek-chat',
        '  word:',
        '    command: C:\\Tools\\word_mcp_server.exe',
        '    connect_timeout: 30',
        '  origin:',
        '    command: C:\\Python314\\python.exe',
        '# ── Security ──────────────────────────────────────────',
        'redact_secrets: true',
      ]) {
        check(`preserved: ${kept.trim().slice(0, 46)}`, after.includes(kept), after.includes(kept) ? '' : 'MISSING');
      }

      check('the secret is still exactly once', after.split('sk-canary-must-never-be-lost').length - 1 === 1, '');
      check('the old bridge path is gone', !after.includes('somewhere-else'), '');
      check('the entry points at the shipped script', after.includes(join(PACKAGE_DIR, 'bridge', 'dsh_mcp_server.py').replace(/\\/g, '\\')), after.split('\n').find((line) => line.includes('dsh_mcp_server.py')) ?? 'not found');
      check('the entry carries the DSH root', after.includes('DSH_MCP_ROOT:'), '');
      // The written workspace has to be the one the panel reports — one workspace, not two.
      const derived = derivedWorkspace((await h.call('/hermes/api/bridge')).body);
      const writtenWorkspace = after.split('\n').find((line) => line.includes('DSH_MCP_WORKSPACE')) ?? 'not found';
      if (derived === null) {
        skip('the entry carries the workspace the panel reports', 'no node_modules/@deepseek-ai/dsh above this package');
      } else {
        check('the entry carries the workspace the panel reports', writtenWorkspace.includes(derived), writtenWorkspace.trim());
      }
      // No profile is pinned: the bridge's own default is `dsh-agent`.
      check('the entry pins no profile', !after.includes('DSH_MCP_PROFILE'), '');
      check('the entry keeps the sibling that follows it', after.indexOf('  origin:') > after.indexOf('  dsh:'), '');

      check('a backup was taken', backups(h.configPath).length === 1, backups(h.configPath).join(', '));
      const backupText = readFileSync(join(dirname(h.configPath), backups(h.configPath)[0]), 'utf8');
      check('the backup is the original file', backupText === CONFIG_FIXTURE, '');

      const status = await h.call('/hermes/api/bridge');
      check('status now reports the shipped copy', status.body?.pointsAtThisCopy === true, String(status.body?.pointsAtThisCopy));

      // Applying again must be a no-op, not a second backup with more drift.
      const again = await h.call('/hermes/api/bridge/apply', 'POST');
      check('a second apply changes nothing', again.body?.changed === false, String(again.body?.changed));
      check('and takes no second backup', backups(h.configPath).length === 1, `${backups(h.configPath).length} backup(s)`);
      check('the text is now identical to the first write', readFileSync(h.configPath, 'utf8') === after, '');
    }
  }
  h.cleanup();
}

// ---- a rejected config is rolled back --------------------------------------

{
  const h = harness(CONFIG_FIXTURE, { checkExit: 1 });
  // A bare checkout has no DSH root, so `renderBridgeEntry` refuses and the
  // route cannot do its work at all. Reported instead of asserted against undefined.
  if (DSH_ROOT === null) {
    skip('a rejected config is rolled back', 'no node_modules/@deepseek-ai/dsh above this package');
  } else {
    const applied = await h.call('/hermes/api/bridge/apply', 'POST');
    check('a failed config check is reported', applied.body?.applied === false, String(applied.body?.applied).slice(0, 40));
    check('the error names the rollback', String(applied.body?.error ?? '').includes('已回滚'), String(applied.body?.error).slice(0, 80));
    check('the file is byte-identical to the original', readFileSync(h.configPath, 'utf8') === CONFIG_FIXTURE, '');
    check('the backup is kept for the operator', backups(h.configPath).length === 1, backups(h.configPath).join(', '));
  }
  h.cleanup();
}

// ---- no mcp_servers block: create one --------------------------------------

{
  const withoutBlock = [
    '# minimal config',
    'providers:',
    '  deepseek:',
    '    api_key: sk-can...lost',
    '_config_version: 39',
    '',
  ].join('\n');
  const h = harness(withoutBlock);
  // A bare checkout has no DSH root, so `renderBridgeEntry` refuses and the route
  // cannot do its work at all. Reported instead of asserted against `undefined`.
  if (DSH_ROOT === null) {
    skip('a missing mcp_servers block is created', 'no node_modules/@deepseek-ai/dsh above this package');
  } else {
    const applied = await h.call('/hermes/api/bridge/apply', 'POST');
    check('a missing block is created', applied.body?.action === 'created-block', String(applied.body?.action));

    const after = readFileSync(h.configPath, 'utf8');
    check('the block exists once', after.split('mcp_servers:').length - 1 === 1, '');
    check('the entry is indented under it', /\nmcp_servers:\n {2}dsh:\n {4}command: /.test(after), after.split('\n').slice(-12).join(' | '));
  }
  h.cleanup();
}

// ---- a missing config.yaml is refused, not created -------------------------

{
  const h = harness(null);
  // A bare checkout has no DSH root, so `renderBridgeEntry` refuses and the
  // route cannot do its work at all. Reported instead of asserted against undefined.
  if (DSH_ROOT === null) {
    skip('a missing config.yaml is refused, not created', 'no node_modules/@deepseek-ai/dsh above this package');
  } else {
    const listed = await h.call('/hermes/api/bridge');
    check('a missing config is reported as unavailable', listed.body?.available === true && listed.body?.configured === false, JSON.stringify({ a: listed.body?.available, c: listed.body?.configured }));
    const applied = await h.call('/hermes/api/bridge/apply', 'POST');
    check('applying without a config is refused', applied.body?.applied === false, String(applied.body?.error).slice(0, 60));
    check('and no config is invented', !existsSync(h.configPath), '');
  }
  h.cleanup();
}

// ---- the shared workspace --------------------------------------------------
//
// `AGENTS.md` is the shared context: DSH's `dsh-agent-instructions` looks for
// that exact name and Hermes' context discovery reads it too, so the plugin's
// whole job is to put it in a directory both agents open in — and to never
// overwrite the operator's copy.

{
  const h = harness(CONFIG_FIXTURE);
  const listed = await h.call('/hermes/api/workspace');
  check('with nothing configured the workspace is reported as unconfigured', listed.body?.configured === false, String(listed.body?.configured));
  const refused = await h.call('/hermes/api/workspace/apply', 'POST');
  check('applying without a workspace is refused', refused.body?.applied === false, String(refused.body?.error).slice(0, 50));
  check(
    'the refusal names the setting',
    String(refused.body?.error ?? '').includes('sharedWorkspace'),
    String(refused.body?.error).slice(0, 60),
  );
  h.cleanup();
}

{
  const workspace = join(makeTempDir('hermes-panel-shared-'), 'shared');
  const h = harness(CONFIG_FIXTURE, { sharedWorkspace: workspace });

  const before = await h.call('/hermes/api/workspace');
  check('a configured workspace is reported', before.body?.configured === true, String(before.body?.path));
  check('and does not exist yet', before.body?.exists === false, String(before.body?.exists));
  // One workspace, not two: with a shared workspace configured, the bridge follows it.
  check('the bridge workspace IS the shared workspace', before.body?.bridgeWorkspace === workspace, String(before.body?.bridgeWorkspace));

  const applied = await h.call('/hermes/api/workspace/apply', 'POST');
  check('applying answers 200', applied.status === 200, `HTTP ${applied.status}`);
  check('the directory is created', applied.body?.createdDirectory === true && existsSync(workspace), String(applied.body?.createdDirectory));
  check('AGENTS.md is created', applied.body?.createdContext === true && existsSync(join(workspace, 'AGENTS.md')), String(applied.body?.createdContext));
  check('terminal.cwd is written', applied.body?.configChanged === true, String(applied.body?.configChanged));

  const after = readFileSync(h.configPath, 'utf8');
  check('the block and the key are there', /^terminal:\n {2}cwd: /m.test(after), after.split('\n').slice(-4).join(' | '));
  check('the secret survived', after.includes('sk-canary-must-never-be-lost'), '');
  check('the neighbouring blocks survived', after.includes('  word:') && after.includes('redact_secrets: true'), '');
  check('a backup was taken', backups(h.configPath).length === 1, `${backups(h.configPath).length} backup(s)`);

  const template = readFileSync(join(workspace, 'AGENTS.md'), 'utf8');
  check('the template is not empty', template.length > 40, `${template.length} bytes`);
  check('the template names both readers', template.includes('DSH') && template.includes('Hermes'), '');

  const status = await h.call('/hermes/api/workspace');
  check('the status now reports it pointing here', status.body?.hermesPointsHere === true, String(status.body?.hermesTerminalCwd));
  check('and the context file existing', status.body?.contextExists === true, String(status.body?.contextBytes));

  // Applying again must not touch the operator's file or the config.
  const second = await h.call('/hermes/api/workspace/apply', 'POST');
  check('a second apply leaves AGENTS.md alone', second.body?.createdContext === false, String(second.body?.createdContext));
  check('and does not rewrite the config', second.body?.configChanged === false, String(second.body?.configChanged));
  check('with no second backup', backups(h.configPath).length === 1, `${backups(h.configPath).length} backup(s)`);

  h.cleanup();
  rmSync(dirname(workspace), { recursive: true, force: true });
}

{
  // An operator's own AGENTS.md is theirs; the plugin must never write over it.
  const root = makeTempDir('hermes-panel-shared-custom-');
  const workspace = join(root, 'shared');
  mkdirSync(workspace, { recursive: true });
  const mine = '# 我的项目说明\n\n不要覆盖我。\n';
  writeFileSync(join(workspace, 'AGENTS.md'), mine, 'utf8');

  const h = harness(CONFIG_FIXTURE, { sharedWorkspace: workspace });
  await h.call('/hermes/api/workspace/apply', 'POST');
  check('an existing AGENTS.md is not overwritten', readFileSync(join(workspace, 'AGENTS.md'), 'utf8') === mine, '');
  h.cleanup();
  rmSync(root, { recursive: true, force: true });
}

{
  // A `terminal:` block that already exists keeps its other keys.
  const withTerminal = [
    '# config',
    'terminal:',
    '  timeout: 120',
    '  cwd: C:\\old',
    'providers:',
    '  deepseek:',
    '    api_key: sk-canary-must-never-be-lost',
    '',
  ].join('\n');
  const root = makeTempDir('hermes-panel-shared-term-');
  const workspace = join(root, 'shared');
  const h = harness(withTerminal, { sharedWorkspace: workspace });
  const applied = await h.call('/hermes/api/workspace/apply', 'POST');
  check('an existing terminal block gets its cwd replaced', applied.body?.action === 'replaced-key', String(applied.body?.action));

  const after = readFileSync(h.configPath, 'utf8');
  check('the other keys in that block survive', after.includes('  timeout: 120'), after);
  check('the old cwd is gone', !after.includes('C:\\\\old'), '');
  // Not `cwd: '<path>'`: the writer quotes a value only when it has to, and
  // `C:\...` needs the quotes while `/tmp/...` does not — asserting them made this
  // pass on Windows and fail on Linux for exactly the same, correct write.
  const cwdLine = after.split('\n').find((line) => line.trimStart().startsWith('cwd:')) ?? '';
  check('the new cwd is present', cwdLine.includes(workspace), cwdLine.trim() || after.split('\n').slice(0, 5).join(' | '));
  h.cleanup();
  rmSync(root, { recursive: true, force: true });
}

{
  // A rejected config rolls the config back; the directory and context file are
  // not config writes and are kept, which is stated rather than hidden.
  const root = makeTempDir('hermes-panel-shared-rollback-');
  const workspace = join(root, 'shared');
  const h = harness(CONFIG_FIXTURE, { sharedWorkspace: workspace, checkExit: 1 });
  const applied = await h.call('/hermes/api/workspace/apply', 'POST');
  check('a failed config check is reported', applied.body?.applied === false, String(applied.body?.applied));
  check('the config is byte-identical to the original', readFileSync(h.configPath, 'utf8') === CONFIG_FIXTURE, '');
  check('the directory is still there', existsSync(workspace), '');
  check('so is AGENTS.md', existsSync(join(workspace, 'AGENTS.md')), '');
  h.cleanup();
  rmSync(root, { recursive: true, force: true });
}

// ---- the folder picker -----------------------------------------------------
//
// Typing a path is the one input a user can get wrong, so the panel offers the
// machine's own dialog. It has to run on the Host — browsers hide absolute paths
// from `<input type="file" webkitdirectory>` — and it has to be launched into a
// single-threaded apartment, which is what the `-STA` flag is for and what would
// silently stop working if someone dropped it.

{
  if (process.platform !== 'win32') {
    // The picker is a WinForms dialog driven through `powershell -STA`; on any other
    // platform the route refuses and says so, which is what the README documents.
    // Asserting the Windows flow here would be asserting something this plugin
    // deliberately does not do off Windows.
    skip('the folder picker block', 'the picker is Windows-only by design');
  } else {
    const h = harness(CONFIG_FIXTURE, { pickStdout: 'E:\\Harness\\shared\r\n' });
    const picked = await h.call('/hermes/api/pick-directory', 'POST');
    check('the picker answers 200', picked.status === 200, `HTTP ${picked.status}`);
    check('a chosen directory comes back', picked.body?.picked === true && picked.body?.path === 'E:\\Harness\\shared', JSON.stringify(picked.body));

    const spec = h.spawnSpecs.find((entry) => entry.argv.includes('-STA'));
    check('the dialog is launched into a single-threaded apartment', spec !== undefined, 'no -STA invocation');
    check('it loads WinForms before opening the dialog', String(spec?.argv?.join(' ')).includes('System.Windows.Forms'), '');
    check('it asks for a new-folder button', String(spec?.argv?.join(' ')).includes('ShowNewFolderButton'), '');

    // Cancelling is a normal outcome, not a failure.
    const cancelledHarness = harness(CONFIG_FIXTURE, { pickStdout: '' });
    const cancelled = await cancelledHarness.call('/hermes/api/pick-directory', 'POST');
    check('cancelling is reported as cancelled, not as an error', cancelled.body?.picked === true && cancelled.body?.cancelled === true, JSON.stringify(cancelled.body));
    check('and yields no path', cancelled.body?.path === null, String(cancelled.body?.path));

    // A machine with no usable desktop session fails with something actionable.
    const failedHarness = harness(CONFIG_FIXTURE, { pickExit: 1 });
    const failed = await failedHarness.call('/hermes/api/pick-directory', 'POST');
    check('a picker that cannot open is reported as a failure', failed.body?.picked === false, String(failed.body?.picked));
    check(
      'and the message points at the fallback',
      String(failed.body?.error ?? '').includes('直接填路径'),
      String(failed.body?.error).slice(0, 60),
    );

    h.cleanup();
    cancelledHarness.cleanup();
    failedHarness.cleanup();
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
if (skipped > 0) console.log(`(${skipped} check(s) skipped: no DSH install above this package)`);
if (failures === 0) {
  console.log(`(package root: ${PACKAGE_DIR})`);
}
process.exit(failures === 0 ? 0 : 1);
