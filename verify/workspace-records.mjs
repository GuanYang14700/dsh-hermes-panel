/**
 * Workspace registration and the Hermes ↔ DSH record.
 *
 * The panel used to show nothing after a shared workspace was picked, and the
 * reason was structural rather than cosmetic: the directory holds only
 * `AGENTS.md`, and an exchange leaves its trace in DSH's **session log**, not in
 * a file. So this script pins down the two halves that make the record visible:
 *
 *  1. **Registration.** The directory is adopted as a real DSH Workspace
 *     (`ctx.workspaceRegistry.create`), which is what makes the sessions
 *     recorded under that cwd appear in the sidebar. It must be idempotent, it
 *     must not run when the directory does not exist (the registry rejects a
 *     missing path), and a deployment with no registry must report that fact
 *     rather than failing.
 *  2. **The record itself.** `/workspace/sessions` lists only sessions whose
 *     cwd is the shared workspace, and `/workspace/session` folds one log into
 *     the exchange: the task Hermes sent, DSH's answer, the tool calls, and the
 *     tool results — with the duplicate `tool/call` event dropped, because the
 *     assistant message already carries that call.
 *
 * The stubs are the point: `sessionQuery` and `workspaceRegistry` are injected
 * through `ctx.get`, so this proves the plugin's own filtering and folding
 * rather than the storage backend's.
 *
 * Usage: node verify/workspace-records.mjs
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateHostDiscovery, makeTempDir } from './tmp.mjs';

// A machine that has Hermes installed must still be able to reach the no-Hermes branch.
isolateHostDiscovery();

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
 * Stand one isolated plugin up.
 *
 * `index.js` is loaded from a **temporary copy** so the ancestor scan cannot
 * find a real Hermes checkout, and the shared workspace is created up front so
 * the "directory exists but is not registered" state is reachable — the state
 * the panel's auto-registration reacts to.
 * @param options - `registered` pre-registers the path; `noRegistry` omits the
 *   registry service entirely (a deployment with no web layer).
 * @returns the harness: the stubs, the workspace path, and a route caller.
 */
