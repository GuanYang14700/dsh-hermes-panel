/**
 * Client-half verification for the Hermes panel bundle.
 *
 * Loads the real `client.js` through a stubbed `window.__ModuleLoader__`, feeds
 * the factory a minimal fake React, then runs the real `apply` against a fake
 * slot registry — the exact object the sidebar and layout consult.
 *
 * This cannot prove what the browser paints, but it does prove the things that
 * fail silently in a browser: that the factory materializes, that `apply` does
 * not throw, and that the two seats are registered with the options their owners
 * require (list `sidebar.panellist` needs `id`/`order`/`label`; keyed `main`
 * needs `key`).
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Config } from '../index.js';

const CLIENT_PATH = new URL('../client.js', import.meta.url);

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

// ---- browser stand-ins -----------------------------------------------------

/** Minimal React: components are only defined here, never rendered. */
const fakeReact = {
  // Real React puts children on props as well; the fallback UI components read
  // props.children, so the stub has to match or they render empty here.
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
    children,
  }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial ?? null }),
  useEffect: () => {},
  useCallback: (fn) => fn,
};

const styleTags = [];
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild: (tag) => styleTags.push(tag) },
};
/** Every request the bundle made, in order. */
const panelCalls = [];

/** `GET /hermes/api/status` as the Host shapes it: a found installation, stopped. */
const STATUS_FIXTURE = {
  discovery: { found: true, home: 'E:\\Hermes\\home', port: 9150, source: 'fixture', attempts: [] },
  dashboard: { status: 'stopped', owned: false, error: null },
  gateway: { status: 'stopped', owned: false, pid: null, pids: [], warning: null, error: null },
  url: null,
  log: [],
  /** The bridge, with the DSH half drifted — the state this machine is really in. */
  bridge: {
    available: true,
    configPath: 'E:\\Hermes\\home\\config.yaml',
    scriptPath: 'E:\\plugin\\bridge\\dsh_mcp_server.py',
    scriptPresent: true,
    dshRoot: 'E:\\Harness\\dsh',
    python: 'E:\\venv\\python.exe',
    dshVersion: '0.2.0-rc.2',
    profiles: [{ name: 'web', version: '0.1.0-rc.8', compatible: false }],
    clientCompatible: false,
    workspace: 'E:\\Harness',
    profile: '',
    configured: true,
    pointsAtThisCopy: false,
    entry: '  dsh:\n    command: old',
  },
  /** The shared workspace, with Hermes not yet pointed at it. */
  workspace: {
    configured: true,
    path: 'E:\\shared',
    // The volume, reported separately from the shared workspace: one is where
    // Hermes keeps its data, the other is where both agents work.
    dataDir: 'E:\\hermes-home',
    volume: {
      path: 'E:\\hermes-home',
      profiles: ['companion', 'cristina'],
      stateBytes: 2_400_000,
      officialWeb: true,
      config: true,
    },
    exists: true,
    contextPath: 'E:\\shared\\AGENTS.md',
    contextExists: false,
    contextBytes: null,
    hermesTerminalCwd: null,
    hermesPointsHere: false,
    bridgeWorkspace: 'E:\\shared',
    registered: true,
    canRegister: true,
    needsRegistration: false,
    /** The list the tab renders: one primary, and one beside it. */
    workspaces: [
      { path: 'E:\\shared', primary: true, exists: true, registered: true },
      { path: 'E:\\side', primary: false, exists: true, registered: false },
    ],
  },
};

/** `GET /hermes/api/workspace/sessions` — what the Host reads out of the session corpus. */
const RECORDS_FIXTURE = {
  available: true,
  reason: null,
  workspace: { path: 'E:\\shared', registered: true, workspaceId: 'ws-1' },
  truncated: false,
  sessions: [
    { id: 'session-in', title: 'Hermes：改 README', time: '2026-10-14T02:00:00.000Z', since: 1_760_000_000_000, live: false, persisted: true },
  ],
};

/** `GET /hermes/api/workspace/session?id=…` — one exchange, folded. */
const TRANSCRIPT_FIXTURE = {
  available: true,
  reason: null,
  session: { id: 'session-in', title: 'Hermes：改 README', time: '2026-10-14T02:00:00.000Z', cwd: 'E:\\shared' },
  workspace: { path: 'E:\\shared', registered: true },
  truncated: false,
  entries: [
    { role: 'user', kind: 'user', tool: null, text: '把 README 的安装命令改对', time: '2026-10-14T02:00:01.000Z', clock: '10:00' },
    { role: 'assistant', kind: 'tool-call', tool: 'str_replace_editor', text: '{"path":"README.md"}', time: '2026-10-14T02:00:02.000Z', clock: '10:00' },
    { role: 'tool', kind: 'tool-error', tool: 'pwsh', text: '命令失败', time: '2026-10-14T02:00:03.000Z', clock: '10:00' },
  ],
};

/** `GET /hermes/api/health` as `doctor.ps1 -Json` produces it. */
const HEALTH_FIXTURE = {
  available: true,
  host: 'pwsh',
  exitCode: 0,
  ranAt: '2026-10-14T02:00:00.000Z',
  checks: [
    { check: 'runtime', status: 'OK', detail: 'hermes-agent 0.19.0' },
    { check: 'dashboard', status: 'WARN', detail: 'not running - 双击 启动.bat' },
    { check: 'logs', status: 'FAIL', detail: 'not writable' },
  ],
  summary: { ok: 1, warn: 1, fail: 1, other: 0 },
};

/** `POST /hermes/api/update/check` as `check-update.ps1` produces it. */
const UPDATE_REPORT = [
  '[update] installed : Hermes Agent v0.19.0 (2026.7.20)',
  '[update] python    : 3.13',
  '[update] latest    : 0.20.0   requires_python: <3.14,>=3.11',
  '[update] report only - re-run with -Apply to upgrade',
].join('\n');

// The bundle reads `fetch` as a free variable, and it is loaded below through
// `new Function('window', 'document', 'fetch', source)`, so this stub is bound
// at LOAD time. Reassigning `globalThis.fetch` later would change nothing.
// `panelStatus` is what a later scenario swaps to render the "not installed"
// state, whose plan comes from the same payload.
let panelStatus = STATUS_FIXTURE;
globalThis.fetch = async (url, options) => {
  const target = String(url);
  panelCalls.push({ url: target, method: options?.method ?? 'GET' });
  if (target.endsWith('/health')) {
    return { ok: true, status: 200, json: async () => HEALTH_FIXTURE };
  }
  if (target.endsWith('/update/check')) {
    return { ok: true, status: 200, json: async () => ({ available: true, exitCode: 0, host: 'pwsh', text: UPDATE_REPORT }) };
  }
  if (target.endsWith('/update/apply')) {
    return { ok: true, status: 200, json: async () => ({ available: true, update: { phase: 'running', output: [] } }) };
  }
  if (target.endsWith('/update')) {
    return { ok: true, status: 200, json: async () => ({ available: true, report: UPDATE_REPORT, update: { phase: 'running', output: [] } }) };
  }
  if (target.endsWith('/bridge/apply')) {
    return { ok: true, status: 200, json: async () => ({ applied: true, changed: true, backup: 'config.yaml.bak-1' }) };
  }
  if (target.endsWith('/workspace/apply')) {
    return { ok: true, status: 200, json: async () => ({ applied: true, createdContext: true, configChanged: true, backup: 'config.yaml.bak-2' }) };
  }
  if (target.endsWith('/pick-directory')) {
    return { ok: true, status: 200, json: async () => ({ picked: true, path: 'E:\\picked', cancelled: false }) };
  }
  if (target.includes('/workspace/sessions')) {
    return { ok: true, status: 200, json: async () => RECORDS_FIXTURE };
  }
  if (target.includes('/workspace/session?')) {
    return { ok: true, status: 200, json: async () => TRANSCRIPT_FIXTURE };
  }
  if (target.endsWith('/workspace/register')) {
    return { ok: true, status: 200, json: async () => ({ applied: true, registered: true, status: { ...panelStatus.workspace, registered: true, needsRegistration: false } }) };
  }
  return { ok: true, status: 200, json: async () => panelStatus };
};

let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg;
    },
  },
};

// ---- load the real bundle --------------------------------------------------

const source = readFileSync(CLIENT_PATH, 'utf8');

// The bundle's name is read from the manifest, never written twice. A test that
// hard-codes the same string it asserts can only ever agree with itself: this
// file used to carry `const BUNDLE = '@local/dsh-hermes-panel'`, so renaming the
// package left the client registering its slot keys under a name no installed
// bundle had — the bundle's own page rendered nothing — and the suite stayed
// green throughout.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const BUNDLE = manifest.name;
check('the manifest declares a package name', typeof BUNDLE === 'string' && BUNDLE !== '', String(BUNDLE));

new Function('window', 'document', 'fetch', source)(
  globalThis.window,
  globalThis.document,
  globalThis.fetch,
);

check('client.js registers a module factory', registration !== null, registration?.id ?? 'none');
check('module id matches the package name', registration?.id === BUNDLE, `${registration?.id} vs ${BUNDLE}`);
check(
  'the client declares the package name in one constant',
  source.includes(`const BUNDLE_PACKAGE_NAME = '${BUNDLE}';`),
  source.includes(`const BUNDLE_PACKAGE_NAME = '${BUNDLE}';`) ? '' : 'client.js BUNDLE_PACKAGE_NAME',
);
check(
  'the development scope is gone from both shipped halves',
  !source.includes('@local/')
    && !readFileSync(new URL('../index.js', import.meta.url), 'utf8').includes('@local/'),
  source.includes('@local/') ? 'client.js' : 'index.js',
);

// DSH loads each client half as a CLASSIC script, and every classic script in a
// page shares one global lexical scope. DSH also executes the same bundle more
// than once: an `immediately` row is prefetched from its own single-resource URL
// and again with the batch, and a batch that fails to compile is retried row by
// row. A file-scope binding therefore throws on the second execution —
// `SyntaxError: Identifier 'BUNDLE_PACKAGE_NAME' has already been declared` —
// the registration never happens, and the shell reports the entry as
// `import failed (see console for the import error)` with no recorded reason,
// so nothing in this suite failed while the seat was gone. Running the real
// source twice inside one vm context is that browser scope, reproduced.
const browserScope = vm.createContext({ console: { warn() {}, log() {}, error() {} } });
vm.runInContext(
  'globalThis.__registrations = []; globalThis.window = { __ModuleLoader__: { load: (registration) => globalThis.__registrations.push(registration.id) } };',
  browserScope,
);
let secondExecution = '';
try {
  vm.runInContext(source, browserScope, { filename: 'client.js' });
  vm.runInContext(source, browserScope, { filename: 'client.js' });
} catch (error) {
  secondExecution = String(error);
}
const registrations = vm.runInContext('globalThis.__registrations.length', browserScope);
check(
  'the client survives a second execution in one shared global script scope',
  secondExecution === '' && registrations === 2,
  secondExecution || `${String(registrations)} registrations`,
);

const exports = registration.factory((specifier) => {
  if (specifier === 'react') return fakeReact;
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
});

check('exports a slots inject list', Array.isArray(exports.inject) && exports.inject.includes('slots'), JSON.stringify(exports.inject));
check('exports apply()', typeof exports.apply === 'function');

// ---- run apply against a fake slot registry --------------------------------

/** Captured injections: slot name -> the callback the owner would fire. */
const injections = new Map();
/** Captured registrations, in order. */
const registered = [];
const effects = [];

const ctx = {
  effect(callback, label) {
    const result = callback();
    effects.push({ label, returned: typeof result });
    return result ?? (() => {});
  },
  slots: {
    inject(slot, callback) {
      injections.set(slot, callback);
      return () => {};
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    },
  },
};

let applyError = null;
try {
  exports.apply(ctx);
} catch (error) {
  applyError = error;
}
check('apply() runs without throwing', applyError === null, applyError ? `${applyError.name}: ${applyError.message}` : '');

check('every effect returned a valid disposer', effects.every((e) => e.returned === 'function'), effects.map((e) => `${e.label}=${e.returned}`).join(', '));
check('it claims no slot in the left sidebar', !injections.has('main') && !injections.has('sidebar.panellist'), [...injections.keys()].join(', '));
check('the right column is the only seat it takes', injections.size === 0, [...injections.keys()].join(', '));

// Owners fire the inject callback once their slot is declared.
for (const [slot, callback] of injections) {
  try {
    callback();
  } catch (error) {
    check(`owner firing inject("${slot}") does not throw`, false, `${error.name}: ${error.message}`);
  }
}

// One surface: the right column's tab. Nothing registers into `main` any more,
// so DSH shows no 「Hermes」 row in the left sidebar and no full-width panel that
// replaces the conversation the tab is meant to sit beside.
check(
  'nothing is registered outside the right column',
  registered.every((r) => !['main', 'sidebar.panellist'].includes(r.options.name)),
  registered.map((r) => r.options.name).join(', '),
);

// ---- the settings page -----------------------------------------------------
//
// The Host serves a settings namespace as soon as the plugin exports a
// `.volatile()` Config, but DSH renders no form of its own: the page has to be
// contributed here, through the `plugins.item` slot the Plugins panel lists and
// opens. This scenario supplies the browser module table and the two services
// that page needs, and checks the registration the panel will find.

/** The fields each converted spec must address, checked against the Host schema below. */
let registeredFieldNames = null;

const fakePrimitives = {
  SettingsForm: (props) => ({ type: 'SettingsForm', props }),
  SettingsValueField: (props) => ({ type: 'SettingsValueField', props }),
  settingsTextField: (field) => ({
    field,
    format: (value) => (typeof value === 'string' ? value : ''),
    parse: (text) => (text === '' ? { kind: 'clear' } : { kind: 'set', value: text }),
  }),
  settingsNumberField: (field) => ({
    field,
    format: (value) => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' };
      return /^-?\d+$/.test(text.trim()) ? { kind: 'set', value: Number(text.trim()) } : undefined;
    },
  }),
  SettingsFormModel: class {
    constructor(scope, specs) {
      this.scope = scope;
      this.specs = specs;
      registeredFieldNames = specs.map((spec) => spec.field);
    }
    bind(project) {
      return { getSnapshot: project, subscribe: () => () => {} };
    }
    shell() {
      return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false };
    }
    field() {
      return { text: '', overridden: false, invalid: false };
    }
    actions() {
      return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} };
    }
    dispose() {}
  },
};

const fakeSnapshot = {
  status: 'ready',
  value: {},
  base: {},
  user: {},
  writable: true,
  revision: 0,
};

const settingsInjections = new Map();
const settingsRegistrations = [];
const settingsEffects = [];

const settingsCtx = {
  effect(callback) {
    const disposer = callback();
    settingsEffects.push(typeof disposer);
    return typeof disposer === 'function' ? disposer : () => {};
  },
  get(name) {
    if (name === 'configForms') {
      return {
        get: () => ({
          getSnapshot: () => fakeSnapshot,
          subscribe: () => () => {},
          mutate: async () => true,
        }),
        whileServed: (namespaces, register) => {
          register(new Set(namespaces));
          return () => {};
        },
      };
    }
    if (name === 'locale') {
      return {
        bind: (namespace) => (key) => `${namespace}#${key}`,
        register: () => () => {},
      };
    }
    return undefined;
  },
  slots: {
    inject(slot, callback) {
      settingsInjections.set(slot, callback);
      return () => {};
    },
    register(options, component) {
      settingsRegistrations.push({ options, component });
      return () => {};
    },
  },
};

const settingsExports = registration.factory((specifier) => {
  if (specifier === 'react') return fakeReact;
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives;
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
});

let settingsApplyError = null;
try {
  withInject(settingsCtx);
  settingsExports.apply(settingsCtx);
} catch (error) {
  settingsApplyError = error;
}
check(
  'apply() runs with the settings services present',
  settingsApplyError === null,
  settingsApplyError ? `${settingsApplyError.name}: ${settingsApplyError.message}` : '',
);

// The slot owner fires the injection callback once it declares the slot, which
// is when a real registration lands. The Plugins page declares all three, and
// each is fired by its own owner — a registration the test never fires would
// silently never land, which is the bug this whole block exists to catch.
for (const slot of ['plugins.item', 'plugins.bundle.config', 'plugins.row.config']) {
  try {
    settingsInjections.get(slot)?.();
  } catch (error) {
    check(`the Plugins page firing inject("${slot}") does not throw`, false, `${error.name}: ${error.message}`);
  }
}

const itemRegistration = settingsRegistrations.find((entry) => entry.options.name === 'plugins.item');
check('the settings page registers into the Plugins panel slot', itemRegistration !== undefined, settingsRegistrations.map((entry) => entry.options.name).join(', '));
check(
  'the page is keyed by the profile entry id the Host serves',
  itemRegistration?.options.id === 'hermes-panel',
  String(itemRegistration?.options.id),
);
check(
  'the page is labelled from its own dictionary, not the bundle title',
  itemRegistration?.options.label?.() === 'hermes-panel.settings#title',
  String(itemRegistration?.options.label?.()),
);
check('the page has a component', typeof itemRegistration?.component === 'function');

// The Plugins page declares three contribution slots, and the one a user lands
// on is the bundle's own page. Registering only `plugins.item` puts a card in
// the 官方 group while leaving that page looking unconfigured — which is exactly
// how it was reported.
const bundleConfig = settingsRegistrations.find((entry) => entry.options.name === 'plugins.bundle.config');
check('the form also registers on the bundle page slot', bundleConfig !== undefined, settingsRegistrations.map((entry) => entry.options.name).join(', '));
check(
  'keyed by the bundle package name, which is what that page looks up',
  bundleConfig?.options.key === BUNDLE,
  String(bundleConfig?.options.key),
);
check('the bundle form reuses the settings component', bundleConfig?.component === itemRegistration?.component);