async function harness(options = {}) {
  const root = makeTempDir('hermes-panel-records-');
  const shared = join(root, 'shared');
  mkdirSync(shared, { recursive: true });
  // The journal lives in the user's home by default; point it at this sandbox so
  // the suite never reads or writes the real one.
  const journal = join(root, 'drives.jsonl');
  process.env.HERMES_PANEL_JOURNAL = journal;
  // What the bridge writes as it drives. This file IS the record now: the session
  // store cannot tell a driven run from a handwritten one, so the list is built
  // from here rather than from `listSessions`.
  const driven = options.driven ?? [
    { id: 'session-in', task: '把 README 的安装命令改对', cwd: shared, profile: 'dsh-agent', exit: 0, at: 1_700_000_000_000 },
    { id: 'session-out', task: '在桌面创建一个 wuhu.md', cwd: join(root, 'other'), profile: 'dsh-agent', exit: 0, at: 1_700_000_100_000 },
    { id: 'session-live', task: '还在跑的那次', cwd: shared, profile: 'dsh-agent', exit: 0, at: 1_700_000_200_000 },
  ];
  if (options.noJournal !== true) {
    // One JSON object per line, the shape the bridge appends.
    writeFileSync(journal, `${driven.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  }

  const pluginDir = join(root, 'plugin');
  mkdirSync(pluginDir, { recursive: true });
  cpSync(join(PACKAGE_DIR, 'index.js'), join(pluginDir, 'index.js'));
  const { apply } = await import(pathToFileURL(join(pluginDir, 'index.js')).href);

  const routes = new Map();
  const disposers = [];
  const createCalls = [];
  const deleteCalls = [];

  const registered = [];
  if (options.registered === true) registered.push({ id: 'ws-pre', path: shared, title: 'shared' });
  // A row this plugin left behind for a directory it is no longer pointed at. The
  // sidebar showed two rows with one identical title and no way to tell them apart.
  if (options.stale === true) registered.push({ id: 'ws-stale', path: join(root, 'old-shared'), title: '共享工作区（Hermes ↔ DSH）' });

  const registry = {
    list: () => registered.slice(),
    async create(path, title) {
      createCalls.push({ path, title });
      const existing = registered.find((workspace) => workspace.path === path);
      if (existing !== undefined) return existing;
      const created = { id: `ws-${registered.length + 1}`, path, title };
      registered.push(created);
      return created;
    },
    async resolveByPath(path) {
      return registered.find((workspace) => workspace.path === path);
    },
    async delete(id) {
      deleteCalls.push(id);
      const at = registered.findIndex((workspace) => workspace.id === id);
      if (at !== -1) registered.splice(at, 1);
    },
  };

  const inWorkspace = {
    header: { id: 'session-in', cwd: shared, createdAt: 1_700_000_000_000 },
    live: false,
    persisted: true,
  };
  const elsewhere = {
    header: { id: 'session-out', cwd: join(root, 'other'), createdAt: 1_700_000_100_000 },
    live: false,
    persisted: true,
  };
  const liveNoCwd = {
    header: { id: 'session-live', createdAt: 1_700_000_200_000 },
    live: true,
    persisted: true,
  };

  const logs = new Map();
  // The session exists, but in another directory: the route must refuse it on
  // the cwd check rather than on a read failure.
  logs.set('session-out', {
    session: elsewhere.header,
    events: [
      { type: 'user/message', seq: 0, time: 1_700_000_100_000, surfaceOp: 'append', data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '别的目录里的活' }] } } },
    ],
  });
  logs.set('session-in', {
    session: inWorkspace.header,
    events: [
      { type: 'turn/start', seq: 0, time: 1_700_000_000_000, data: { turn: 1 } },
      {
        type: 'user/message',
        seq: 1,
        time: 1_700_000_000_100,
        surfaceOp: 'append',
        data: { message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把 README 的安装命令改对' }] } },
      },
      {
        type: 'user/message',
        seq: 2,
        time: 1_700_000_000_200,
        surfaceOp: 'append',
        // Synthetic context: it must NOT read like something Hermes typed.
        data: { message: { role: 'user', source: { kind: 'agent-inject' }, content: [{ type: 'text', text: 'AGENTS.md 已更新' }] } },
      },
      {
        // Replaced history: a compaction dropped this, so the transcript must not
        // show text the model can no longer see.
        type: 'assistant/message',
        seq: 3,
        time: 1_700_000_000_250,
        surfaceOp: 'replace',
        data: {
          message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '这段已被压缩替换，不该出现' }] },
        },
      },
      {
        type: 'assistant/message',
        seq: 4,
        time: 1_700_000_000_300,
        surfaceOp: 'append',
        data: {
          message: {
            role: 'assistant',
            source: { kind: 'model' },
            content: [
              { type: 'reasoning', text: '先读 README 再改' },
              { type: 'text', text: '已改好，安装命令现在是 @guanyang14700/dsh-hermes-panel。' },
              { type: 'tool-call', id: 'call-1', name: 'str_replace_editor', arguments: '{"path":"README.md"}' },
            ],
          },
        },
      },
      {
        // A duplicate of the call above, as its own record: dropped by the fold.
        type: 'tool/call',
        seq: 5,
        time: 1_700_000_000_400,
        data: { turn: 1, step: 1, callId: 'call-1', name: 'str_replace_editor', arguments: '{"path":"README.md"}' },
      },
      {
        // No `toolName` on the message: the name has to come from the call index.
        type: 'tool/result',
        seq: 6,
        time: 1_700_000_000_500,
        surfaceOp: 'append',
        data: { message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] } },
      },
      {
        type: 'tool/call',
        seq: 7,
        time: 1_700_000_000_550,
        data: { turn: 1, step: 1, callId: 'call-2', name: 'pwsh', arguments: '{"command":"npm test"}' },
      },
      {
        type: 'tool/result',
        seq: 8,
        time: 1_700_000_000_600,
        surfaceOp: 'append',
        data: { message: { role: 'tool', toolCallId: 'call-2', isError: true, content: [{ type: 'text', text: '命令失败' }] } },
      },
      { type: 'turn/end', seq: 9, time: 1_700_000_000_700, data: { turn: 1, reason: 'completed' } },
    ],
  });

  const query = {
    async listSessions() {
      return options.records ?? [inWorkspace, elsewhere, liveNoCwd];
    },
    async readTitleSnapshots(ids) {
      return ids.map((sessionId) => ({
        sessionId,
        status: 'fulfilled',
        value: { session: { id: sessionId }, title: sessionId === 'session-in' ? { title: 'Hermes：改 README' } : undefined },
      }));
    },
    async readSession(sessionId) {
      const log = logs.get(sessionId);
      if (log === undefined) throw new Error(`session "${sessionId}" does not exist`);
      return log;
    },
    async readTitle(sessionId) {
      return sessionId === 'session-in' ? { title: 'Hermes：改 README' } : undefined;
    },
  };

  const services = { sessionQuery: query };
  if (options.noRegistry !== true) services.workspaceRegistry = registry;

  const ctx = {
    get: (name) => services[name],
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
        // Discovery finds no Hermes here, so nothing should ever be spawned; a
        // spawn means the harness leaked into a real installation.
        throw new Error('the records harness must not spawn a process');
      },
    },
  };

  apply(ctx, { sharedWorkspace: shared });

  const call = async (path, method = 'GET') => {
    // The route table is keyed by the registered path; the query string rides on
    // `req.url`, which is what the handler parses.
    const registeredPath = path.split('?')[0];
    const route = routes.get(`exact:${registeredPath}`);
    if (route === undefined) throw new Error(`route ${registeredPath} is not registered`);
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
      { method, url: path, headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
      res,
    );
    return { status: res.statusCode, body: body === '' ? null : JSON.parse(body) };
  };

  return {
    shared,
    registry,
    registered,
    createCalls,
    deleteCalls,
    registered,
    call,
    cleanup() {
      for (const dispose of disposers) dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---- the directory is not in the sidebar yet -------------------------------

{
  const h = await harness();
  const status = await h.call('/hermes/api/workspace');
  check('the workspace route answers', status.status === 200, `HTTP ${status.status}`);
  check('the directory is reported as configured', status.body?.path === h.shared, String(status.body?.path));
  check('it exists', status.body?.exists === true, String(status.body?.exists));
  check('it is not registered yet', status.body?.registered === false, String(status.body?.registered));
  check('and the panel is told registration is possible', status.body?.canRegister === true, String(status.body?.canRegister));
  check('so the panel knows to register it automatically', status.body?.needsRegistration === true, String(status.body?.needsRegistration));
  check('nothing was registered by merely reading status', h.createCalls.length === 0, `${h.createCalls.length} create call(s)`);
  h.cleanup();
}

// ---- registering is what makes the record visible --------------------------

{
  const h = await harness();
  const registered = await h.call('/hermes/api/workspace/register', 'POST');
  check('registering answers 200', registered.status === 200, `HTTP ${registered.status}`);
  check('it reports success', registered.body?.applied === true, String(registered.body?.applied));
  check('it created the workspace under the shared path', h.createCalls[0]?.path === h.shared, String(h.createCalls[0]?.path));
  check('with a recognisable title', String(h.createCalls[0]?.title ?? '').includes('共享工作区'), String(h.createCalls[0]?.title));
  // The title carries the directory. A fixed string put two DIFFERENT paths in the
  // sidebar under one identical name, with no way to tell which was which.
  check('and the title says WHICH directory', String(h.createCalls[0]?.title ?? '').endsWith(basename(h.shared)), String(h.createCalls[0]?.title));
  check('the returned status now says registered', registered.body?.status?.registered === true, String(registered.body?.status?.registered));
  const again = await h.call('/hermes/api/workspace/register', 'POST');
  check('a second registration is a no-op', again.body?.status?.registered === true && h.registered.length === 1, `${h.registered.length} record(s)`);
  h.cleanup();
}

// ---- a directory the plugin no longer points at does not linger -------------

{
  // Changing the shared workspace registers the new one and, until this, left the
  // old one in the sidebar for ever: two rows, one identical title, different
  // paths, and no way to tell which was which.
  const h = await harness({ stale: true });
  await h.call('/hermes/api/workspace/register', 'POST');
  check('the stale row was deleted', h.deleteCalls.includes('ws-stale'), h.deleteCalls.join(', '));
  check('and the current one was not', !h.deleteCalls.includes('ws-1'), h.deleteCalls.join(', '));
  h.cleanup();
}

// ---- "create and point" registers too --------------------------------------

{
  const h = await harness();
  const applied = await h.call('/hermes/api/workspace/apply', 'POST');
  check('applying answers 200', applied.status === 200, `HTTP ${applied.status}`);
  check('it reports the registration', applied.body?.registered === true, String(applied.body?.registered));
  check('it registered the shared path', h.createCalls[0]?.path === h.shared, String(h.createCalls[0]?.path));
  check('it wrote the shared AGENTS.md', applied.body?.createdContext === true, String(applied.body?.createdContext));
  check('AGENTS.md is really there', readFileSync(join(h.shared, 'AGENTS.md'), 'utf8').length > 0, '');
  check('the config is untouched — there is no Hermes to point', applied.body?.configChanged === false, String(applied.body?.configChanged));
  h.cleanup();
}

// ---- a deployment with no registry says so, and keeps working --------------

{
  const h = await harness({ noRegistry: true });
  const status = await h.call('/hermes/api/workspace');
  check('without a registry the status still answers', status.status === 200, `HTTP ${status.status}`);
  check('it reports registration as impossible', status.body?.canRegister === false, String(status.body?.canRegister));
  check('so nothing is left pending forever', status.body?.needsRegistration === false, String(status.body?.needsRegistration));
  const refused = await h.call('/hermes/api/workspace/register', 'POST');
  check('registering is refused with a reason', refused.body?.applied === false && String(refused.body?.error ?? '').includes('工作区注册表'), String(refused.body?.error));
  h.cleanup();
}

// ---- the record is the journal, and only the journal -----------------------

{
  const h = await harness({ registered: true });
  const listed = await h.call('/hermes/api/workspace/sessions');
  check('the sessions route answers', listed.status === 200, `HTTP ${listed.status}`);
  check('the corpus is available', listed.body?.available === true, String(listed.body?.reason));
  const ids = (listed.body?.sessions ?? []).map((session) => session.id);
  // Exactly what the bridge drove — not every DSH session on the machine, and not
  // only the ones under one directory. Both of those were wrong in different ways.
  check('the record is exactly the driven runs', ids.length === 3, ids.join(', '));
  check('newest first, so the run you just watched is at the top', ids[0] === 'session-live', ids.join(', '));
  check('a run from another directory is listed', ids.includes('session-out'), ids.join(', '));
  {
    const other = (listed.body?.sessions ?? []).find((session) => session.id === 'session-out');
    check('its row says where it ran', typeof other?.cwd === 'string' && other.cwd !== '', String(other?.cwd));
    check('and is marked as not the shared directory', other?.shared === false, String(other?.shared));
  }
  {
    const here = (listed.body?.sessions ?? []).find((session) => session.id === 'session-in');
    check('a run in the shared directory is marked as such', here?.shared === true, String(here?.shared));
  }
  {
    const row = (listed.body?.sessions ?? []).find((session) => session.id === 'session-in');
    // The one thing only the journal has. The transcript cannot supply it: the task
    // arrives as a CLI argument, not as the session's first user message.
    check('the row carries the task Hermes asked for', row?.task === '把 README 的安装命令改对', String(row?.task));
    check('the row carries the folded title from the store', row?.title === 'Hermes：改 README', String(row?.title));
    check('and a numeric timestamp the browser can format', typeof row?.since === 'number', String(row?.since));
  }
  check('the workspace is reported as registered', listed.body?.workspace?.registered === true, String(listed.body?.workspace?.registered));
  h.cleanup();
}

// ---- no journal means no record, and that is not an error ------------------

{
  const h = await harness({ registered: true, noJournal: true });
  const listed = await h.call('/hermes/api/workspace/sessions');
  check('an absent journal still answers', listed.status === 200, `HTTP ${listed.status}`);
  check('with an empty record rather than a failure', listed.body?.available === false && (listed.body?.sessions ?? []).length === 0, JSON.stringify(listed.body).slice(0, 120));
  check('and it says why', typeof listed.body?.reason === 'string' && listed.body.reason !== '', String(listed.body?.reason));
  h.cleanup();
}

// ---- one session folds into the exchange -----------------------------------

{
  const h = await harness({ registered: true });
  const read = await h.call('/hermes/api/workspace/session?id=session-in');
  check('the session route answers', read.status === 200, `HTTP ${read.status}`);
  check('the transcript is available', read.body?.available === true, String(read.body?.reason));
  const entries = read.body?.entries ?? [];
  const kinds = entries.map((entry) => entry.kind);
  check('Hermes task is the first entry', kinds[0] === 'user', kinds.join(', '));
  check('the task text is carried verbatim', entries[0]?.text === '把 README 的安装命令改对', String(entries[0]?.text));
  check('injected context is marked apart from the task', kinds.includes('context'), kinds.join(', '));
  check('DSH answer is present', entries.some((entry) => entry.role === 'assistant' && entry.text.includes('已改好')), '');
  check('reasoning is kept as its own kind', kinds.includes('reasoning'), kinds.join(', '));
  check('the tool call is shown once', kinds.filter((kind) => kind === 'tool-call').length === 1, kinds.join(', '));
  check('the tool call carries its name', entries.find((entry) => entry.kind === 'tool-call')?.tool === 'str_replace_editor', String(entries.find((entry) => entry.kind === 'tool-call')?.tool));
  check('a tool result is shown', kinds.includes('tool-result'), kinds.join(', '));
  check('a tool result names its tool from the call index', entries.find((entry) => entry.kind === 'tool-result')?.tool === 'str_replace_editor', String(entries.find((entry) => entry.kind === 'tool-result')?.tool));
  check('a failed tool result is marked as an error', kinds.includes('tool-error'), kinds.join(', '));
  check('the duplicate tool/call event was dropped', entries.filter((entry) => entry.text.includes('"path"')).length === 1, '');
  check('replaced history is left out', !entries.some((entry) => entry.text.includes('不该出现')), '');
  check('the turn boundary is not rendered', !kinds.includes('turn/start') && !kinds.includes('turn/end'), kinds.join(', '));
  check('each entry carries a clock time', entries.every((entry) => typeof entry.clock === 'string'), String(entries[0]?.clock));
  check('the session header rides along', read.body?.session?.id === 'session-in' && read.body?.session?.cwd === h.shared, JSON.stringify(read.body?.session));
  check('nothing was clipped at this size', read.body?.truncated === false, String(read.body?.truncated));
  h.cleanup();
}

// ---- the refusal cases -----------------------------------------------------

{
  const h = await harness({ registered: true });
  const missing = await h.call('/hermes/api/workspace/session?id=session-does-not-exist');
  check('an unknown session is reported, not invented', missing.status === 200 && missing.body?.available === false, String(missing.body?.reason));
  check('the reason names the read failure', String(missing.body?.reason ?? '').includes('does not exist'), String(missing.body?.reason));
  const noId = await h.call('/hermes/api/workspace/session');
  check('a request without an id is a 400', noId.status === 400, `HTTP ${noId.status}`);
  const wrongMethod = await h.call('/hermes/api/workspace/register');
  check('registration is POST-only', wrongMethod.status === 405, `HTTP ${wrongMethod.status}`);
  h.cleanup();
}

// ---- a session outside the workspace is refused ----------------------------

{
  const h = await harness({ registered: true });
  // `session-out` exists in the corpus but belongs to another directory.
  const refused = await h.call('/hermes/api/workspace/session?id=session-out');
  check('a session from another cwd is refused', refused.body?.available === false, String(refused.body?.reason));
  check('the refusal names the offending cwd', String(refused.body?.reason ?? '').includes('工作目录'), String(refused.body?.reason));
  h.cleanup();
}

// ---- an unconfigured workspace never pretends ------------------------------

{
  const root = makeTempDir('hermes-panel-records-empty-');
  const pluginDir = join(root, 'plugin');
  mkdirSync(pluginDir, { recursive: true });
  cpSync(join(PACKAGE_DIR, 'index.js'), join(pluginDir, 'index.js'));
  const { apply } = await import(pathToFileURL(join(pluginDir, 'index.js')).href);

  const routes = new Map();
  const ctx = {
    get: () => undefined,
    effect: (callback) => {
      callback();
    },
    webServer: {
      register(route) {
        routes.set(`${route.kind}:${route.path}`, route);
        return () => routes.delete(`${route.kind}:${route.path}`);
      },
    },
    subprocess: { spawn: () => { throw new Error('no spawn expected'); } },
  };
  apply(ctx, {});

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
  await routes.get('exact:/hermes/api/workspace/sessions').handler(
    { method: 'GET', url: '/hermes/api/workspace/sessions', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
    res,
  );
  const listed = JSON.parse(body);
  check('with nothing driven the list is empty', listed.available === false && listed.sessions.length === 0, String(listed.reason));
  // The record is the bridge's journal, and the journal does not depend on a shared
  // workspace being configured — so the reason is about the journal, not the config.
  check('and it says why', String(listed.reason ?? '').includes('桥还没有'), String(listed.reason));
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