const rowConfig = settingsRegistrations.find((entry) => entry.options.name === 'plugins.row.config');
check('the form also registers on the row page slot', rowConfig !== undefined, settingsRegistrations.map((entry) => entry.options.name).join(', '));
check(
  'keyed by bundle#rowId, the key the row page builds',
  rowConfig?.options.key === `${BUNDLE}#hermes-panel`,
  String(rowConfig?.options.key),
);

for (const [slot, registration] of [['plugins.bundle.config', bundleConfig], ['plugins.row.config', rowConfig]]) {
  const face = typeof registration?.options.inject === 'function' ? registration.options.inject() : null;
  check(
    `the ${slot} form injects the same form hook and actions`,
    typeof face?.hooks?.hermesForm?.getSnapshot === 'function'
      && ['edit', 'resetField', 'save', 'discard'].every((name) => typeof face?.[name] === 'function'),
    Object.keys(face ?? {}).join(', '),
  );
  // The bundle page renders the form body; the card renders the one-line summary.
  const body = typeof registration?.component === 'function' ? registration.component({ view: 'page' }) : null;
  check(`the ${slot} face renders the form for view=page`, body !== null && body !== undefined, String(body));
}

// Every field the Host validates must have a control, and no control may
// address a field the schema does not declare.
const schemaFields = Object.keys(Config?.dict ?? {}).sort();
const schemaKnown = schemaFields.length > 0;
const controlFields = [...(registeredFieldNames ?? [])].sort();
if (schemaKnown) {
  check(
    'the settings controls cover exactly the Host schema fields',
    schemaFields.join(',') === controlFields.join(','),
    `schema=[${schemaFields.join(', ')}] controls=[${controlFields.join(', ')}]`,
  );
} else {
  // No Schemastery here (bare checkout, no `npm install`): the Host declares no
  // schema, so there is nothing to compare the controls against. Reported.
  console.log('SKIP  the settings controls cover exactly the Host schema fields — no Schemastery here');
}

const injected = typeof itemRegistration?.options.inject === 'function' ? itemRegistration.options.inject() : null;
check('the page injects a form hook', typeof injected?.hooks?.hermesForm?.getSnapshot === 'function', Object.keys(injected?.hooks ?? {}).join(', '));
check(
  'the page injects the form actions',
  ['edit', 'resetField', 'save', 'discard'].every((name) => typeof injected?.[name] === 'function'),
  Object.keys(injected ?? {}).join(', '),
);

// The panel renders the same component twice: a one-line summary on the card,
// and the form itself inside the detail body.
const cardComponent = itemRegistration?.component;
let summary = null;
let page = null;
let renderError = null;
try {
  summary = cardComponent({ view: 'summary', t: (key) => key });
  page = cardComponent({
    view: 'page',
    t: (key) => key,
    useHermesForm: (selector) => selector({ ...fakeSnapshot, ...injected.hooks.hermesForm.getSnapshot() }),
    edit: injected.edit,
    resetField: injected.resetField,
    save: injected.save,
    discard: injected.discard,
  });
} catch (error) {
  renderError = error;
}
check('the card summary renders without throwing', renderError === null && typeof summary === 'string', renderError ? String(renderError.message) : String(summary));
check('the detail page renders a form', page?.type === fakePrimitives.SettingsForm, String(page?.type?.name ?? page?.type));
const rendered = Array.isArray(page?.children) ? page.children.flat(2) : [];
const controls = rendered.filter((child) => child?.type === fakePrimitives.SettingsValueField);
check(
  'the form renders one control per field',
  schemaKnown ? controls.length === schemaFields.length : controls.length > 0,
  schemaKnown ? `${controls.length} control(s)` : `${controls.length} control(s), nothing to compare against`,
);
check('every control is labelled and identified', controls.length > 0 && controls.every((control) => typeof control.props.label === 'string' && typeof control.props.id === 'string'), '');

// ---- the panel's health button and report --------------------------------
//
// The route is covered by `verify/health.mjs`; this covers the other half — that
// the panel offers the button, asks the route for it, and renders what came
// back. Defaults here are what the sidebar would have before any fetch lands,
// so the panel is rendered twice: once to find the button, once after the
// report arrives.

/**
 * Every element in a rendered tree, depth first.
 *
 * Function components are expanded the way React would. That is not a detail:
 * an earlier revision of the panel rendered raw `<button>` elements, and moving
 * to the app's shared `Button` would otherwise hide every control from a helper
 * that only ever looked for `type === 'button'`.
 */
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  out.push(node);
  if (typeof node.type === 'function') {
    let rendered = null;
    try {
      rendered = node.type(node.props);
    } catch {
      rendered = null;
    }
    if (rendered !== null && rendered !== undefined) collect(rendered, out);
  }
  for (const child of node.children ?? []) collect(child, out);
  return out;
}

/** The visible text of one rendered element, through its components. */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node.type === 'function') {
    let rendered = null;
    try {
      rendered = node.type(node.props);
    } catch {
      return '';
    }
    return textOf(rendered);
  }
  return textOf(node.children);
}

/**
 * A stand-in for cordis' `ctx.inject(deps, callback)`.
 *
 * The real one runs the callback when every named service EXISTS — which for
 * the right column is later than this plugin activates — and never if the
 * composition has none. Modelling that is the point: a stub that ran the
 * callback unconditionally would keep passing while the real panel stayed
 * empty, which is precisely what happened.
 *
 * @param ctx - the fake context the services are read from.
 * @returns that context, with `inject` attached.
 */
function withInject(ctx) {
  ctx.inject = (deps, callback) => {
    const scope = { ...ctx };
    for (const dep of deps) {
      const service = typeof ctx.get === 'function' ? ctx.get(dep) : undefined;
      if (service === undefined || service === null) return;
      scope[dep] = service;
    }
    callback(scope);
  };
  return ctx;
}

/**
 * Find a control by the word a reader sees OR the name a screen reader hears.
 *
 * Icon-only buttons are exactly that: their whole meaning is in `aria-label`, and
 * matching on text alone would make every one of them invisible to these tests.
 * @param tree - a collected element tree.
 * @param label - the expected word.
 * @returns the control, or undefined.
 */
const byLabel = (tree, label) => collect(tree).find((node) => node.type === 'button'
  && (textOf(node) === label || node.props?.['aria-label'] === label));

const panelInjections = new Map();
const panelRegistrations = [];
const panelExports = registration.factory((specifier) => {
  if (specifier === 'react') return fakeReact;
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
});
const panelCtx = {
  effect: (callback) => {
    const disposer = callback();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  slots: {
    inject(slot, callback) {
      panelInjections.set(slot, callback);
      return () => {};
    },
    register(options, component) {
      panelRegistrations.push({ options, component });
      return () => {};
    },
  },
};
withInject(panelCtx);
  panelExports.apply(panelCtx);

// The status poll kicked off by apply() resolves on the next microtask.
await new Promise((resolve) => setTimeout(resolve, 0));
panelInjections.get('main')?.();

const panelComponent = panelCtx.__hermesPanel.panel;
check('the panel component is registered under the main seat', typeof panelComponent === 'function');

const beforeTree = panelComponent();
// One button now: 「体检」 and 「检查更新」 were two side-by-side chores that are
// really one question, and one press asks it once.
const healthButton = byLabel(beforeTree, '检查');
check('the panel offers one Check button once Hermes is found', healthButton !== undefined, collect(beforeTree).filter((n) => n.type === 'button').map(textOf).join(' / '));

healthButton?.props?.onClick?.();
await new Promise((resolve) => setTimeout(resolve, 0));

check(
  'the one Check asks the health route',
  panelCalls.some((entry) => entry.url.endsWith('/hermes/api/health') && entry.method === 'GET'),
  panelCalls.map((entry) => `${entry.method} ${entry.url}`).join(', '),
);
check(
  'and the update route, in the same press',
  panelCalls.some((entry) => entry.url.endsWith('/hermes/api/update/check') && entry.method === 'POST'),
  panelCalls.map((entry) => `${entry.method} ${entry.url}`).join(', '),
);

const afterTree = panelComponent();
// The panel element tree holds `HealthReport` unrendered: this fake React draws
// nothing by itself, so the section is located by the props the panel handed it
// and then invoked once, the way a real renderer would.
const reportElement = collect(afterTree).find(
  (node) => typeof node.type === 'function' && node.props?.report === HEALTH_FIXTURE,
);
check('the panel hands the report to the health section', reportElement !== undefined, '');

const reportTree = reportElement === undefined ? null : reportElement.type(reportElement.props);
const elements = collect(reportTree);
const rows = elements.filter((node) => node.type === 'li');
check('the report renders one row per check', rows.length === 3, `${rows.length} row(s)`);

const failDot = elements
  .filter((node) => node.type === 'span')
  .find((node) => node.props?.className === 'hp-dot' && node.props?.style?.background === 'var(--dsw-alias-state-error-primary)');
check('a FAIL check uses the error colour', failDot !== undefined, failDot ? 'found' : 'missing');

const summaryText = textOf(reportTree);
check('the summary counts are shown', summaryText.includes('FAIL 1') && summaryText.includes('OK 1'), summaryText.slice(0, 120));

const hideButton = elements.find((node) => node.type === 'button' && textOf(node) === '收起');
hideButton?.props?.onClick?.();
const stillReported = collect(panelComponent()).some(
  (node) => typeof node.type === 'function' && node.props?.report === HEALTH_FIXTURE,
);
check('the report can be dismissed', stillReported === false, stillReported ? 'still present' : 'dismissed');

// ---- the upgrade panel, which the one Check button also fills ---------------
check(
  'the Check button also fills the upgrade panel',
  collect(panelComponent()).some((node) => node.type === 'button' && (textOf(node) === '检查' || node.props?.['aria-label'] === '检查')),
  collect(panelComponent()).filter((n) => n.type === 'button').map(textOf).join(' / '),
);
check(
  'and there is no second button for it',
  collect(panelComponent()).every((node) => !(node.type === 'button' && (textOf(node) === '检查更新' || node.props?.['aria-label'] === '检查更新'))),
  collect(panelComponent()).filter((n) => n.type === 'button').map(textOf).join(' / '),
);

const updateElement = collect(panelComponent()).find(
  (node) => typeof node.type === 'function' && node.props?.report === UPDATE_REPORT,
);
check('the panel hands the report to the update section', updateElement !== undefined, '');

const updateTree = updateElement === undefined ? null : updateElement.type(updateElement.props);
const upgradeButton = collect(updateTree).find((node) => node.type === 'button' && textOf(node).startsWith('升级到'));
check('an available upgrade offers its version', textOf(upgradeButton) === '升级到 0.20.0', textOf(upgradeButton));
check(
  'the copy warns that Hermes stops first',
  textOf(updateTree).includes('升级会先停止 Hermes'),
  textOf(updateTree).slice(0, 80),
);

// The first press only arms the upgrade: nothing may reach the apply route yet.
upgradeButton?.props?.onClick?.();
check(
  'the first press does not start the upgrade',
  !panelCalls.some((entry) => entry.url.endsWith('/update/apply')),
  panelCalls.map((entry) => entry.url).join(', '),
);

const confirmedElement = collect(panelComponent()).find(
  (node) => typeof node.type === 'function' && node.props?.report === UPDATE_REPORT && node.props?.confirm === true,
);
const confirmedTree = confirmedElement === undefined ? null : confirmedElement.type(confirmedElement.props);
const goButton = byLabel(confirmedTree, '确认升级');
check('the second press is a distinct confirm step', goButton !== undefined, collect(confirmedTree).filter((n) => n.type === 'button').map(textOf).join(' / '));
check('the confirm step can be cancelled', collect(confirmedTree).some((node) => node.type === 'button' && textOf(node) === '取消'), '');

goButton?.props?.onClick?.();
await new Promise((resolve) => setTimeout(resolve, 0));
check(
  'confirming starts the upgrade',
  panelCalls.some((entry) => entry.url.endsWith('/hermes/api/update/apply') && entry.method === 'POST'),
  panelCalls.map((entry) => `${entry.method} ${entry.url}`).join(', '),
);

// ---- the DSH bridge section ------------------------------------------------
//
// Both halves are reported independently, and the DSH half carries the exact
// command that fixes a version drift — which is the failure this machine was
// actually in, and the one a single "connected" light would have hidden.

{
  const bridgeInjections = new Map();
  const bridgeRegistrations = [];
  const bridgeTabTypes = [];
  const bridgeExports = registration.factory((specifier) => {
    if (specifier === 'react') return fakeReact;
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
  });
  // A locale service, so the branch that actually runs in production is
  // exercised. Every other block in this file applies WITHOUT one, which covers
  // only the Chinese fallback: the bound translator would otherwise never be
  // called, and the panel would look translated while never being tested in the
  // language the market defaults to.
  const localeDictionaries = new Map();
  let localeBound = null;
  const fakeLocale = {
    register(namespace, dictionary) {
      localeDictionaries.set(namespace, dictionary);
      return () => {};
    },
    bind(namespace) {
      localeBound = namespace;
      const dictionary = localeDictionaries.get(namespace) ?? { zh: {}, en: {} };
      // English, as a non-Chinese browser would get.
      return (key, params) => {
        const template = dictionary.en[key] ?? dictionary.zh[key] ?? key;
        if (params === undefined) return template;
        return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
      };
    },
    getSnapshot: () => ({ revision: 0 }),
  };

  // Kept by name so the record tests below can drive THIS instance's store: the
  // panel exposes it on the context, and every `factory(...)` call builds its
  // own store, so reaching into another scenario's would read an empty one.
  let pickerCalls = 0;
  const bridgeCtx = {
    effect: (callback) => {
      const disposer = callback();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get: (name) => {
      if (name === 'locale') return fakeLocale;
      // DSH's own directory picker. Providing it is the point of the check below: the
      // plugin must ask this rather than spawn a modal PowerShell dialog of its own,
      // which is what hung the panel on 「等待选择…」 for five minutes.
      if (name === 'uiWorkspace') {
        return {
          pickDirectory: async () => {
            pickerCalls += 1;
            return 'E:\\picked-by-dsh';
          },
        };
      }
      // The right column. The record's real home is the tab, so this scenario
      // provides the two services that register one.
      if (name === 'sidebarRightTabs') return { register: (definition) => { bridgeTabTypes.push(definition); return () => {}; } };
      if (name === 'sidebarRight') {
        return { commandTarget: () => ({ paneId: 'p1', host: 'dock' }), openTabFromTarget: () => {} };
      }
      return undefined;
    },
    slots: {
      inject(slot, callback) {
        bridgeInjections.set(slot, callback);
        return () => {};
      },
      register(options, component) {
        bridgeRegistrations.push({ options, component });
        return () => {};
      },
    },
  };
  withInject(bridgeCtx);
  bridgeExports.apply(bridgeCtx);
  await new Promise((resolve) => setTimeout(resolve, 0));

  check('the panel dictionary is registered with the locale service', localeDictionaries.has('hermes-panel.panel'), [...localeDictionaries.keys()].join(', '));
  check(
    'the registered dictionary carries both languages',
    localeDictionaries.get('hermes-panel.panel')?.zh?.['bridge.title'] === 'DSH 桥'
      && localeDictionaries.get('hermes-panel.panel')?.en?.['bridge.title'] === 'DSH bridge',
    JSON.stringify(localeDictionaries.get('hermes-panel.panel')?.en?.['bridge.title']),
  );
  check('the translator is bound to that namespace', localeBound === 'hermes-panel.panel', String(localeBound));

  bridgeInjections.get('sidebar.right.pane.tab')?.();
  // The record is a MODE of the dashboard tab now, so the tests reach it the way
  // the button does — through the store — rather than through a tab of its own.
  const recordsTab = bridgeRegistrations.find((entry) => entry.options.name === 'sidebar.right.pane.tab')?.component;
  bridgeCtx.__hermesPanel.toggleRecords();

  // The panel is reached through the test seam now: nothing registers it into a slot.
  const bridgePanel = bridgeCtx.__hermesPanel.panel;
  const englishButtons = collect(bridgePanel()).filter((n) => n.type === 'button').map(textOf);
  const toggle = byLabel(bridgePanel(), 'DSH bridge');
  check('the panel renders English through the bound translator', toggle !== undefined, englishButtons.join(' / '));

  // No raw keys on screen.
  //
  // A key defined in the WRONG dictionary passes the "every key exists" check above,
  // because that check looks at the whole file rather than at the dictionary the
  // calling `t` is bound to — so `t('directories.title')` rendered as the literal text
  // `directories.title` in the panel while every test stayed green. Only a browser
  // caught it. This is the browser's part, written down: an untranslated key has a
  // shape, and it should never reach a rendered node.
  //
  // Only leaf strings are inspected. Concatenating a tree loses the boundaries between
  // nodes, and `shared` + `AGENTS.md` reads exactly like a key.
  const leafText = collect(bridgePanel())
    .map((node) => node.props?.children)
    .filter((child) => typeof child === 'string');
  const rawKeys = [...new Set(leafText.flatMap((text) => text.match(/\b[a-z][a-zA-Z]*\.[a-zA-Z]{2,}/g) ?? []))]
    // `AGENTS.md`, `config.yaml`, `dsh_mcp_server.py` and friends are file names, not keys.
    .filter((candidate) => !/\.(md|yaml|yml|py|exe|json|log|txt|bat|ps1|js|mjs)$/i.test(candidate));
  check(
    'and no untranslated key reaches the screen',
    rawKeys.length === 0,
    rawKeys.join(', '),
  );

  toggle?.props?.onClick?.();
  const section = collect(bridgePanel()).find(
    (node) => typeof node.type === 'function' && node.props?.status?.dshRoot === 'E:\\Harness\\dsh',
  );
  check('the bridge section opens with the status', section !== undefined, '');

  const sectionTree = section?.type(section.props);
  const sectionText = textOf(sectionTree);
  check('the Hermes half reports pointing elsewhere', sectionText.includes('pointing somewhere else'), sectionText.slice(0, 60));
  check('the DSH half names the mismatched profile', sectionText.includes('web') && sectionText.includes('0.1.0-rc.8'), '');
  check('the fix uses the running version', sectionText.includes('@deepseek-ai/dsh-mcp-client@0.2.0-rc.2'), '');
  check('the fix is per profile', sectionText.includes('dsh plugin --profile web add'), '');

  const applyButton = byLabel(sectionTree, 'Use the shipped copy');
  check('the Hermes half offers the rewrite', applyButton !== undefined, collect(sectionTree).filter((n) => n.type === 'button').map(textOf).join(' / '));

  applyButton?.props?.onClick?.();
  check(
    'the rewrite needs a second confirming press',
    !panelCalls.some((entry) => entry.url.endsWith('/bridge/apply')),
    panelCalls.map((entry) => entry.url).join(', '),
  );
  const armed = collect(bridgePanel()).find(
    (node) => typeof node.type === 'function' && node.props?.status?.dshRoot === 'E:\\Harness\\dsh' && node.props?.confirm === true,
  );
  const armedTree = armed?.type(armed.props);
  const goButton = byLabel(armedTree, 'Write it');
  check('the confirming press is offered', goButton !== undefined, collect(armedTree).filter((n) => n.type === 'button').map(textOf).join(' / '));
  check('the warning says the config is backed up', textOf(armedTree).includes('backed up'), '');

  goButton?.props?.onClick?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(
    'confirming asks the Host to write the bridge',
    panelCalls.some((entry) => entry.url.endsWith('/hermes/api/bridge/apply') && entry.method === 'POST'),
    panelCalls.map((entry) => `${entry.method} ${entry.url}`).join(', '),
  );

  // ---- the shared workspace section, inside the same opened panel ----------
  const workspaceSection = collect(bridgePanel()).find(
    (node) => typeof node.type === 'function' && node.props?.status?.path === 'E:\\shared',
  );
  check('the panel shows the shared workspace', workspaceSection !== undefined, '');

  const workspaceTree = workspaceSection?.type(workspaceSection.props);
  const workspaceText = textOf(workspaceTree);
  // The section used to be five `label: value` rows plus a paragraph plus two
  // buttons. It is now a path and three marks — and each mark carries its full
  // sentence as a tooltip rather than as a line of its own. So the state is
  // asserted on the titles, which is where it lives now.
  const marks = collect(workspaceTree).filter((node) => node.type === 'span' && /hp-mark(?!-)/.test(node.props?.className ?? ''));
  check('the workspace reports three marks', marks.length === 3, marks.map((m) => textOf(m)).join(' / '));
  check(
    'it names AGENTS.md, the Hermes cwd and the sidebar',
    workspaceText.includes('AGENTS.md') && workspaceText.includes('Hermes cwd') && workspaceText.includes('sidebar'),
    workspaceText.slice(0, 140),
  );
  check(
    'and carries the state in the tooltip, not in a row of its own',
    marks.some((m) => String(m.props?.title ?? '').includes('absent'))
      && marks.some((m) => String(m.props?.title ?? '').includes('terminal.cwd is not set')),
    marks.map((m) => m.props?.title).join(' | ').slice(0, 160),
  );
  check(
    'the section no longer explains itself in a paragraph',
    !workspaceText.includes('dsh-agent-instructions'),
    workspaceText.slice(0, 140),
  );

  // The volume, and what is in it. `dataDir` cannot be validated by reading it — a
  // right path and a wrong path look identical in a text box — so the section prints
  // the evidence, and this is what keeps that line from silently going blank.
  const volumeLine = collect(workspaceTree).find((node) => /hp-volume-detail/.test(node.props?.className ?? ''));
  check('the workspace reports what is in the data volume', volumeLine !== undefined, workspaceText.slice(0, 140));
  check(
    'and names the profile it found',
    textOf(volumeLine).includes('companion'),
    textOf(volumeLine),
  );
  check(
    'and says whether official-web came with it',
    textOf(volumeLine).includes('official-web'),
    textOf(volumeLine),
  );

  const createButton = byLabel(workspaceTree, 'Create and point here');
  check('it offers to create and point', createButton !== undefined, collect(workspaceTree).filter((n) => n.type === 'button').map(textOf).join(' / '));

  createButton?.props?.onClick?.();
  check(
    'the workspace write needs a confirming press',
    !panelCalls.some((entry) => entry.url.endsWith('/workspace/apply')),
    panelCalls.map((entry) => entry.url).join(', '),
  );

  const armedWorkspace = collect(bridgePanel()).find(
    (node) => typeof node.type === 'function' && node.props?.status?.path === 'E:\\shared' && node.props?.confirm === true,
  );
  const armedWorkspaceTree = armedWorkspace?.type(armedWorkspace.props);
  check(
    'the confirming press warns it edits config.yaml',
    textOf(armedWorkspaceTree).includes('config.yaml') && textOf(armedWorkspaceTree).includes('AGENTS.md'),
    '',
  );

  const workspaceGo = byLabel(armedWorkspaceTree, 'Write it');
  check('the workspace confirming press is offered', workspaceGo !== undefined, '');
  workspaceGo?.props?.onClick?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(
    'confirming asks the Host to set the workspace up',
    panelCalls.some((entry) => entry.url.endsWith('/hermes/api/workspace/apply') && entry.method === 'POST'),
    panelCalls.map((entry) => `${entry.method} ${entry.url}`).join(', '),
  );

  // ---- picking the directory instead of typing it --------------------------
  //
  // The picker has to run on the Host: a browser hides absolute paths, so
  // `<input type="file" webkitdirectory>` cannot return one.
  const pickButton = byLabel(workspaceTree, 'Choose folder…');
  check('the workspace offers a directory picker', pickButton !== undefined, collect(workspaceTree).filter((n) => n.type === 'button').map(textOf).join(' / '));

  // The picker asks DSH, and NOT the plugin's own route. That route opened a modal
  // WinForms dialog from a process with no window — it could come up behind
  // everything, and the panel waited on 「等待选择…」 for the whole timeout either way.
  const callsBeforePick = panelCalls.length;
  pickButton?.props?.onClick?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('the picker asks DSH for the directory', pickerCalls === 1, String(pickerCalls));
  check(
    'and never spawns a modal dialog of its own',
    !panelCalls.slice(callsBeforePick).some((entry) => entry.url.endsWith('/pick-directory')),
    panelCalls.slice(callsBeforePick).map((entry) => `${entry.method} ${entry.url}`).join(', '),
  );

  // An unconfigured workspace must offer the picker too — it is the only way to
  // set one without typing, and it is the FIRST thing a new user sees.
  const unconfiguredTree = workspaceSection?.type({
    ...workspaceSection.props,
    status: { ...workspaceSection.props.status, configured: false, path: null, contextExists: false, hermesPointsHere: null },
  });
  check(
    'an unconfigured workspace offers the picker rather than only a hint',
    collect(unconfiguredTree).some((node) => node.type === 'button' && textOf(node) === 'Choose folder…'),
    collect(unconfiguredTree).filter((n) => n.type === 'button').map(textOf).join(' / '),
  );

  // ---- the Hermes ↔ DSH record -------------------------------------------
  //
  // The directory and its AGENTS.md are the shared *context*; an exchange leaves
  // its trace in DSH's session log, so the record is a read of the session
  // corpus filtered by cwd. Its home is the RIGHT COLUMN, not this panel: the
  // panel replaces the DSH view while it is open, so a record kept inside it is
  // one you have to leave your own conversation to read. These checks cover the
  // tab, and pin that the panel no longer carries a second copy.

  check(
    'the workspace reports whether the sidebar lists it',
    marks.some((m) => String(m.props?.title ?? '').includes('listed')),
    marks.map((m) => m.props?.title).join(' | ').slice(0, 160),
  );
  check(
    'the panel itself no longer carries the record',
    !workspaceText.includes('Show the exchange') && !workspaceText.includes('Hide the record'),
    workspaceText.slice(-140),
  );

  const callsBeforeRecords = panelCalls.length;
  await bridgeCtx.__hermesPanel.loadRecords();
  check(
    'reading the record asks the sessions route',
    panelCalls.slice(callsBeforeRecords).some((entry) => entry.url.endsWith('/hermes/api/workspace/sessions') && entry.method === 'GET'),
    panelCalls.slice(callsBeforeRecords).map((entry) => `${entry.method} ${entry.url}`).join(', '),
  );

  // Switching to the record should land on the exchange, not on a list of it: the
  // list answers "how many" and the reader came for "what did they say".
  await bridgeCtx.__hermesPanel.openNewestRecord();
  const autoOpened = bridgeCtx.__hermesPanel.getState().sessionOpen;
  check('opening the record opens the newest exchange', autoOpened !== null, String(autoOpened));
  // The checks below press the row themselves, which TOGGLES — so put it back
  // first, or every one of them would be closing the thing it means to open.
  if (autoOpened !== null) await bridgeCtx.__hermesPanel.toggleSession(autoOpened);

  const listedTree = recordsTab();
  const listedText = textOf(listedTree);
  check('the record lists the session', listedText.includes('Hermes：改 README'), listedText.slice(-200));
  check('and says how many there are', listedText.includes('1 session record'), listedText.slice(-200));

  const sessionRow = collect(listedTree).find((node) => node.type === 'button' && textOf(node).includes('Hermes：改 README'));
  check('the session row is openable', sessionRow !== undefined, '');

  // Pressing the row TOGGLES, so this is the press that opens it again. The
  // transcript itself was read once already — by the auto-open — and the store
  // caches it, so the route is asserted over the whole run rather than the tail.
  sessionRow?.props?.onClick?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(
    'expanding a record reads that session',
    panelCalls.some((entry) => entry.url.includes('/hermes/api/workspace/session?id=session-in') && entry.method === 'GET'),
    panelCalls.filter((entry) => entry.url.includes('/workspace/session')).map((entry) => entry.url).join(', '),
  );

  const expandedText = textOf(recordsTab());
  check('the turn is labelled as coming from Hermes', expandedText.includes('Hermes → DSH'), expandedText.slice(-260));
  check('and the answer as coming from DSH', expandedText.includes('DSH → Hermes'), expandedText.slice(-260));
  check('it shows the task text', expandedText.includes('把 README 的安装命令改对'), '');
  check(
    'it names the tools that were called, without the call payload',
    expandedText.includes('str_replace_editor') && !expandedText.includes('{"path":"README.md"}'),
    expandedText.slice(-220),
  );
  check('and folds them into a count rather than one block each', /\d+ tool call\(s\)/.test(expandedText), expandedText.slice(-220));
  check('a failed tool result is surfaced on the turn', expandedText.includes('some of them failed'), expandedText.slice(-220));

  // ---- "配置好就自动注册" -------------------------------------------------
  //
  // The Host reports the directory as existing but unlisted; the next poll must
  // register it without a second press, and must not ask twice afterwards.

  const registrationsBefore = panelCalls.filter((entry) => entry.url.endsWith('/workspace/register')).length;
  panelStatus = { ...STATUS_FIXTURE, workspace: { ...STATUS_FIXTURE.workspace, registered: false, needsRegistration: true } };
  // The poll's own read, driven directly: waiting on POLL_MS would be slow and
  // flaky, and this is the same call the timer makes.
  await panelCtx.__hermesPanel.refresh();
  const registrationsAfter = panelCalls.filter((entry) => entry.url.endsWith('/workspace/register')).length;
  check(
    'an unlisted but existing directory is registered automatically',
    registrationsAfter === registrationsBefore + 1,
    `${registrationsBefore} -> ${registrationsAfter}`,
  );

  const autoTree = collect(bridgePanel()).find((node) => typeof node.type === 'function' && node.props?.status?.path === 'E:\\shared');
  check(
    'the panel then reports it as listed',
    collect(autoTree?.type(autoTree.props)).some((node) => String(node.props?.title ?? '').includes('listed')),
    collect(autoTree?.type(autoTree.props)).map((n) => n.props?.title).filter(Boolean).join(' | ').slice(0, 160),
  );

  panelStatus = STATUS_FIXTURE;
  await panelCtx.__hermesPanel.refresh();
  check(
    'a later poll does not register it again',
    panelCalls.filter((entry) => entry.url.endsWith('/workspace/register')).length === registrationsAfter,
    String(panelCalls.filter((entry) => entry.url.endsWith('/workspace/register')).length),
  );
}

// A settings page that cannot mount must not take the panel with it: this is
// the same all-or-nothing boot rule the Host half defends against, one layer up.
const brokenRegistrations = [];
const brokenCtx = {
  effect: (callback) => {
    const disposer = callback();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  get: settingsCtx.get,
  slots: {
    inject: (slot, callback) => {
      callback();
      return () => {};
    },
    register(options) {
      brokenRegistrations.push(options.name);
      return () => {};
    },
  },
};
const brokenExports = registration.factory((specifier) => {
  if (specifier === 'react') return fakeReact;
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      ...fakePrimitives,
      SettingsFormModel: class {
        constructor() {
          throw new Error('simulated primitive mismatch');
        }
      },
    };
  }
  throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
});
let brokenError = null;
const realWarn = console.warn;
console.warn = () => {};
try {
  withInject(brokenCtx);
  brokenExports.apply(brokenCtx);
} catch (error) {
  brokenError = error;
} finally {
  console.warn = realWarn;
}
check('a broken settings page does not fail apply()', brokenError === null, brokenError ? `${brokenError.name}: ${brokenError.message}` : '');
check(
  'and it still claims nothing in the left sidebar',
  brokenRegistrations.every((name) => !['main', 'sidebar.panellist'].includes(name)),
  brokenRegistrations.join(', '),
);

// ---- localization ----------------------------------------------------------
//
// DSH's own client packages ship two languages and pick between them at runtime,
// so a panel whose text is Chinese-only is a departure from the platform rather
// than a style choice. These checks hold the two halves of that apart:
//
//   - every user-visible string lives in a dictionary, so nothing can quietly
//     stay untranslated;
//   - the two dictionaries carry the same keys, because a key missing from one
//     language renders as the key itself;
//   - no dictionary value calls `t`. That is not hypothetical: the pass that
//     moved the strings into the dictionary ran over the dictionary too, and
//     every value became a call to itself (`'common.cancel': t('common.cancel')`)
//     — a self-reference that only fails at render time.

{
  const CJK = /[\u4e00-\u9fff]/;
  // Split on either ending: a Windows checkout with `core.autocrlf=true` hands this
  // file CRLF, and the `line === '    };'` terminator below then never matches — the
  // dictionary region swallowed the rest of the file, and the two checks that scan it
  // started reading code instead. They failed on Windows CI and passed on the machine
  // this was written on, which was the entire difference between the two.
  const sourceLines = source.split(/\r?\n/);

  // ---- no translation key is asked for without existing --------------------
  //
  // Two were: `common.listSeparator`, used to join the workspace result and the
  // tool summary, and the settings card's own `title`. Both rendered as the key
  // itself, and nothing caught it — the dictionaries were checked for parity
  // between languages and for not calling functions, but never against what the
  // code actually asks for.
  const asked = new Set([...source.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)].map((match) => match[1]));
  const defined = new Set([...source.matchAll(/'([a-zA-Z][\w.]*)':\s*'/g)].map((match) => match[1]));
  const undefinedKeys = [...asked].filter((key) => !defined.has(key)).sort();
  check(
    'every translation key the code asks for exists',
    undefinedKeys.length === 0,
    undefinedKeys.length === 0 ? `${asked.size} key(s)` : `missing: ${undefinedKeys.join(', ')}`,
  );

  /** Line ranges of the dictionary regions, which are the translation itself. */
  const regions = [];
  let opened = null;
  sourceLines.forEach((line, index) => {
    if (line.includes('//#region panel-dictionaries') || line.includes('//#region settings-dictionaries')) opened = index;
    if (opened !== null && line.includes('//#endregion')) {
      regions.push([opened, index]);
      opened = null;
    }
  });
  const inRegion = (line) => regions.some(([from, to]) => line >= from && line <= to);
  check('both dictionaries are marked as regions', regions.length === 2, JSON.stringify(regions));

  const stray = [];
  const LITERAL = /'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  sourceLines.forEach((line, index) => {
    if (inRegion(index)) return;
    const trimmed = line.trimStart();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
    for (const match of line.matchAll(LITERAL)) {
      if (CJK.test(match[0])) stray.push(`${index + 1}: ${match[0].slice(0, 40)}`);
    }
  });
  check(
    'no user-visible string is left untranslated',
    stray.length === 0,
    stray.length === 0 ? 'all strings come from a dictionary' : `${stray.length}: ${stray.slice(0, 3).join(' | ')}`,
  );

  /** Pull one `const NAME = { zh: {...}, en: {...} };` out of the source. */
  const readDictionary = (name) => {
    const from = sourceLines.findIndex((line) => line.includes(`const ${name} = {`));
    if (from === -1) return null;
    const body = [];
    for (let index = from; index < sourceLines.length; index += 1) {
      body.push(sourceLines[index]);
      if (sourceLines[index] === '    };') break;
    }
    return body.join('\n');
  };

  for (const name of ['PANEL_COPY', 'SETTINGS_COPY']) {
    const text = readDictionary(name);
    check(`${name} is defined`, text !== null, name);
    if (text === null) continue;
    const html = text.replace(/\/\/.*$/gm, '');
    const keysOf = (lang) => {
      const block = new RegExp(`\\b${lang}: \\{([\\s\\S]*?)\\n      \\}`).exec(html);
      if (block === null) return null;
      return [...block[1].matchAll(/^\s*'?([A-Za-z][\w.]*)'?:\s*(.+?),?$/gm)].map((match) => match[1]);
    };
    const zh = keysOf('zh');
    const en = keysOf('en');
    check(`${name} declares both languages`, zh !== null && en !== null, `${zh?.length ?? 0} zh / ${en?.length ?? 0} en`);
    if (zh === null || en === null) continue;
    check(`${name} has a real number of keys`, zh.length > 10, String(zh.length));
    const missingInEn = zh.filter((key) => !en.includes(key));
    const missingInZh = en.filter((key) => !zh.includes(key));
    check(
      `${name} keys match across languages`,
      missingInEn.length === 0 && missingInZh.length === 0,
      missingInEn.length + missingInZh.length === 0 ? `${zh.length} keys` : `en missing ${missingInEn.join(', ')}; zh missing ${missingInZh.join(', ')}`,
    );
    check(
      `${name} values are strings, not calls`,
      !/:\s*t\(/.test(html) && !/:\s*[a-zA-Z]+\(/.test(html),
      /:\s*(t|[a-zA-Z]+)\(/.test(html) ? 'a value calls something — a dictionary cannot translate itself' : '',
    );
    const empty = [...html.matchAll(/:\s*(''|"")\s*,?/g)];
    check(`${name} has no empty values`, empty.length === 0, String(empty.length));
  }

  // The panel must render without a locale service: `apply` is a soft lookup, and
  // the zh dictionary is the fallback. This runs the same components the earlier
  // checks did, with `panelTranslate` still null.
  check('the panel renders its fallback copy with no locale service', source.includes('PANEL_COPY.zh[key] ?? key'), '');
}

// ---- the panel renders through the app's own components --------------------
//
// The panel used to hand-roll every control. It now uses the shared Button,
// StateDot, Tag and PathLabel, which is what makes it read as part of the app
// rather than a widget sitting inside it — and those are a SOFT dependency, so
// the fallbacks have to keep working too. Both halves are pinned here:
//
//   - statically, that no raw `<button>` has crept back in;
//   - behaviourally, that a module table which DOES carry the components has
//     them adopted rather than ignored.

{
  const rawButtons = source.split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => /\bh\('button'/.test(line));
  check(
    'no control is hand-rolled any more',
    rawButtons.length === 0,
    rawButtons.map(({ index, line }) => `${index}: ${line.trim().slice(0, 60)}`).join(' | ') || 'all controls come from the shared set',
  );

  const shared = {
    // A real Button renders its `icon` too, so the stand-in has to as well or
    // the icon assertions would be testing the stub instead of the panel.
    Button: (props) => fakeReact.createElement('button', {
      className: 'shared-button',
      disabled: props.disabled,
      onClick: props.onClick,
      // The real Button puts these on the element; an icon-only control carries
      // its whole meaning in them, so dropping them here would hide it.
      title: props.title,
      'aria-label': props['aria-label'],
    }, props.icon, props.children),
    StateDot: () => fakeReact.createElement('span', { className: 'shared-dot' }),
    Tag: (props) => fakeReact.createElement('span', { className: 'shared-tag' }, props.children),
    PathLabel: (props) => fakeReact.createElement('code', { className: 'shared-path' }, props.path),
    TextShimmer: (props) => fakeReact.createElement('span', { className: 'shared-shimmer' }, props.children),
    IconPlayOutlineMedium: () => fakeReact.createElement('svg', { className: 'shared-icon-play' }),
    IconStopFillMedium: () => fakeReact.createElement('svg', { className: 'shared-icon-stop' }),
    IconRefreshOutlineMedium: () => fakeReact.createElement('svg', { className: 'shared-icon-refresh' }),
    IconGaugeOutlineMedium: () => fakeReact.createElement('svg', { className: 'shared-icon-gauge' }),
    IconDownloadOutlineMedium: () => fakeReact.createElement('svg', { className: 'shared-icon-download' }),
    IconLinkOutlineMedium: () => fakeReact.createElement('svg', { className: 'shared-icon-link' }),
    IconCloseOutlineMedium: () => fakeReact.createElement('svg', { className: 'shared-icon-close' }),
    IconFolderOpenOutlineMedium: () => fakeReact.createElement('svg', { className: 'shared-icon-folder' }),
  };

  const adoptedExports = registration.factory((specifier) => {
    if (specifier === 'react') return fakeReact;
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return shared;
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
  });
  const adoptedInjections = new Map();
  const adopted = [];
  const adoptedCtx = withInject({
    effect: (callback) => { callback(); return () => {}; },
    slots: {
      inject: (slot, callback) => { adoptedInjections.set(slot, callback); return () => {}; },
      register: (options, component) => { adopted.push({ options, component }); return () => {}; },
    },
  });
  adoptedExports.apply(adoptedCtx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Nothing claims `main` now; the panel comes from the seam.
  const adoptedPanel = adoptedCtx.__hermesPanel.panel;
  const tree = collect(adoptedPanel());
  check('the shared Button is adopted when the module table carries it', tree.some((node) => node.props?.className === 'shared-button'), '');
  check('the shared StateDot is adopted too', tree.some((node) => node.props?.className === 'shared-dot'), '');
  check(
    'icons come from the shared icon set',
    tree.some((node) => typeof node.props?.className === 'string' && node.props.className.startsWith('shared-icon-')),
    '',
  );
  check(
    'the fallbacks stay available for a module table without them',
    source.includes('const FALLBACK_UI = {') && source.includes('const ui = { ...FALLBACK_UI };'),
    '',
  );
}

// ---- the exchange record as a right-sidebar tab ----------------------------
//
// The panel replaces the DSH view while it is open, so watching what Hermes and
// DSH say to each other meant leaving the conversation you were watching it
// from. The record is therefore also published as a tab in DSH's right column —
// beside 工作区文件 and 新建终端 — and these checks pin that contract:
//
//   - the right sidebar's tabs are *providers*: `sidebarRightTabs.register`
//     with a `guide` entry is what makes the row appear at all;
//   - the body and title are ordinary slot registrations keyed by that kind;
//   - and all of it is soft — every other scenario in this file applies with no
//     such service, and must stay green.

{
  const tabTypes = [];
  const rightInjections = new Map();
  const rightSlots = [];
  const rightCalls = { commandTarget: 0, opened: null, isExpanded: 0, toggleExpanded: 0 };
  let rightExpanded = false;
  const rightExports = registration.factory((specifier) => {
    if (specifier === 'react') return fakeReact;
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
  });
  const rightCtx = withInject({
    effect: (callback) => { const disposer = callback(); return typeof disposer === 'function' ? disposer : () => {}; },
    get: (name) => {
      if (name === 'sidebarRightTabs') return { register: (definition) => { tabTypes.push(definition); return () => {}; } };
      if (name === 'sidebarRight') {
        return {
          // The layout's own toggle command passes `null` here on purpose: it
          // skips live DOM focus and falls back to the session on screen, which
          // is exactly what lets a left-sidebar panel reach the right column.
          commandTarget: (element) => { rightCalls.commandTarget += 1; rightCalls.element = element; return { paneId: 'p1', host: 'dock' }; },
          openTabFromTarget: (kind, target) => { rightCalls.opened = { kind, target }; },
          // `isExpanded`/`toggleExpanded` are what make the button work at all:
          // a tab opened into a COLLAPSED column is on screen nowhere.
          isExpanded: () => { rightCalls.isExpanded += 1; return rightExpanded; },
          toggleExpanded: () => { rightCalls.toggleExpanded += 1; rightExpanded = !rightExpanded; },
        };
      }
      return undefined;
    },
    slots: {
      inject: (slot, callback) => { rightInjections.set(slot, callback); return () => {}; },
      register: (options, component) => { rightSlots.push({ options, component }); return () => {}; },
    },
  });
  rightExports.apply(rightCtx);
  await new Promise((resolve) => setTimeout(resolve, 0));

  // One now. The exchange record used to hold a row of its own here; it is a mode
  // of the dashboard tab instead, so the ⊕ list has one Hermes entry and no more.
  check('the right column registers one tab type', tabTypes.length === 1, `${tabTypes.length} type(s): ${tabTypes.map((t) => t.kind).join(', ')}`);
  const dashType = tabTypes.find((entry) => entry.kind === 'hermes-dashboard');
  check('and it is the dashboard', dashType !== undefined, String(dashType?.kind));
  check(
    'the record no longer has a guide row of its own',
    !tabTypes.some((entry) => entry.kind === 'hermes-records'),
    tabTypes.map((t) => t.kind).join(
),
  );
  check(
    'the dashboard row is what the ⊕ list opens',
    dashType?.guide?.[0]?.title?.() === '打开 Hermes' && String(dashType?.guide?.[0]?.description?.()).includes('Hermes'),
    String(dashType?.guide?.[0]?.title?.()),
  );
  check('it is declared single-instance', dashType?.multiple === false, String(dashType?.multiple));
  check('it titles itself from the dictionary', dashType?.title?.() === 'Hermes', String(dashType?.title?.()));
  check('it publishes exactly one guide row', Array.isArray(dashType?.guide) && dashType.guide.length === 1, String(dashType?.guide?.length));
  check(
    'and the guide row carries the tooltip too',
    typeof dashType?.guide?.[0]?.description?.() === 'string' && dashType.guide[0].description().length > 0,
    String(dashType?.guide?.[0]?.description?.()),
  );

  rightInjections.get('sidebar.right.pane.tab')?.();
  rightInjections.get('sidebar.right.pane.tab.title')?.();
  check(
    'the tab body registers into the right sidebar',
    rightSlots.some((entry) => entry.options.name === 'sidebar.right.pane.tab' && entry.options.key === 'hermes-dashboard'),
    rightSlots.map((entry) => entry.options.name).join(', '),
  );
  check(
    'the tab title registers too',
    rightSlots.some((entry) => entry.options.name === 'sidebar.right.pane.tab.title' && entry.options.key === 'hermes-dashboard'),
    '',
  );

  // It must render before anything is configured, or the column is blank on a
  // fresh deployment.
  const body = rightSlots.find((entry) => entry.options.name === 'sidebar.right.pane.tab')?.component;
  let bodyError = null;
  let rendered = null;
  try {
    rendered = body?.({});
  } catch (error) {
    bodyError = error;
  }
  check('the tab body renders before anything is configured', bodyError === null, bodyError ? `${bodyError.name}: ${bodyError.message}` : '');
  check('and it draws the tab body', rendered !== null && rendered !== undefined, '');

  // ---- no second control for the right column -----------------------------
  //
  // There was one, twice. Both could not work, and the second time there was
  // proof: driving the real browser and pressing it produced, from the live
  // console —
  //
  //     Error: sidebarRight: no session surface is mounted
  //
  // The whole `sidebarRight` API is gated on `mounted = sessions.onScreen`, and
  // opening this panel replaces the session view. So `require()` throws,
  // `screen()` returns undefined, `openTabFromTarget()` returns early, and even
  // DSH's own `Ctrl+Alt+B` resolves to `blocked` / `command.noSession`
  // (「请先打开页面」) and does nothing. The right column belongs to a Conversation,
  // and this panel is not one — DSH's own 「打开右侧边栏」 button lives in
  // `conversation.session.header.corner` and works there.
  //
  // A control that can never act is worse than none, so there is none: this
  // asserts the plugin does not reach for that service at all.
  rightInjections.get('main')?.();
  // No `main` seat any more: the strip under test is the TAB's, which is the only
  // one there is. Rendered through the seam, like the panel itself.
  const stripButtons = collect(rightCtx.__hermesPanel.panel()).filter((node) => node.type === 'button');
  check(
    'the toolbar offers nothing it cannot do',
    !stripButtons.some((node) => String(node.props?.['aria-label'] ?? '').includes('打开右侧边栏')),
    stripButtons.map((n) => n.props?.['aria-label'] ?? textOf(n)).join(' / '),
  );
  check(
    'and it never calls the sidebar service, which would throw here',
    rightCalls.commandTarget === 0 && rightCalls.toggleExpanded === 0 && rightCalls.opened === null,
    `commandTarget=${rightCalls.commandTarget} toggle=${rightCalls.toggleExpanded} opened=${JSON.stringify(rightCalls.opened)}`,
  );
}

// ---- the right column arrives LATER than this plugin does ------------------
//
// This is the bug that shipped once, and it is worth a test of its own. The
// service table is still being built when a plugin applies, and the right column
// composes after this one, so an eager `ctx.get('sidebarRightTabs')` sees
// nothing and the whole block returns early. Every other check in this file
// passed while the guide row was missing from the real DSH, because their stubs
// had the service ready up front. Here it is deliberately absent at activation.

{
  const lateTypes = [];
  const latePending = [];
  const lateExports = registration.factory((specifier) => {
    if (specifier === 'react') return fakeReact;
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
  });
  const services = { sidebarRightTabs: undefined, sidebarRight: undefined };
  const lateCtx = {
    effect: (callback) => { const disposer = callback(); return typeof disposer === 'function' ? disposer : () => {}; },
    get: (name) => services[name],
    // cordis' real contract: the callback runs when the services exist, however
    // much later that is.
    inject: (deps, callback) => { latePending.push({ deps, callback }); },
    slots: {
      inject: () => () => {},
      register: () => () => {},
    },
  };
  lateExports.apply(lateCtx);
  await new Promise((resolve) => setTimeout(resolve, 0));

  check('nothing is published while the right column is still missing', lateTypes.length === 0, String(lateTypes.length));
  check(
    'the panel asks for the right column instead of reading it once',
    latePending.some((entry) => entry.deps.includes('sidebarRightTabs')),
    latePending.map((entry) => entry.deps.join('+')).join(', '),
  );

  // ...and now the right column composes.
  services.sidebarRightTabs = { register: (definition) => { lateTypes.push(definition); return () => {}; } };
  services.sidebarRight = { commandTarget: () => ({ paneId: 'p1', host: 'dock' }), openTabFromTarget: () => {} };
  const ready = latePending.splice(0);
  for (const entry of ready) {
    const scope = { ...lateCtx };
    let have = true;
    for (const dep of entry.deps) {
      if (services[dep] === undefined) { have = false; break; }
      scope[dep] = services[dep];
    }
    if (have) entry.callback(scope);
  }

  check('the tab type registers once the service arrives', lateTypes.length === 1, String(lateTypes.length));
  check('and it is the dashboard', lateTypes[0]?.kind === 'hermes-dashboard', String(lateTypes[0]?.kind));
}

// ---- the embedded dashboard survives a panel switch ------------------------
//
// DSH renders only the ACTIVE `main` panel, so switching to a DSH conversation
// unmounts the Hermes panel — and an iframe that unmounts is destroyed. The page
// then reloaded on the way back: the conversation that had been on screen was
// gone from the view, and a turn still in flight was cut off mid-answer.
//
// The first attempt at this kept the frame in a *detached* holder and re-inserted
// it on the way back. That does not work either, and the check below is written
// to say why: in Chromium, removing an element from the document destroys its
// browsing context, so re-inserting it later reloads it just the same. The frame
// must never leave the document at all — it is hidden, not detached.

{
  check(
    'the dashboard frame is no longer a React element',
    !/h\(\s*'iframe'/.test(source),
    /h\(\s*'iframe'/.test(source) ? 'still rendered from the tree — unmounting destroys it' : '',
  );
  check(
    'it lives in a host on document.body, not in the unmounting tree',
    source.includes('let frameHost = null;')
      && source.includes('function ensureFrameHost(src, nonce)')
      && source.includes('document.body.appendChild(frameHost);'),
    '',
  );
  // The first attempt re-parented the frame on the way out; that is the mistake
  // this counts. The frame is appended exactly once, when it is created — a
  // second append would mean it is being MOVED, and moving an iframe out of the
  // document destroys it just as much as unmounting it.
  const frameAppends = (source.match(/appendChild\(frame\)/g) ?? []).length;
  check(
    'the host is only HIDDEN on the way out, never detached or re-parented',
    source.includes("host.style.display = 'none';") && !source.includes('frameHost.remove()') && frameAppends === 1,
    frameAppends === 1 ? '' : `appendChild(frame) appears ${frameAppends} times — the frame is being moved`,
  );
  check(
    'the frame is re-created only when the URL or the reload nonce changes',
    source.includes('const key = `${src}#${nonce}`;')
      && source.includes('if (frameElement !== null && frameKey === key) return frameHost;'),
    '',
  );
  check(
    'the host is sized to the slot the panel renders',
    source.includes('getBoundingClientRect()') && source.includes('host.style.height = `${box.height}px`;'),
    '',
  );

  // The slot is swapped in and out when the dashboard gives way to the record. A
  // `place` that closed over the element measured a DETACHED node from then on —
  // zero for ever, so it hid the frame and never un-hid it. The symptom was exact:
  // 「点进去再点一下就是空白界面，能转换，但转换的是空白的界面」.
  const placeBody = source.slice(
    source.indexOf('const place = () => {'),
    source.indexOf('placeRef.current = place;'),
  );
  check(
    'the frame re-reads the slot on every placement, not once on setup',
    placeBody.includes('const target = slot.current;'),
    placeBody.includes('const target = slot.current;') ? '' : 'place still closes over the element',
  );
  check(
    'and it is placed after every render, not only on a tick',
    source.includes('placeRef.current();'),
    '',
  );
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
