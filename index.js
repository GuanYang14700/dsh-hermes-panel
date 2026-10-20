/**
 * `@guanyang14700/dsh-hermes-panel` — Host half.
 *
 * Manages the user's NATIVE Hermes runtime (the Python `hermes_agent`
 * installation) and exposes it to the Client half over the DSH web server as
 * `/hermes/api/*`:
 *
 *   - `hermes gateway run` — the messaging gateway / cron scheduler, and
 *   - `hermes dashboard`   — the native web dashboard on 127.0.0.1:<port>.
 *
 * This deliberately targets the native Hermes dashboard, NOT the unrelated
 * `hermes-web-ui` npm package (which brands itself "Ekko Studio").
 *
 * No machine-specific defaults
 * ---------------------------
 * An earlier revision hard-coded this author's `hermes.exe` and `HERMES_HOME`
 * into both `cordis.patch.yml` and the defaults below, which meant a fresh
 * install pointed at paths that do not exist. Nothing here is hard-coded any
 * more: {@link discoverHermes} reads the Hermes installation's own
 * `official-web/.env` — which is already the single source of truth for
 * `HERMES_HOME`, `VENV`, `HERMES_EXE` and `DASHBOARD_PORT` — so a plugin
 * installed on someone else's machine needs no path configuration at all.
 *
 * `.env` also holds the runtime's API key. Only the four keys above are ever
 * retained ({@link ALLOWED_ENV_KEYS}); every other line is dropped while
 * parsing, so no secret reaches plugin state, the log ring, or the browser.
 *
 * Why there is no reverse-proxy bridge
 * ------------------------------------
 * The native dashboard is a plain uvicorn app that sets NO `X-Frame-Options`
 * and NO `Content-Security-Policy` on either its shell or its assets, so the
 * DSH page can frame `http://127.0.0.1:<port>/` directly. A transparent bridge
 * is therefore unnecessary — and skipping it also avoids having to tunnel the
 * dashboard's own WebSocket traffic by hand.
 *
 * Route authorization
 * -------------------
 * `webServer.register` routes are NOT behind the DSH index/`/api` auth guard,
 * and the route interface has no auth option of its own. A bare method check
 * was therefore a cross-site request forgery hole: any page the user visited
 * could `POST http://127.0.0.1:3080/hermes/api/stop` (a simple, preflight-free
 * request) and kill the user's Hermes gateway. Every route now goes through
 * {@link allowed}, which requires a loopback peer, a same-origin `Origin`, and
 * a `Sec-Fetch-Site` that is not cross-site.
 *
 * Process shapes worth knowing
 * ----------------------------
 * `hermes dashboard` is a WRAPPER: it stays alive and spawns the real server
 * (`python.exe`, the process that actually holds the port) as its child
 * (verified: listener PPID == wrapper PID). When this plugin spawned the
 * wrapper itself, `stopDashboard()` terminates that handle and waits for the
 * port. When it did NOT — the user's `启动.bat` / `official-web\start.ps1`
 * started it, or a previous DSH process did — there is no handle, so the panel
 * asks Windows which PID owns the port and ends that tree with
 * `taskkill /T /F`. Its previous fallback, `hermes dashboard --stop`, is
 * useless on this machine: its Windows discovery shells out to `wmic`, which
 * Windows 11 no longer ships, so it reports "No hermes dashboard processes
 * running." and exits 0 while the server keeps serving (verified 2026-10-07
 * with two dashboards live).
 */
import net from 'node:net';
import { homedir } from 'node:os';
import { readdirSync } from 'node:fs';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Services this plugin requires before it activates. */
export const inject = ['webServer', 'subprocess'];

/** Directory holding this module (the package root). */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The port used when neither the config nor `.env` names one. */
const DEFAULT_PORT = 9150;

/**
 * The settings namespace this plugin's own row serves.
 *
 * It is the profile entry id, not the panel id — the row in `cordis.patch.yml`
 * is declared as `id: hermes-panel`, and that id is what DSH keys the namespace
 * by. The client half registers its form under the same string.
 */
const SETTINGS_NAMESPACE = 'hermes-panel';

/** The message for a Hermes home that was found but has no CLI to drive. */
const CLI_MISSING = '找到了 Hermes 目录，但没找到它的命令行入口（hermes / hermes.exe）：设置里填 hermesExe，或把它放进 PATH。';

/** Ports below this are almost always a typo rather than a dashboard. */
const MIN_PORT = 1024;

/** `.env` keys this plugin keeps. Everything else is discarded on parse. */
const ALLOWED_ENV_KEYS = new Set(['HERMES_HOME', 'VENV', 'HERMES_EXE', 'DASHBOARD_PORT']);

//#region schemastery loading

/** Anchor for resolving packages through Node's CommonJS algorithm. */
const require = createRequire(import.meta.url);

/**
 * Walk up from a directory looking for a relative path.
 * @param startDir - directory to start at.
 * @param relative - path to look for in each ancestor.
 * @returns the first match, or undefined.
 */
function findUp(startDir, relative) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Load the Schemastery factory DSH builds plugin config schemas from.
 *
 * A plain `import '@deepseek-ai/schemastery'` is correct for a plugin installed
 * under `node_modules`, but this plugin is normally consumed through a `link:`
 * dependency, and Node resolves bare specifiers from a module's REAL path —
 * which is outside `node_modules`, where Schemastery is not installed. A static
 * import would therefore throw at load time, and DSH startup is all-or-nothing:
 * one failed plugin kills the whole process. Resolution is therefore attempted
 * through several anchors and degrades to `undefined` instead of throwing. A
 * missing schema costs the settings form; it never costs the boot.
 * @returns the Schemastery factory, or undefined when it cannot be loaded.
 */
function loadSchemastery() {
  const candidates = [];
  try {
    candidates.push(require.resolve('@deepseek-ai/schemastery'));
  } catch {
    /* not resolvable from the package's real path — try the DSH install */
  }
  const dshDir = findUp(HERE, join('node_modules', '@deepseek-ai', 'dsh'));
  if (dshDir !== undefined) {
    // Schemastery is a dependency of @deepseek-ai/dsh, so it is present in that
    // package's own node_modules even when the profile leaves it unhoisted.
    candidates.push(join(dshDir, 'node_modules', '@deepseek-ai', 'schemastery'));
    try {
      candidates.push(require.resolve('@deepseek-ai/schemastery', { paths: [dshDir] }));
    } catch {
      /* the direct path above is the fallback */
    }
  }
  for (const candidate of candidates) {
    try {
      const module = require(candidate);
      const factory = module?.default ?? module;
      if (typeof factory?.object === 'function') return factory;
    } catch {
      /* try the next anchor */
    }
  }
  return undefined;
}

/** Schemastery factory, or undefined when no anchor could supply one. */
const z = loadSchemastery();

//#endregion

/**
 * Row config schema. Every field is `.volatile()`: DSH only renders a settings
 * form for fields reachable under a volatile node, so a schema without one is
 * collected but never shown.
 *
 * The first two are the runtime/volume split. Both are empty by default and the
 * defaults are derived from the DSH home — this file contains no absolute path,
 * because it ships to other machines.
 */
export const Config = z === undefined ? undefined : z.object({
  /**
   * Python environment for Hermes — the runtime. Empty means 
   * `<DSH home>/hermes-panel/runtime`. This is Hermes' own `VENV`.
   */
  runtimeDir: z.string().default('').volatile(),
  /**
   * The volume: `HERMES_HOME`, where profiles, sessions, state, `config.yaml` and
   * `official-web/` live. Empty means `<DSH home>/hermes-panel/home`. Point it at an
   * existing Hermes home to keep using that installation's data.
   */
  dataDir: z.string().default('').volatile(),
  /** Dashboard port; 0 selects the port recorded in `.env`. */
  dashboardPort: z.number().step(1).min(0).max(65535).default(0).volatile(),
  /**

   * A directory both agents work in. It is the bridge's workspace, and the plugin
   * offers to point Hermes' own `terminal.cwd` at it and to create the `AGENTS.md`
   * that both sides read as project context.
   */
  sharedWorkspace: z.string().default('').volatile(),
  /** Start and stop the messaging gateway alongside the dashboard. */
  manageGateway: z.boolean().default(true).volatile(),
  /** Start everything as soon as the plugin activates. */
  autostart: z.boolean().default(false).volatile(),
});

/**
 * Coerce a schema-decoded config into the shape {@link apply} expects.
 * @param config - row config, already decoded by DSH when a schema exists.
 * @returns a complete config object.
 */
/**
 * Compare two paths the way the filesystem on this machine would.
 *
 * Separators differ between what a user typed and what a tool returned, and
 * Windows does not care about case. Used for "are these the same directory", never
 * for opening anything.
 * @param value - a path, or anything else.
 * @returns a comparable form.
 */
function samePath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Whether a `mcp_servers.dsh` entry runs the bridge script this plugin ships.
 *
 * Compared by file IDENTITY, not by string. A plugin installed the normal way is
 * reached through a junction in the profile `node_modules`, and the operator
 * config may name either that path or the real one — the same file, two spellings.
 * `realpathSync` does not help: a Windows junction resolves to itself. Device and
 * inode do, and they answer the question that is actually being asked: is Hermes
 * running MY bridge, or a stale copy from elsewhere?
 * @param entry - the rendered `dsh:` block.
 * @param script - the plugin its bridge script path.
 * @returns true when the entry launches that same file.
 */
function configuredRunsScript(entry, script) {
  const quoted = entry.match(/[A-Za-z]:[\\/][^'"\s]+\.py/gi) ?? [];
  let target;
  try {
    target = statSync(script);
  } catch {
    return false;
  }
  for (const candidate of quoted) {
    try {
      const other = statSync(candidate);
      if (other.dev === target.dev && other.ino === target.ino && other.ino !== 0) return true;
    } catch {
      /* a path that does not exist cannot be this one */
    }
  }
  // No identity match: fall back to the string, which still catches a config that
  // names a script that has since been moved away.
  return entry.replace(/\\/g, '/').includes(script.replace(/\\/g, '/'));
}

function normalizeConfig(config) {
  const raw = config ?? {};
  /**
   * The value behind a schema node, or the value itself when it is already bare.
   *
   * DSH wraps every field, and `typeof node === "string"` is false for all of them —
   * which is how seven settings read as empty for the whole life of this plugin.
   * @param value - a schema node, or a plain value.
   * @returns the underlying value.
   */
  const unwrap = (value) => {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
      try {
        return value.get();
      } catch {
        return value;
      }
    }
    return value;
  };
  const number = (value, fallback) => {
    const bare = unwrap(value);
    const parsed = typeof bare === 'string' && bare.trim() !== '' ? Number(bare) : bare;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const text = (value) => {
    const bare = unwrap(value);
    return typeof bare === 'string' ? bare.trim() : '';
  };
  const flag = (value, fallback) => {
    const bare = unwrap(value);
    return typeof bare === 'boolean' ? bare : fallback;
  };
  return {
    runtimeDir: text(raw.runtimeDir),
    dataDir: text(raw.dataDir),
    dashboardPort: number(raw.dashboardPort, 0),
    // The dashboard is loopback by design; this is a constant, not a setting.
    bindHost: '127.0.0.1',
    // Long enough for a cold dashboard start on a slow machine. A constant: the
    // default is right, and a wrong value only turns a slow start into a failure.
    startTimeoutMs: 60000,
    sharedWorkspace: text(raw.sharedWorkspace),
    // Compared through `flag`, because `raw.manageGateway !== false` is true for a
    // schema node — which silently turned the gateway on and left autostart off,
    // whatever the configuration said.
    manageGateway: flag(raw.manageGateway, true),
    autostart: flag(raw.autostart, false),
  };
}

//#region Hermes discovery

/**
 * Read the whitelisted keys of a Hermes `official-web/.env`.
 * Only {@link ALLOWED_ENV_KEYS} are retained, so a key or token on any other
 * line is discarded before it can reach plugin state.
 * @param envPath - path to the `.env` file.
 * @returns the whitelisted key/value pairs, or undefined when unreadable.
 */
function readHermesEnv(envPath) {
  let contents;
  try {
    contents = readFileSync(envPath, 'utf8');
  } catch {
    return undefined;
  }
  const values = {};
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1];
    if (!ALLOWED_ENV_KEYS.has(key)) continue;
    let value = match[2].trim();
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/**
 * Derive the CLI entry point from a virtual-environment root.
 * @param venv - the `VENV` value, if any.
 * @returns the expected executable path, or undefined.
 */
function executableForVenv(venv) {
  if (typeof venv !== 'string' || venv.trim() === '') return undefined;
  return process.platform === 'win32'
    ? join(venv, 'Scripts', 'hermes.exe')
    : join(venv, 'bin', 'hermes');
}

/**
 * The `hermes` console script on PATH, if there is one.
 *
 * A pip/pipx/uv installation puts `hermes.exe` in its environment's `Scripts`
 * (or `bin`) directory and expects PATH to find it — there is no
 * `official-web/.env` to name it. Without this, discovery could see a Hermes home
 * and still report that no installation exists, which is what made this plugin
 * useless anywhere but on its author's machine.
 * @returns the executable's path, or undefined.
 */
function hermesOnPath() {
  const names = process.platform === 'win32'
    ? ['hermes.exe', 'hermes.cmd', 'hermes.bat', 'hermes']
    : ['hermes'];
  const separator = process.platform === 'win32' ? ';' : ':';
  for (const dir of String(process.env.PATH ?? '').split(separator)) {
    if (dir.trim() === '') continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * How a directory says it is a Hermes home.
 *
 * Two layouts are in the wild and both count:
 *
 *  - upstream Hermes keeps its data in a home directory with `config.yaml`
 *    (`~/.hermes`, or whatever `HERMES_HOME` names);
 *  - the `official-web` distribution wraps that with `.env`-driven launch and
 *    maintenance scripts, and is self-describing through `official-web/.env`.
 *
 * Requiring `official-web/` — one distribution's marker, not Hermes' — is what
 * made this plugin report 「没有找到可用的 Hermes 安装」 on a machine that had
 * Hermes installed the ordinary way.
 * @param dir - a candidate home.
 * @returns the layout name, or null when the directory is not a Hermes home.
 */
function hermesHomeKind(dir) {
  if (existsSync(join(dir, 'official-web', '.env'))) return 'official-web';
  if (existsSync(join(dir, 'config.yaml'))) return 'config';
  return null;
}

/**
 * Which of the distribution's maintenance scripts this installation actually has.
 *
 * They are the plugin's 体检 / 查更新 / 升级 / 安装 buttons. On an upstream
 * installation there is none of them, and the panel has to say so rather than
 * offer a button that fails.
 * @param home - the resolved Hermes home.
 * @returns one boolean per script.
 */
function maintenanceAvailability(home) {
  const dir = join(home, 'official-web');
  const has = (name) => existsSync(join(dir, name));
  return {
    doctor: has('doctor.ps1'),
    checkUpdate: has('check-update.ps1'),
    update: has('update.ps1'),
    };
}

//#region maintenance scripts

/**
 * The PowerShell hosts to try, most capable first.
 *
 * PowerShell 7 is preferred because the maintenance scripts are written and
 * tested against it; `powershell.exe` is only a fallback for a machine that has
 * no `pwsh` on PATH.
 */
const POWERSHELL_CANDIDATES = ['pwsh', 'powershell.exe'];

/** The maintenance scripts this plugin is allowed to run, by file name. */
const MAINTENANCE_SCRIPTS = new Set(['doctor.ps1', 'check-update.ps1', 'update.ps1', 'install.ps1']);

/**
 * Hard cap on one upgrade.
 *
 * Deliberately generous, and deliberately a last resort: pip on a slow mirror
 * takes minutes, and terminating it mid-install is how a virtual environment
 * gets broken. The cap exists so a wedged child cannot leak a process forever,
 * not as a normal path.
 */
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000;

/** How many upgrade output lines are kept for the panel. */
const UPDATE_OUTPUT_LIMIT = 400;

/**
 * The starter `AGENTS.md` written into a shared workspace.
 *
 * Kept deliberately short and factual: it is the operator's file from the moment
 * it exists, and this text is only ever written once, when the file is absent.
 */
const AGENTS_TEMPLATE = `# 共享工作区

这个目录同时是 **Hermes** 和 **DSH** 的工作区，所以这个文件两边都会读到 ——
DSH 的 \`dsh-agent-instructions\` 找的就是 \`AGENTS.md\`，Hermes 的上下文发现也读它。

在这里写两边都该知道的事：项目约定、目录说明、当前目标、不要碰的东西。
写完保存即可，两个 agent 下一次在这个目录里开工时就会看到。
`;

/**
 * Quote one value as a PowerShell single-quoted literal.
 * @param value - the value to quote.
 * @returns the literal.
 */
function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Build the PowerShell command that runs one maintenance script.
 *
 * `[Console]::OutputEncoding` is set explicitly: without it a Windows
 * PowerShell host encodes stdout in the OEM code page and any non-ASCII text in
 * a check's `detail` reaches Node as mojibake (measured on `doctor.ps1 -Json`,
 * whose dashboard hint names a Chinese `.bat`).
 * @param script - absolute path to the script.
 * @param args - switches to pass through.
 * @returns the `-Command` body.
 */
function maintenanceCommand(script, args, options = {}) {
  const call = ['&', quotePowerShell(script), ...args].join(' ');
  // `*>&1` for the installer, and only there.
  //
  // These scripts print progress with `Write-Host`, which in PowerShell 5+ goes to the
  // INFORMATION stream — not stdout. The panel reads the child's stdout, so the guided
  // install showed an empty log while it ran: the first self-test produced literally no
  // output between "starting" and the exit code. Merging every stream onto stdout is
  // what makes the progress, and the reason a failure failed, visible in the panel.
  //
  // Not applied to the reporting scripts: they print a JSON document on stdout and the
  // panel parses it, and while `parseJsonArray` tolerates surrounding lines, there is no
  // reason to make it work harder than it has to.
  const merge = options.mergeStreams === true ? ' *>&1' : '';
  return `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${call}${merge}`;
}

/**
 * Read the JSON array a maintenance script printed.
 *
 * Scripts print progress lines around their payload, and a progress line can
 * itself contain brackets — `[doctor] running checks` is a real prefix — so the
 * document is located by trying each `[` in turn rather than by taking the first
 * one. Slicing from the wrong candidate start yields invalid JSON, and the
 * report would then be reported as unreadable when it was merely preceded.
 * @param text - combined child output.
 * @returns the parsed checks, or undefined when no array parses.
 */
function parseJsonArray(text) {
  const end = text.lastIndexOf(']');
  let start = text.indexOf('[');
  while (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* this bracket was not the payload's; try the next one */
    }
    start = text.indexOf('[', start + 1);
  }
  return undefined;
}

/**
 * Count a doctor report's statuses.
 * @param checks - parsed doctor checks.
 * @returns per-status totals.
 */
function summarizeChecks(checks) {
  const summary = { ok: 0, warn: 0, fail: 0, other: 0 };
  for (const check of checks) {
    const status = String(check?.status ?? '').toUpperCase();
    if (status === 'OK') summary.ok += 1;
    else if (status === 'WARN') summary.warn += 1;
    else if (status === 'FAIL') summary.fail += 1;
    else summary.other += 1;
  }
  return summary;
}

/**
 * Read `hermes cron status` output.
 *
 * The command prints one of a fixed set of sentences — `hermes_cli/cron.py`
 * writes them — and each says something different about whether jobs will fire:
 *
 *   - gateway process alive and the ticker healthy;
 *   - process alive but the ticker thread gone (no heartbeat for N seconds);
 *   - process and ticker alive but no tick has SUCCEEDED in N seconds;
 *   - no gateway process at all;
 *   - an external cron provider, where no in-process ticker is expected and
 *     there is deliberately no `PID:` line.
 *
 * The markers are matched in that order, and **a report that matches none of
 * them is `unknown`, never `stopped`**. An earlier revision asked only "does it
 * say 'gateway is running'?" and answered "stopped" when it did not, so any
 * change to the CLI's wording — or a mangled code page — silently turned a live
 * gateway into a stopped one. Only the sentence that says it is not running
 * means not running.
 *
 * All markers are ASCII on purpose: the command also prints `✓`, `⚠` and an em
 * dash, and matching those would make the parser depend on the child's stdout
 * encoding as well as on its wording.
 * @param text - the command's combined output.
 * @returns status, every PID it reported, a warning, and which sentence matched.
 */
function parseGatewayStatus(text) {
  const pids = [];
  const pidLine = /^\s*PID:\s*(.+)$/m.exec(text);
  if (pidLine !== null) {
    for (const part of pidLine[1].split(',')) {
      const value = Number(part.trim());
      if (Number.isInteger(value) && value > 0 && !pids.includes(value)) pids.push(value);
    }
  }

  const stalled = /no heartbeat for (\d+)s/i.exec(text);
  if (/ticker looks STALLED/i.test(text)) {
    return {
      status: 'running',
      pids,
      detail: 'stalled',
      warning: `网关进程在跑，但 cron 心跳已停${stalled === null ? '' : `（${stalled[1]} 秒没有心跳）`} — 建议重启网关`,
    };
  }

  const failing = /no tick has succeeded in (\d+)s/i.exec(text);
  if (failing !== null) {
    return {
      status: 'running',
      pids,
      detail: 'failing',
      warning: `网关与 ticker 都在跑，但已经 ${failing[1]} 秒没有一次 tick 成功 — 去看网关日志里的 Cron tick error`,
    };
  }

  if (/Gateway is running/i.test(text)) {
    return { status: 'running', pids, detail: 'healthy', warning: null };
  }

  if (/Cron provider:/i.test(text)) {
    // An external provider has no in-process ticker and prints no PID line.
    return { status: 'running', pids, detail: 'external-provider', warning: null };
  }

  if (/Gateway is not running/i.test(text)) {
    return { status: 'stopped', pids: [], detail: 'stopped', warning: null };
  }

  return { status: 'unknown', pids: [], detail: 'unparsed', warning: null };
}

//#endregion

//#region Hermes config.yaml surgery

/**
 * Render one value as a YAML scalar.
 *
 * Windows paths contain a colon, and a colon followed by a space would end a
 * plain scalar early, so anything with YAML punctuation is quoted rather than
 * trusted. Single quotes are the one YAML quoting form with no escapes other
 * than a doubled quote, which keeps the round trip exact.
 * @param value - the value to render.
 * @returns a scalar safe to place after `key: `.
 */
function yamlScalar(value) {
  const text = String(value);
  if (text === '' || /^\s|\s$/.test(text) || /[:#]/.test(text) || /[\r\n]/.test(text) || /^[-?&*!|>%@`"'[\]{},]/.test(text)) {
    return `'${text.replace(/'/g, "''")}'`;
  }
  return text;
}

/**
 * Indent rendered lines by a prefix of spaces.
 * @param lines - lines rendered at zero indent.
 * @param spaces - how many spaces to prepend.
 * @returns the indented lines.
 */
function indentLines(lines, spaces) {
  const pad = ' '.repeat(spaces);
  return lines.map((line) => (line === '' ? '' : pad + line));
}

/**
 * Render the `dsh` entry of `mcp_servers`, at zero indent.
 * @param spec - python, script, DSH root, workspace, profile and journal.
 * @returns the entry's lines.
 */
/**
 * Where the bridge appends one line per run it drove.
 *
 * Under the DSH home rather than Hermes': these are DSH sessions, and the file is
 * DSH-side state about DSH-side data. The bridge is TOLD this path (it is written
 * into `mcp_servers.dsh` as `DSH_MCP_JOURNAL`), so neither half has to guess.
 *
 * `HERMES_PANEL_JOURNAL` overrides it — a test that exercised the real path would
 * write into the user's home, which is the sort of thing a suite should not do.
 * @returns the journal path.
 */
function journalPath() {
  const override = process.env.HERMES_PANEL_JOURNAL;
  if (typeof override === 'string' && override !== '') return override;
  return join(homedir(), '.dsh', 'hermes-panel', 'drives.jsonl');
}

function renderBridgeEntry(spec) {
  const lines = [
    'dsh:',
    `  command: ${yamlScalar(spec.python)}`,
    '  args:',
    `    - ${yamlScalar(spec.script)}`,
    '  env:',
    `    DSH_MCP_ROOT: ${yamlScalar(spec.dshRoot)}`,
    `    DSH_MCP_WORKSPACE: ${yamlScalar(spec.workspace)}`,
  ];
  if (spec.profile !== '') lines.push(`    DSH_MCP_PROFILE: ${yamlScalar(spec.profile)}`);
  // The journal is how the panel tells an exchange Hermes drove from a session
  // somebody typed into the CLI: their session headers are byte-identical, so the
  // only record of the difference is the one the bridge writes as it goes.
  if (spec.journal !== undefined && spec.journal !== '') lines.push(`    DSH_MCP_JOURNAL: ${yamlScalar(spec.journal)}`);
  lines.push('  enabled: true', '  timeout: 1800');
  return lines;
}

/**
 * Find one top-level `key:` block and its extent.
 *
 * The extent runs to the next line at column zero, which is what keeps an edit
 * inside one block from touching whatever follows it.
 * @param lines - the file split into lines.
 * @param key - the top-level key.
 * @returns the block's first line and where it ends.
 */
function locateTopLevelBlock(lines, key) {
  const pattern = new RegExp(`^${key}:\\s*(#.*)?$`);
  const start = lines.findIndex((line) => pattern.test(line));
  if (start === -1) return { found: false, start: -1, end: -1 };

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue;
    if (/^\S/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { found: true, start, end };
}

/**
 * Find the `mcp_servers:` block and, inside it, one child entry.
 *
 * Deliberately line-based rather than a YAML round trip: `config.yaml` holds the
 * runtime's plaintext API keys and a full set of explanatory comments, and any
 * parse-and-re-emit would silently drop both. The real file is treated as text
 * and only the region belonging to one child is ever rewritten.
 * @param lines - the file split into lines.
 * @param name - the child entry to find.
 * @returns the block and child extents, or what was missing.
 */
function locateMcpServerBlock(lines, name) {
  const block = locateTopLevelBlock(lines, 'mcp_servers');
  if (!block.found) return { hasRoot: false, rootIndex: -1 };
  const { start: rootIndex, end: blockEnd } = block;

  let childIndent = 2;
  for (let index = rootIndex + 1; index < blockEnd; index += 1) {
    if (lines[index].trim() === '') continue;
    childIndent = lines[index].length - lines[index].trimStart().length;
    break;
  }

  const pattern = new RegExp(`^ {${childIndent}}${name}:\\s*(#.*)?$`);
  let childStart = -1;
  for (let index = rootIndex + 1; index < blockEnd; index += 1) {
    if (pattern.test(lines[index])) {
      childStart = index;
      break;
    }
  }
  if (childStart === -1) return { hasRoot: true, rootIndex, blockEnd, childIndent, childStart: -1, childEnd: -1 };

  let childEnd = blockEnd;
  for (let index = childStart + 1; index < blockEnd; index += 1) {
    if (lines[index].trim() === '') continue;
    const indent = lines[index].length - lines[index].trimStart().length;
    if (indent <= childIndent) {
      childEnd = index;
      break;
    }
  }
  return { hasRoot: true, rootIndex, blockEnd, childIndent, childStart, childEnd };
}

/**
 * Read one `mcp_servers` child as raw text.
 * @param text - the file contents.
 * @param name - the child entry.
 * @returns the child's lines, or null when absent.
 */
function readMcpServerEntry(text, name) {
  const lines = text.split(/\r?\n/);
  const found = locateMcpServerBlock(lines, name);
  if (!found.hasRoot || found.childStart === -1) return null;
  return lines.slice(found.childStart, found.childEnd);
}

/**
 * Insert or replace one `mcp_servers` child, touching nothing else.
 * @param text - the file contents.
 * @param name - the child entry.
 * @param entry - the child's replacement lines, rendered at zero indent.
 * @returns the new text and what was done.
 */
function upsertMcpServerEntry(text, name, entry) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const found = locateMcpServerBlock(lines, name);

  if (!found.hasRoot) {
    const appended = [...lines];
    while (appended.length > 0 && appended[appended.length - 1].trim() === '') appended.pop();
    appended.push('', 'mcp_servers:', ...indentLines(entry, 2), '');
    return { text: appended.join(newline), action: 'created-block' };
  }

  const rendered = indentLines(entry, found.childIndent);
  if (found.childStart !== -1) {
    lines.splice(found.childStart, found.childEnd - found.childStart, ...rendered);
    return { text: lines.join(newline), action: 'replaced-entry' };
  }

  let insertAt = found.blockEnd;
  while (insertAt > found.rootIndex + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  lines.splice(insertAt, 0, ...rendered);
  return { text: lines.join(newline), action: 'added-entry' };
}

/**
 * Read one scalar inside a top-level block.
 * @param text - the file contents.
 * @param blockKey - the top-level key.
 * @param childKey - the scalar inside it.
 * @returns the raw scalar text, or null when either is absent.
 */
function readBlockScalar(text, blockKey, childKey) {
  const lines = text.split(/\r?\n/);
  const block = locateTopLevelBlock(lines, blockKey);
  if (!block.found) return null;
  const pattern = new RegExp(`^\\s+${childKey}:\\s*(.*?)\\s*$`);
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = pattern.exec(lines[index]);
    if (match !== null) return match[1];
  }
  return null;
}

/**
 * Set one scalar inside a top-level block, creating the block and the key when
 * they are absent.
 *
 * Used to point Hermes' own `terminal.cwd` at the shared workspace. It is the
 * same surgical treatment as the bridge entry and for the same reason: this file
 * carries the deployment's plaintext keys and its comments.
 * @param text - the file contents.
 * @param blockKey - the top-level key.
 * @param childKey - the scalar inside it.
 * @param value - the value to write, already rendered as a scalar.
 * @returns the new text and what was done.
 */
function upsertBlockScalar(text, blockKey, childKey, value) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const line = `  ${childKey}: ${value}`;
  const block = locateTopLevelBlock(lines, blockKey);

  if (!block.found) {
    const appended = [...lines];
    while (appended.length > 0 && appended[appended.length - 1].trim() === '') appended.pop();
    appended.push('', `${blockKey}:`, line, '');
    return { text: appended.join(newline), action: 'created-block' };
  }

  const pattern = new RegExp(`^(\\s+)${childKey}:`);
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = pattern.exec(lines[index]);
    if (match !== null) {
      if (lines[index] === `${match[1]}${childKey}: ${value}`) return { text, action: 'unchanged' };
      lines[index] = `${match[1]}${childKey}: ${value}`;
      return { text: lines.join(newline), action: 'replaced-key' };
    }
  }

  let insertAt = block.end;
  while (insertAt > block.start + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  lines.splice(insertAt, 0, line);
  return { text: lines.join(newline), action: 'added-key' };
}

//#endregion

/**
 * Where this plugin keeps the things it owns.
 *
 * Derived from the user home, never written as a literal: the file ships to other
 * machines, and a path baked into it is a path that is wrong on every one of them.
 * @returns the DSH home directory.
 */
function dshHomeDir() {
  return join(homedir(), '.dsh');
}

/**
 * The Python environment used when the user has not named one.
 * @returns the default runtime directory.
 */
function defaultRuntimeDir() {
  return join(dshHomeDir(), 'hermes-panel', 'runtime');
}

/**
 * The Hermes home used when the user has not named one.
 * @returns the default data directory.
 */
function defaultDataDir() {
  return join(dshHomeDir(), 'hermes-panel', 'home');
}

/**
 * Read the runtime and the volume, and say exactly what is wrong with either.
 *
 * There were heuristics here — walk up from this package directory looking for a
 * sibling `Hermes`, plus the user profile and a few dotted spellings — and they were
 * the bug. An installed plugin does not live beside its Hermes; it lives several
 * levels down inside a profile `node_modules`, so the walk was always one directory
 * short. The failure then surfaced three different ways before anyone could see its
 * cause: a missing sidebar tab, a missing start button, and 「没有找到可用的 Hermes
 * 安装」 printed beside a Hermes that was running.
 *
 * So: two settings, both optional, both defaulted to a location under the DSH home,
 * and nothing guessed. The runtime is Hermes own `VENV`; the volume is
 * `HERMES_HOME` — profiles, sessions, state, `config.yaml`, `official-web/`.
 * @param conf - normalized config.
 * @returns the resolved runtime, or a report naming the directory that is wrong.
 */
function discoverHermes(conf) {
  const runtimeDir = conf.runtimeDir !== '' ? conf.runtimeDir : defaultRuntimeDir();
  // `hermesHome` is the old spelling of `dataDir`; the new one wins when both are set.
  //
  // Hermes' own variable, honoured after the setting: an operator who exported it has
  // already said where the volume is, and making them repeat it in a form would be
  // asking them to fix something that is not broken.
  const fromEnv = typeof process.env.HERMES_HOME === 'string' ? process.env.HERMES_HOME.trim() : '';
  const named = conf.dataDir !== '' ? conf.dataDir : fromEnv;
  const root = named !== '' ? named : defaultDataDir();
  // Two layouts, and no guessing between them: the directory IS the home (it holds
  // `official-web/` or `config.yaml`), or it holds the home as `home/` — which is how
  // the documented deployment stores it, and therefore where an install lands.
  // Everything else about this function is a settings lookup; this is just accepting
  // both spellings of "the volume".
  const dataDir = hermesHomeKind(root) !== null
    ? root
    : (hermesHomeKind(join(root, 'home')) !== null ? join(root, 'home') : root);
  const attempts = [];
  const port = conf.dashboardPort >= MIN_PORT ? conf.dashboardPort : DEFAULT_PORT;
  const absent = {
    found: false,
    home: null,
    exe: null,
    port,
    venv: null,
    officialWeb: false,
    maintenance: { doctor: false, checkUpdate: false, update: false, install: false },
    source: null,
    attempts,
    runtimeDir,
    dataDir,
  };

  if (!existsSync(dataDir)) {
    attempts.push(`${dataDir}：数据目录不存在 —— 面板里可以新建一个，或指向已有的 Hermes home`);
    return absent;
  }
  const kind = hermesHomeKind(dataDir);
  if (kind === null) {
    attempts.push(`${dataDir}：既没有 config.yaml，也没有 official-web/.env —— 这不像一个 Hermes 数据目录`);
    return absent;
  }

  // The volume IS the home. A `HERMES_HOME` inside `.env` is NOT followed: it is one
  // of the values the volume replaces, and following it would make the setting a
  // suggestion. Where the two disagree, the disagreement is reported below instead.
  const home = dataDir;
  const env = kind === 'official-web' ? readHermesEnv(join(home, 'official-web', '.env')) : {};
  const envPort = Number(env.DASHBOARD_PORT);
  const resolvedPort = conf.dashboardPort >= MIN_PORT
    ? conf.dashboardPort
    : (Number.isInteger(envPort) && envPort >= MIN_PORT ? envPort : DEFAULT_PORT);

  // `.env` drives the process `start.ps1` launches, so a mismatched HERMES_HOME is
  // not a nit: the dashboard would come up on a different home than the panel
  // describes, which is the kind of silent divergence that already cost three
  // rounds of debugging.
  const envHome = typeof env.HERMES_HOME === 'string' && env.HERMES_HOME !== '' ? env.HERMES_HOME : null;
  if (envHome !== null && samePath(envHome) !== samePath(home)) {
    attempts.push(`official-web/.env 里的 HERMES_HOME 是 ${envHome}，和设置的数据目录 ${home} 不一致 —— 启动脚本会用 .env 那个`);
  }

  // The runtime setting wins; `.env` and PATH are fallbacks, in that order.
  //
  // An installation that predates these settings has a correct `.env`, and making it
  // re-declare what that file already says would be asking the user to fix something
  // that is not broken. The setting exists so that a machine with NO Hermes — or a
  // plugin that has just installed one — can say where to look.
  //
  // "First that EXISTS", not "first that is not null": `executableForVenv` returns a
  // path for any directory, so `??` stopped at a `Scripts/hermes.exe` that was never
  // there and never reached the `.env` fallback behind it.
  const envExe = typeof env.HERMES_EXE === 'string' && env.HERMES_EXE !== '' ? env.HERMES_EXE : undefined;
  const exe = [executableForVenv(runtimeDir), envExe, hermesOnPath()]
    .find((candidate) => typeof candidate === 'string' && candidate !== '' && existsSync(candidate));
  const base = {
    found: true,
    home,
    port: resolvedPort,
    venv: runtimeDir,
    officialWeb: kind === 'official-web',
    maintenance: maintenanceAvailability(home),
    attempts,
    runtimeDir,
    dataDir,
    envHome,
  };

  if (exe === undefined || exe === '') {
    // A home with no runnable CLI is still an installation: the panel can show its
    // status, its settings and the bridge — it just cannot start or stop anything.
    // Reporting 「没有找到可用的 Hermes 安装」 here is what turned a working
    // installation into a dead panel.
    attempts.push(`${runtimeDir}：没找到 python / hermes —— 在设置里填「运行时目录」（旧名 hermesExe），或把 hermes 放进 PATH`);
    return { ...base, exe: null, source: `${kind === 'official-web' ? 'official-web/.env' : 'config.yaml'}（${home}，无 CLI）` };
  }
  if (!existsSync(exe)) {
    attempts.push(`${exe}：可执行文件不存在`);
    return { ...base, exe: null, source: null };
  }
  return { ...base, exe, source: `${runtimeDir}（${home}）` };
}

//#region request authorization

/**
 * Whether a peer address is a loopback address.
 * @param address - `socket.remoteAddress`.
 * @returns true for `127.0.0.0/8` and `::1`, including IPv4-mapped forms.
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false;
  const value = address.startsWith('::ffff:') ? address.slice(7) : address;
  return value === '::1' || /^127\./.test(value);
}

/**
 * Reject requests that a browser could have sent from another origin.
 *
 * A cross-site `POST` (form or `fetch(..., { mode: 'no-cors' })`) is a simple
 * request: the browser sends it without a preflight, so the side effect happens
 * even though the attacker cannot read the response. Checking the peer address,
 * `Origin`, and `Sec-Fetch-Site` closes that.
 * @param req - the incoming request.
 * @returns true when the request may proceed.
 */
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const host = req.headers.host;
  if (typeof host !== 'string' || host === '') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

//#endregion

/** Probe a TCP endpoint. */
function probePort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/** Poll a TCP endpoint until it accepts a connection. */
async function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probePort(host, port)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/**
 * Activate the Host half.
 * @param ctx - Cordis context carrying `webServer` and `subprocess`.
 * @param config - row config, decoded against {@link Config} when available.
 */
export function apply(ctx, config) {
  /**
   * The row config as DSH holds it *now*.
   *
   * Every field of {@link Config} is `.volatile()`, which means these values are
   * served by this row's settings namespace and edited while DSH runs — so the
   * object handed to `apply` is only the state at activation, and a settings
   * save does not re-activate the plugin. Reading that snapshot afterwards pins
   * every field to its boot value, which is exactly how a workspace the user had
   * just picked still read back as unset: the save was persisted, the settings
   * page showed it, and the plugin kept answering from the config it was born
   * with.
   *
   * The live values come from the settings service, which is a soft lookup for
   * the same reason the client half soft-looks-up `configForms`: a deployment
   * that does not mount it keeps working from the applied config rather than
   * failing to load.
   *
   * Memoized for a moment because `describe()` projects every namespace, and one
   * status snapshot reads a dozen fields in a row.
   */
  let liveCache = { at: 0, value: null };
  function liveConfig() {
    const now = Date.now();
    if (liveCache.value !== null && now - liveCache.at < 250) return liveCache.value;
    let next = normalizeConfig(config);
    const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
    if (settings !== undefined && settings !== null && typeof settings.describe === 'function') {
      try {
        const descriptor = settings
          .describe({ redactSecrets: true })
          .find((candidate) => candidate?.ns === SETTINGS_NAMESPACE);
        if (descriptor !== undefined && descriptor.value !== undefined && descriptor.value !== null) {
          // MERGED field by field, and an empty value does not count as an override.
          //
          // Two bugs lived in this one line. Replacing the whole object first: the
          // settings row carries a value for EVERY field — the schema's defaults are
          // empty strings — so `{ ...config, ...descriptor.value }` let `dataDir: ''`
          // win over the path the operator had written in `cordis.patch.yml`. The panel
          // then reported 「数据目录不存在」 for a directory it had been pointed at, and
          // offered no explanation, because on paper the setting was simply empty.
          //
          // So an empty string from the settings layer means "this field is at its
          // default", not "clear it", and the row config stands. Saving a value still
          // takes effect without re-activating the plugin, which is why this lookup
          // exists at all.
          const merged = { ...config };
          for (const [key, value] of Object.entries(descriptor.value)) {
            if (value === '' || value === null || value === undefined) continue;
            merged[key] = value;
          }
          next = normalizeConfig(merged);
        }
      } catch {
        /* an unreadable settings service leaves the applied config standing */
      }
    }
    liveCache = { at: now, value: next };
    return next;
  }

  /**
   * The live config behind the property reads the rest of this file already
   * makes. A proxy rather than a copy: `conf` is read in dozens of places, and
   * a copy is precisely the bug above.
   */
  const conf = new Proxy({}, {
    get: (_target, key) => liveConfig()[key],
    has: (_target, key) => key in liveConfig(),
    ownKeys: () => Reflect.ownKeys(liveConfig()),
    getOwnPropertyDescriptor: (_target, key) => ({
      value: liveConfig()[key],
      enumerable: true,
      configurable: true,
    }),
  });

  /** The discovery half of the payload: what was found, and what it can do. */
  function discoverySummary() {
    return {
      found: runtime.found,
      home: runtime.home,
      exe: runtime.exe ?? null,
      port: runtime.port,
      source: runtime.source,
      officialWeb: runtime.officialWeb === true,
      // The two directories the panel is pointed at, reported as the Host resolved
      // them — which is not the same as what was typed: an empty setting means a
      // default under the DSH home, and the panel has to show the default to be able
      // to say "this is where it is looking".
      runtimeDir: runtime.runtimeDir ?? null,
      dataDir: runtime.dataDir ?? null,
      maintenance: runtime.maintenance ?? { doctor: false, checkUpdate: false, update: false },
      attempts: runtime.attempts,
    };
  }

  /** @type {any} */
  let dashboardChild = null;
  /** @type {any} */
  let gatewayChild = null;
  /**
   * The one-shot `start-gateways.py` launcher while it runs. Distinct from
   * `gatewayChild`: the launcher exits as soon as the gateways are up, and the
   * gateways it starts are detached, so this panel never owns them.
   * @type {any}
   */
  let starterChild = null;
  /** Resolved Hermes install; refreshed by `/refresh` and lazily by `/start`. */
  let runtime = discoverHermes(conf);
  /** The lifecycle command in flight, so overlapping requests coalesce. */
  let inFlight = null;
  /** The upgrade child, while one is running. */
  let updateChild = null;
  /** The upgrade's hard-cap timer, cleared whenever the child settles. */
  let updateTimer = null;
  /** The install child, while one is running. */
  const state = {
    discovery: discoverySummary(),
    dashboard: { status: 'stopped', owned: false, error: null },
    gateway: { status: 'unknown', owned: false, pid: null, pids: [], detail: null, warning: null, error: null },
    log: [],
    /** The last `check-update.ps1` report, as text. */
    updateReport: null,
    /** The upgrade job, or its idle default. */
    update: {
      phase: 'idle',
      wasRunning: false,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      error: null,
      output: [],
    },
  };

  /** Append text to the bounded diagnostic ring. */
  function log(text) {
    for (const line of String(text).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      state.log.push(trimmed);
    }
    if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
  }

  /** Re-resolve the Hermes installation and publish the result. */
  function rediscover() {
    runtime = discoverHermes(conf);
    state.discovery = discoverySummary();
    return runtime;
  }

  /**
   * The upgrade job without its output, for the polled status payload.
   * @returns the compact job state.
   */
  function updateSummary() {
    const { phase, wasRunning, startedAt, finishedAt, exitCode, error } = state.update;
    return { phase, wasRunning, startedAt, finishedAt, exitCode, error };
  }

  /** @returns the client-facing status payload. */
  function snapshot() {
    const install = state.install;
    const maintenance = runtime.maintenance ?? { doctor: false, checkUpdate: false, update: false, install: false };
    return {
      discovery: state.discovery,
      // What this installation can actually be asked to do. The panel gates the
      // 体检 / 升级 / 安装 controls on these instead of offering a button that
      // fails: on an upstream Hermes there is no `official-web/`, so none of the
      // three exists, and pretending otherwise is how a panel becomes useless.
      capabilities: {
        found: runtime.found === true,
        cli: typeof runtime.exe === 'string' && runtime.exe !== '',
        officialWeb: runtime.officialWeb === true,
        health: runtime.found === true && maintenance.doctor === true,
        update: runtime.found === true && maintenance.update === true,
        platform: process.platform,
      },
      dashboard: state.dashboard,
      gateway: state.gateway,
      url: state.dashboard.status === 'running'
        ? `http://${conf.bindHost}:${runtime.port}/`
        : null,
      update: updateSummary(),
      updateReport: state.updateReport,
      // The bridge's two halves, both read from disk rather than assumed.
      bridge: bridgeStatus(),
      // The shared workspace both agents work in, and the AGENTS.md both read.
      workspace: workspaceStatus(),
      log: state.log.slice(-40),
    };
  }

  /** Write one JSON response. */
  function json(res, code, body) {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  /**
   * Authorize a request and answer it when it must not proceed.
   * @param req - the incoming request.
   * @param res - the response.
   * @returns true when the caller may continue.
   */
  function allowed(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      json(res, 403, { error: '仅接受来自本机的请求' });
      return false;
    }
    if (!sameOrigin(req)) {
      json(res, 403, { error: '仅接受同源请求' });
      return false;
    }
    return true;
  }

  /** @returns the environment every Hermes child needs. */
  function hermesEnv(extra = {}) {
    return { ...process.env, HERMES_HOME: runtime.home, ...extra };
  }

  /** Spawn one process to completion and capture its output. */
  async function runToCompletion(argv, timeoutMs, env) {
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: runtime.home,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 262144 },
        stderr: { maxBytes: 262144 },
      },
      graceMs: 3000,
      env,
    });
    const timer = setTimeout(() => {
      try {
        handle.terminate();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    let outcome;
    try {
      outcome = await handle.done;
    } finally {
      clearTimeout(timer);
    }
    const out = handle.collected.stdout?.readFrom(0).text ?? '';
    const err = handle.collected.stderr?.readFrom(0).text ?? '';
    return { outcome, text: `${out}\n${err}` };
  }

  /** Run one `hermes <args>` command to completion and capture its output. */
  async function runHermes(args, timeoutMs = 20000, extraEnv = {}) {
    if (runtime.exe === null || runtime.exe === undefined) throw new Error(CLI_MISSING);
    return runToCompletion([runtime.exe, ...args], timeoutMs, hermesEnv(extraEnv));
  }

  /**
   * Run one system tool (`netstat`, `taskkill`) to completion. These are
   * Windows process tools that need no Hermes environment.
   */
  async function runTool(args, timeoutMs = 15000) {
    return runToCompletion(args, timeoutMs, process.env);
  }

  /**
   * The absolute path of one allow-listed maintenance script.
   * @param scriptName - one of {@link MAINTENANCE_SCRIPTS}.
   * @returns the script's path.
   */
  function maintenanceScriptPath(scriptName) {
    if (!MAINTENANCE_SCRIPTS.has(scriptName)) throw new Error(`不允许运行的脚本：${scriptName}`);
    if (!runtime.found) throw new Error('没有找到可用的 Hermes 安装。');
    const script = join(runtime.home, 'official-web', scriptName);
    if (!existsSync(script)) throw new Error(`找不到 ${script}`);
    return script;
  }

  /** The PowerShell host that works on this machine, probed once. */
  let shellHost = null;

  /**
   * Resolve the PowerShell host once and remember it.
   *
   * The background upgrade cannot retry a different host the way a one-shot
   * call can — it has to commit to one before it starts — so the choice is made
   * up front with a trivial `exit 0` probe and then reused.
   * @returns the host command.
   */
  async function shellHostFor() {
    if (shellHost !== null) return shellHost;
    let lastError;
    for (const host of POWERSHELL_CANDIDATES) {
      try {
        const { outcome } = await runToCompletion([host, '-NoProfile', '-Command', 'exit 0'], 30000, process.env);
        if (outcome?.exitCode === 0) {
          shellHost = host;
          return host;
        }
        lastError = new Error(`${host} 退出码 ${outcome?.exitCode}`);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error(`无法运行 PowerShell（试过 ${POWERSHELL_CANDIDATES.join('、')}）`);
  }

  /**
   * Build the argv that runs one allow-listed maintenance script.
   * @param host - the PowerShell host command.
   * @param scriptName - one of {@link MAINTENANCE_SCRIPTS}.
   * @param args - switches to pass through.
   * @returns the argument vector.
   */
  function maintenanceArgv(host, scriptName, args) {
    return [host, '-NoProfile', '-Command', maintenanceCommand(maintenanceScriptPath(scriptName), args)];
  }

  /**
   * Run one of Hermes' own maintenance scripts through a PowerShell host.
   *
   * The plugin deliberately owns no install, update or health logic of its own:
   * `official-web/` already ships `install.ps1`, `update.ps1` (with a pre-update
   * snapshot, a post-update SHA256 comparison and a rollback command) and
   * `doctor.ps1`, and those travel with Hermes when it upgrades. Wrapping them
   * keeps this plugin's surface from drifting out of step with the CLI, which is
   * what a hand-rolled equivalent would do.
   *
   * The script name is taken from a fixed allow-list rather than from the
   * request, so the route cannot be pointed at arbitrary code.
   * @param scriptName - one of {@link MAINTENANCE_SCRIPTS}.
   * @param args - switches to pass through.
   * @param timeoutMs - hard budget before the child is terminated.
   * @returns the exit facts, captured text, and the host that ran it.
   */
  async function runMaintenanceScript(scriptName, args, timeoutMs) {
    const host = await shellHostFor();
    const result = await runToCompletion(maintenanceArgv(host, scriptName, args), timeoutMs, hermesEnv());
    return { ...result, host };
  }

  /**
   * Upgrade Hermes by driving its own `update.ps1 -Apply`, in the background.
   *
   * Hermes is stopped first. `update.ps1` runs `pip install --upgrade
   * hermes-agent` against the very virtual environment the dashboard and the
   * gateway are executing from, and on Windows those files are locked while
   * they run — an upgrade attempted over a live installation fails, or worse,
   * half-succeeds. Whatever was running is deliberately NOT restarted
   * afterwards: bringing a freshly upgraded agent back up automatically is a
   * decision the operator should make, not a side effect of pressing a button.
   * @returns the job state after the child was started.
   */
  async function startUpdateApply() {
    if (updateChild !== null) return state.update;
    const host = await shellHostFor();
    const script = maintenanceScriptPath('update.ps1');
    const wasRunning = state.dashboard.status === 'running' || state.gateway.status === 'running';

    state.update = {
      phase: wasRunning ? 'stopping' : 'running',
      wasRunning,
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      error: null,
      output: [],
    };
    log('开始升级 Hermes：先停服务，再跑 update.ps1 -Apply。');
    if (wasRunning) {
      await stopDashboard();
      await stopGateway();
    }
    if (!runtime.found) {
      state.update = { ...state.update, phase: 'error', error: '升级过程中找不到 Hermes 安装了。', finishedAt: Date.now() };
      return state.update;
    }

    state.update = { ...state.update, phase: 'running' };
    updateChild = ctx.subprocess.spawn({
      argv: maintenanceArgv(host, 'update.ps1', ['-Apply']),
      cwd: runtime.home,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1048576 },
        stderr: { maxBytes: 1048576 },
      },
      graceMs: 10000,
      env: hermesEnv(),
    });
    const child = updateChild;
    updateTimer = setTimeout(() => {
      log(`升级超过 ${Math.round(UPDATE_TIMEOUT_MS / 60000)} 分钟，终止子进程。`);
      try {
        child.terminate();
      } catch {
        /* already gone */
      }
    }, UPDATE_TIMEOUT_MS);
    child.done.then(
      (outcome) => {
        if (updateChild !== child) return;
        updateChild = null;
        clearTimeout(updateTimer);
        updateTimer = null;
        const code = outcome?.exitCode;
        state.update = {
          ...state.update,
          phase: code === 0 ? 'done' : 'error',
          exitCode: code,
          finishedAt: Date.now(),
          error: code === 0 ? null : `update.ps1 退出码 ${code}`,
        };
        log(code === 0 ? 'Hermes 升级完成。' : `Hermes 升级失败（退出码 ${code}）——update.ps1 的输出里有回滚命令。`);
      },
      (error) => {
        if (updateChild !== child) return;
        updateChild = null;
        clearTimeout(updateTimer);
        updateTimer = null;
        state.update = {
          ...state.update,
          phase: 'error',
          finishedAt: Date.now(),
          error: error?.message ?? String(error),
        };
        log(`Hermes 升级失败：${state.update.error}`);
      },
    );
    return state.update;
  }

  /**
   * Append install output to the job and the diagnostic ring.
   * @param text - raw chunk or an internal line.
   */

  /**
   * Where a fresh checkout should go.
   * @returns the resolved target directory, or undefined when no home exists.
   */



  /**
   * The DSH root: the directory holding `node_modules/@deepseek-ai/dsh`.
   *
   * Derived rather than configured — the plugin is running inside that
   * installation, so it is a fact, not a preference.
   * @returns the root, or undefined when the harness cannot be located.
   */
  function dshRootPath() {
    const pkg = findUp(HERE, join('node_modules', '@deepseek-ai', 'dsh'));
    if (pkg === undefined) return undefined;
    return dirname(dirname(dirname(pkg)));
  }

  /** @returns the Hermes-environment Python, or undefined. */
  function hermesPython() {
    const candidates = [];
    if (runtime.venv !== null && runtime.venv !== undefined) {
      // A conda env keeps python.exe at its root; a plain venv keeps it in Scripts.
      candidates.push(join(runtime.venv, 'python.exe'), join(runtime.venv, 'Scripts', 'python.exe'));
    }
    if (runtime.exe !== null && runtime.exe !== undefined) {
      const exeDir = dirname(runtime.exe);
      candidates.push(join(dirname(exeDir), 'python.exe'), join(exeDir, 'python.exe'));
    }
    const known = candidates.find((candidate) => existsSync(candidate));
    if (known !== undefined) return known;
    // An upstream installation names no `VENV`, so the interpreter that carries
    // `hermes-agent` (and with it the `mcp` package the bridge imports) is simply
    // the first python on PATH.
    const names = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
    const separator = process.platform === 'win32' ? ';' : ':';
    for (const dir of String(process.env.PATH ?? '').split(separator)) {
      if (dir.trim() === '') continue;
      for (const name of names) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  }

  /** @returns the path of the bridge script shipped inside this package. */
  function bridgeScriptPath() {
    return join(HERE, 'bridge', 'dsh_mcp_server.py');
  }

  /** @returns the shared workspace, or null when none is configured. */
  function sharedWorkspacePath() {
    return conf.sharedWorkspace === '' ? null : conf.sharedWorkspace;
  }

  /**
   * Which Hermes profile is running.
   *
   * `-p companion` makes Hermes set `HERMES_HOME` to `…/profiles/companion` before
   * anything else loads, so the profile's `config.yaml` is the live one and the
   * shell home's is not read at all.
   *
   * `home/active_profile` names it when Hermes left that marker — and it is NOT
   * always there. It had gone missing on a machine where it had been present an
   * hour earlier, and its absence silently fell the plugin back to the root config:
   * writes went to a file Hermes never reads, while the panel reported the values
   * it had just written. So there is a second signal.
   *
   * A running Hermes writes its state as it goes, so **the profile with the newest
   * `state.db` is the one in use**. That survives the marker being absent, and it
   * does not need Hermes to cooperate.
   * @returns the profile name, or null when none can be determined.
   */
  function activeProfileName() {
    const home = runtime.home;
    if (runtime.found !== true || home === null || home === undefined) return null;
    try {
      const named = readFileSync(join(home, 'active_profile'), 'utf8').trim();
      if (named !== '' && existsSync(join(home, 'profiles', named, 'config.yaml'))) return named;
    } catch {
      /* no marker: fall through to the state the running Hermes leaves behind */
    }
    let best = null;
    let bestAt = -1;
    try {
      for (const entry of readdirSync(join(home, 'profiles'), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(home, 'profiles', entry.name);
        if (!existsSync(join(dir, 'config.yaml'))) continue;
        let at = -1;
        try {
          at = statSync(join(dir, 'state.db')).mtimeMs;
        } catch {
          /* a profile that has never run has no state to compare */
        }
        if (at > bestAt) {
          bestAt = at;
          best = entry.name;
        }
      }
    } catch {
      /* no profiles directory: this is a plain home */
    }
    return best;
  }

  /**
   * The `config.yaml` Hermes actually reads.
   *
   * NOT `runtime.home/config.yaml`. Hermes profile homes are NOT merged into the
   * shell home: `-p companion` makes `get_hermes_home()` resolve to
   * `…/home/profiles/companion/`, and the live config is the profile's. Reading and
   * writing the root one is a silent no-op — the panel reports values it just wrote
   * while Hermes ignores them, and 「创建并指向」 writes into a file nothing reads.
   * The bridge entry lives under the same rule, which is why a `mcp_servers.dsh`
   * written to the root never loaded.
   * @returns the path of the config to read and write.
   */
  function liveConfigPath() {
    const root = join(runtime.home, 'config.yaml');
    if (runtime.found !== true || runtime.home === null || runtime.home === undefined) return root;
    const name = activeProfileName();
    if (name === null) return root;
    const profile = join(runtime.home, 'profiles', name, 'config.yaml');
    return existsSync(profile) ? profile : root;
  }

  /**
   * The workspace a Hermes-driven DSH run uses.
   *
   * One workspace, not two: the shared workspace when one is configured, and the DSH
   * root's parent otherwise — the layout the bridge was written for. A separate
   * `bridgeWorkspace` setting used to win here, which let the panel call a directory
   * "shared" while the bridge was told to run somewhere else. It is retired, and
   * `verify/bridge.mjs` pins that a value for it is ignored.
   * @returns the workspace path, or null when none can be determined.
   */
  function bridgeWorkspacePath() {
    // One workspace, not two. `bridgeWorkspace` used to override this, which meant
    // the panel could say "shared" about a directory the bridge was not told to use.
    const shared = sharedWorkspacePath();
    if (shared !== null) return shared;
    const root = dshRootPath();
    return root === undefined ? null : dirname(root);
  }

  /** @param value - a workspace projection field. @returns its string form, or null. */
  function asText(value) {
    return typeof value === 'string' && value !== '' ? value : null;
  }

  /**
   * DSH's own Workspace registry, looked up softly.
   *
   * The registry is what the sidebar lists and what the workspace picker's
   * "Add workspace…" adopts into, so registering here is the same durable
   * operation the picker performs — a plugin cannot add an entry to that menu
   * (its directory-flow hole is `single`, already held by the picker), and it
   * does not need to: owning the canonical directory is the whole requirement,
   * and DSH then groups every session recorded in it under one node.
   *
   * Soft, like `settings` in this plugin and `configForms` in the client half:
   * a deployment that composes no web layer keeps a working panel with no
   * workspace registration rather than failing to load.
   * @returns the registry, or undefined when the deployment has none.
   */
  function workspaceRegistry() {
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
      if (registry !== undefined && registry !== null && typeof registry.create === 'function') return registry;
    } catch {
      /* an unavailable registry is the "cannot register" case, not a failure */
    }
    return undefined;
  }

  /**
   * Put the shared workspace in the sidebar, once.
   *
   * This is what makes the directory observable: DSH groups a Session under the
   * Workspace owning its canonical cwd, so the sessions Hermes drives over the
   * bridge — each one a real `dsh --json` run with `cwd` = the shared
   * workspace — become rows under it instead of being invisible. The directory
   * must exist first, because the registry canonicalizes through `fs.realpath`
   * and rejects a missing path; registration is not what creates it.
   *
   * Idempotent: the registry reuses the record already owning that canonical
   * path, so repeated calls neither duplicate nor reorder anything.
   * @returns the registration outcome the panel renders.
   */
  /**
   * Remove the shared-workspace rows this plugin left behind for other directories.
   *
   * Changing the shared workspace registers the new one and leaves the old one in
   * the sidebar for ever — two rows, same title, different paths, and no way to tell
   * which is which. Only this plugin's own rows go: they are recognised by the title
   * prefix, and a row whose path is not the current shared workspace is a leftover.
   *
   * Best-effort. A registry without `delete`, or one that refuses, must not fail the
   * registration that already succeeded.
   * @param registry - the workspace registry.
   * @param keep - the path the shared workspace now is.
   * @returns nothing.
   */
  async function dropStaleSharedWorkspaces(registry, keep) {
    if (typeof registry.delete !== 'function' || typeof registry.list !== 'function') return;
    const wanted = canonicalPath(keep);
    let rows = [];
    try {
      rows = await registry.list();
    } catch {
      return;
    }
    for (const row of rows ?? []) {
      const title = typeof row?.title === 'string' ? row.title : '';
      if (!title.startsWith('共享工作区')) continue;
      if (typeof row.path !== 'string' || canonicalPath(row.path) === wanted) continue;
      try {
        await registry.delete(row.id);
      } catch {
        /* a row that refuses to go is the user's to remove, not a failure here */
      }
    }
  }

  async function registerSharedWorkspace() {
    const path = sharedWorkspacePath();
    if (path === null) return { registered: false, workspaceId: null, error: '没有配置共享工作区。' };
    if (!existsSync(path)) {
      return { registered: false, workspaceId: null, error: `目录还不存在：${path}。先按「创建并指向」。` };
    }
    const registry = workspaceRegistry();
    if (registry === undefined) {
      return { registered: false, workspaceId: null, error: '这个 DSH 组合没有工作区注册表（web 层才挂载），无法加入侧边栏。' };
    }
    try {
      // The title carries the directory. A fixed string put two DIFFERENT paths in
      // the sidebar under one identical name, and there was no way to tell which
      // was which — the sidebar showed 「共享工作区（Hermes ↔ DSH）」 twice.
      const workspace = await registry.create(path, `共享工作区 · ${basename(path)}`);
      await dropStaleSharedWorkspaces(registry, path);
      return { registered: true, workspaceId: asText(workspace?.id), error: null };
    } catch (error) {
      return { registered: false, workspaceId: null, error: error?.message ?? String(error) };
    }
  }

  /**
   * Write an edit to Hermes' `config.yaml` under a backup, and let Hermes itself
   * decide whether it stands.
   *
   * `config.yaml` is where a Hermes deployment keeps its plaintext provider keys
   * and its comments, so a write that cannot be undone is not one this plugin is
   * entitled to make: the previous file is copied beside it, and
   * `hermes config check` must accept the result or the copy is restored.
   * @param config - the config path.
   * @param after - the full new contents.
   * @param label - what was written, for the log.
   * @returns whether anything changed, and the backup path.
   */
  async function writeConfigVerified(config, after, label) {
    const before = readFileSync(config, 'utf8');
    if (after === before) return { changed: false, backup: null };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${config}.bak-${stamp}`;
    copyFileSync(config, backup);
    writeFileSync(config, after, 'utf8');
    log(`已写入 ${label}，备份：${backup}`);

    try {
      const check = await runHermes(['config', 'check'], 60000);
      const code = check.outcome?.exitCode;
      if (code !== 0) {
        copyFileSync(backup, config);
        log(`hermes config check 退出码 ${code}，已从备份回滚。`);
        throw new Error(`写入后 hermes config check 失败（退出码 ${code}），已回滚 config.yaml。输出：${check.text.trim().slice(-600)}`);
      }
      log('hermes config check 通过。');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('写入后')) throw error;
      // The check itself could not run; the write stands, but say so honestly.
      log(`无法验证 config.yaml：${error?.message ?? error}`);
    }
    return { changed: true, backup };
  }

  /**
   * Open the machine's own folder picker and return what was chosen.
   *
   * The dialog has to run on the Host: the path addresses the Host's filesystem,
   * and browsers deliberately hide absolute paths from `<input type="file"
   * webkitdirectory>`, so a browser-side picker could not return one anyway. A
   * cancelled dialog is not an error — it comes back as `cancelled`.
   * @param description - the dialog's caption.
   * @returns the chosen path, or a cancellation.
   */
  async function pickDirectory(description) {
    if (process.platform !== 'win32') {
      throw new Error('目录选择器目前只在 Windows 上可用，请在设置里直接填路径。');
    }
    const host = await shellHostFor();
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$dialog.Description = ${JSON.stringify(description)}`,
      '$dialog.ShowNewFolderButton = $true',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }',
    ].join('; ');
    // -STA: the common file dialogs require a single-threaded apartment.
    //
    // Two minutes, not five. This is a MODAL WinForms window opened from a process
    // with no visible window of its own, so it can come up behind everything — and
    // the panel shows 「等待选择…」 for as long as this waits. Five minutes of that is
    // indistinguishable from a freeze, which is exactly how it was reported. The
    // browser half asks DSH's own picker first and only lands here on a composition
    // that has none, so this is the rare path rather than the normal one.
    const { text, outcome } = await runToCompletion([host, '-STA', '-NoProfile', '-Command', script], 120000, process.env);
    if (outcome?.exitCode !== 0) {
      throw new Error(`目录选择器退出码 ${outcome?.exitCode}（这台机器可能没有可用的桌面会话）。请在设置里直接填路径。`);
    }
    const chosen = text.trim();
    return { path: chosen === '' ? null : chosen, cancelled: chosen === '' };
  }

  /**
   * What the shared workspace looks like right now.
   *
   * Both halves are reported because they fail independently: the directory and
   * its `AGENTS.md` are one thing, and whether Hermes' own `terminal.cwd` points
   * there is another.
   * @returns the status the panel renders.
   */
/**
 * What is inside a Hermes home, cheaply enough to answer a status refresh.
 *
 * A path that is right and a path that is wrong look the same in a text box, so
 * "is this the directory I meant" needs evidence from the directory itself.
 * @param home - the volume path.
 * @returns the report, or null when the directory is not there.
 */
function describeHome(home) {
  if (typeof home !== 'string' || home === '' || !existsSync(home)) return null;
  const report = {
    path: home,
    profiles: [],
    stateBytes: 0,
    officialWeb: existsSync(join(home, 'official-web', '.env')),
    config: existsSync(join(home, 'config.yaml')),
  };
  try {
    for (const entry of readdirSync(join(home, 'profiles'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      report.profiles.push(entry.name);
      try {
        report.stateBytes += statSync(join(home, 'profiles', entry.name, 'state.db')).size;
      } catch {
        /* a profile that has never run has no state */
      }
    }
  } catch {
    /* an upstream installation keeps state somewhere else */
  }
  return report;
}

  function workspaceStatus() {
    const path = sharedWorkspacePath();
    // Read synchronously: `create()` is async, but listing is not, and the panel
    // needs to know whether the directory is already in the sidebar.
    const registry = workspaceRegistry();
    const registered = registry === undefined || path === null
      ? false
      : registry.list().some((workspace) => workspace.path === path);
    // The volume is its own fact, separate from the shared workspace: one is where
    // Hermes keeps its data, the other is where both agents work.
    const volume = conf.dataDir !== '' ? conf.dataDir : defaultDataDir();
    const status = {
      dataDir: volume,
      volume: describeHome(volume),
      configured: path !== null,
      path,
      exists: path === null ? false : existsSync(path),
      contextPath: path === null ? null : join(path, 'AGENTS.md'),
      contextExists: false,
      contextBytes: null,
      hermesTerminalCwd: null,
      hermesPointsHere: null,
      bridgeWorkspace: bridgeWorkspacePath(),
      // Whether the sidebar lists this directory, and whether it could. The two
      // say different things: "not listed" plus "cannot register" is a
      // deployment fact (no web layer), not a pending action.
      registered,
      canRegister: registry !== undefined,
      needsRegistration: path !== null && registry !== undefined && !registered && existsSync(path),
    };
    if (path !== null && status.contextExists === false && existsSync(status.contextPath)) {
      status.contextExists = true;
      try {
        status.contextBytes = statSync(status.contextPath).size;
      } catch {
        /* leave the size unknown */
      }
    }
    if (!runtime.found) return status;
    // The ACTIVE profile's config: see liveConfigPath. Reading the shell home here
    // reported `terminal.cwd` as unset on a machine where it is plainly set.
    const config = liveConfigPath();
    if (!existsSync(config)) return status;
    try {
      const raw = readBlockScalar(readFileSync(config, 'utf8'), 'terminal', 'cwd');
      if (raw !== null) {
        status.hermesTerminalCwd = raw.replace(/^['"]|['"]$/g, '');
        status.hermesPointsHere = path !== null
          && status.hermesTerminalCwd.replace(/\\/g, '/').toLowerCase() === path.replace(/\\/g, '/').toLowerCase();
      }
    } catch {
      /* an unreadable config is reported by the bridge status instead */
    }
    return status;
  }

  /**
   * DSH's own session corpus, looked up softly.
   *
   * `dsh-base` mounts `session-query-sqlite` with `openAt: never`, so exact
   * reads and the corpus listing are available while content search is not —
   * which is all this panel needs: it lists sessions by working directory and
   * reads one log at a time.
   * @returns the query service, or undefined when the deployment has none.
   */
  function sessionQuery() {
    try {
      const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
      if (query !== undefined && query !== null && typeof query.listSessions === 'function') return query;
    } catch {
      /* an unavailable corpus is the "no records" case, not a failure */
    }
    return undefined;
  }

  /** Normalize a path for comparison: forward slashes, no trailing separator, lower case. */
  function canonicalPath(value) {
    return samePath(value);
  }

  /** @param value - an event timestamp. @returns `HH:MM` in local time, or ''. */
  function shortestTime(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '';
    const at = new Date(value);
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  }

  /** @param value - an event timestamp. @returns an ISO string, or null. */
  function isoTime(value) {
    return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
  }

  /**
   * Which events belong on the model-visible surface.
   *
   * `isAppendSurfaceEvent` and the surface-type set live in `@deepseek-ai/dsh-session`,
   * which a `link:`-installed plugin cannot resolve: the ~300 harness packages sit
   * one level below the `dsh` package, and DSH runs without `--preserve-symlinks`,
   * so a bare import from this package's real path throws. The predicate is
   * therefore inlined — it is two facts, and they are stable:
   *
   *  - only `system/message`, `developer/message`, `user/message`,
   *    `assistant/message` and `tool/result` are surface events, so
   *    `tool/call` — which is log-only — never gets one;
   *  - an event is *appended* to that surface when its `surfaceOp` says so.
   *    A replaced or shadowed event is history the model no longer sees, which
   *    is exactly what a transcript should leave out.
   *
   * Inlining this is the lesser risk: an import that cannot resolve costs the
   * whole plugin, because DSH startup is all-or-nothing.
   */
  const SURFACE_EVENT_TYPES = new Set([
    'system/message',
    'developer/message',
    'user/message',
    'assistant/message',
    'tool/result',
  ]);

  /** @param event - one session event. @returns true when it was appended to the visible surface. */
  function isAppendSurfaceEvent(event) {
    return event?.surfaceOp === 'append' && SURFACE_EVENT_TYPES.has(event.type);
  }

  /**
   * Flatten one message's content blocks into transcript entries.
   *
   * The fold is deliberately shallow and additive: unknown block types are
   * skipped rather than fatal, because DSH's content and event vocabularies are
   * merge-extensible and a plugin that refused an unknown block would stop
   * rendering the whole record after an upgrade.
   * @param blocks - `ContentBlock[]` from a message.
   * @param time - the event timestamp.
   * @param role - the role the message belongs to.
   * @param options - `kind` overrides the user (injected) kind; `tool` labels a tool result.
   * @returns one entry per renderable block.
   */
  function blocksToEntries(blocks, time, role, options = {}) {
    const entries = [];
    if (!Array.isArray(blocks)) return entries;
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        entries.push({ role, kind: options.kind ?? role, text: block.text, tool: options.tool ?? null, time });
      } else if (block.type === 'reasoning' && typeof block.text === 'string' && block.text !== '') {
        entries.push({ role, kind: 'reasoning', text: block.text, tool: null, time });
      } else if (block.type === 'tool-call') {
        entries.push({ role, kind: 'tool-call', text: typeof block.arguments === 'string' ? block.arguments : '', tool: asText(block.name), time });
      } else if (block.type === 'image' || block.type === 'file') {
        entries.push({ role, kind: 'attachment', text: block.type, tool: null, time });
      }
    }
    return entries;
  }

  /**
   * Fold one session log into an ordered, human-readable transcript.
   *
   * The map below is the whole transcript policy, and each line of it is a
   * decision rather than a filter for its own sake:
   *
   *  - **appended surface events only** — a replaced or shadowed event is
   *    history the model no longer sees, so a transcript that kept it would show
   *    text the agent had already discarded;
   *  - **`assistant/message` is the answer** — its content blocks carry the
   *    step's reasoning, its visible text *and* its tool calls, which is why the
   *    log-only `tool/call` event must not be rendered as well: the call would
   *    appear twice;
   *  - **`tool/call` still pays for itself as an index** — it is where a tool's
   *    `callId` meets its name, and `tool/result` only carries the id back;
   *  - **a user message with a non-`user` source is injected context**, not
   *    something the human typed, and says so.
   *
   * System-prompt and developer events are omitted on purpose: this view exists
   * to show what the two agents said to each other, not the request envelope.
   * @param events - `SessionEvent[]` from one session log.
   * @returns transcript entries in log order.
   */
  function foldTranscript(events) {
    const entries = [];
    if (!Array.isArray(events)) return entries;

    // One pass for the call index, so a tool result can name its tool even when
    // the result message itself does not.
    const toolNames = new Map();
    for (const event of events) {
      if (event?.type === 'tool/call' && typeof event.data?.callId === 'string') {
        toolNames.set(event.data.callId, asText(event.data.name));
      }
    }

    for (const event of events) {
      if (!isAppendSurfaceEvent(event)) continue;
      const data = event.data;
      if (data === null || typeof data !== 'object') continue;
      const time = event.time;
      if (event.type === 'user/message') {
        const source = data.message?.source;
        const injected = typeof source?.kind === 'string' && source.kind !== 'user';
        entries.push(...blocksToEntries(data.message?.content, time, 'user', injected ? { kind: 'context' } : {}));
      } else if (event.type === 'assistant/message') {
        entries.push(...blocksToEntries(data.message?.content, time, 'assistant'));
      } else if (event.type === 'tool/result') {
        const message = data.message;
        const callId = typeof message?.toolCallId === 'string' ? message.toolCallId : message?.source?.callId;
        entries.push(...blocksToEntries(message?.content, time, 'tool', {
          kind: message?.isError === true ? 'tool-error' : 'tool-result',
          tool: asText(message?.toolName) ?? toolNames.get(callId) ?? null,
        }));
      }
    }
    return entries;
  }

  /**
   * The sessions recorded in the shared workspace.
   *
   * This is the record the panel was missing: Hermes drives DSH over the bridge
   * by running `dsh --json` with `cwd` set to the shared workspace, so each
   * exchange is a real session log — it simply had no visible home until the
   * directory was registered as a Workspace. Titles are folded only for the page
   * actually returned, because every fold is a read of that session's log.
   * @param limit - maximum rows to return.
   * @returns the list payload the panel renders.
   */
  async function readWorkspaceSessions(limit) {
    const path = sharedWorkspacePath();
    const journal = journalPath();
    const payload = {
      available: false,
      reason: null,
      workspace: { path, registered: workspaceStatus().registered, workspaceId: null, journal },
      sessions: [],
      truncated: false,
    };

    // The journal is the whole record. An absent one is not an error: it means the
    // bridge has not driven anything yet on this machine.
    let lines = [];
    try {
      lines = readFileSync(journal, 'utf8').split('\n');
    } catch {
      payload.reason = '桥还没有记下任何一次运行。';
      payload.sessions = [];
      return payload;
    }
    const entries = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* a torn last line from a kill mid-write costs one row, not the list */
      }
    }
    // Newest first: the run you just watched is the one you are looking for.
    entries.reverse();
    const page = entries.slice(0, limit);
    payload.truncated = entries.length > page.length;
    payload.available = true;

    // The workspace half, for the section header.
    const registry = workspaceRegistry();
    if (registry !== undefined && path !== null) {
      try {
        const workspace = await registry.resolveByPath(path);
        payload.workspace.workspaceId = workspace === undefined ? null : asText(workspace.id);
        payload.workspace.registered = workspace !== undefined;
      } catch {
        /* an uncanonical path cannot be registered; the directory report covers it */
      }
    }

    // Titles and the live flag come from the store; they are the one thing the
    // journal does not have, and a missing store costs a title, not a row.
    const titles = new Map();
    const live = new Set();
    const query = sessionQuery();
    if (query !== undefined) {
      try {
        for (const record of await query.listSessions()) {
          const id = String(record?.header?.id ?? '');
          if (id !== '' && record?.live === true) live.add(id);
        }
      } catch {
        /* the live flags are a convenience */
      }
      try {
        const results = await query.readTitleSnapshots(page.map((entry) => String(entry.id)));
        for (const result of results) {
          if (result?.status !== 'fulfilled') continue;
          const id = result.value?.session?.id ?? result.sessionId;
          const title = result.value?.title?.title;
          if (typeof id === 'string' && typeof title === 'string' && title !== '') titles.set(id, title);
        }
      } catch {
        /* unreadable titles leave the rows untitled */
      }
    }

    const target = path === null ? null : canonicalPath(path);
    payload.sessions = page.map((entry) => {
      const id = String(entry.id);
      const cwd = typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : null;
      return {
        id,
        // What Hermes ASKED. The transcript cannot say this: the task arrives as a
        // CLI argument and is not the session's first user message.
        task: typeof entry.task === 'string' ? entry.task : null,
        title: titles.get(id) ?? null,
        time: isoTime(entry.at),
        since: entry.at,
        cwd,
        exit: typeof entry.exit === 'number' ? entry.exit : null,
        profile: typeof entry.profile === 'string' ? entry.profile : null,
        shared: target !== null && cwd !== null && canonicalPath(cwd) === target,
        live: live.has(id),
        persisted: true,
      };
    });
    return payload;
  }

  /**
   * One session's transcript, folded for the panel.
   *
   * `readSession` replays and validates the log rather than tailing it, so a log
   * this build cannot reconstruct fails as a message here — which is why the
   * route reports the failure instead of rendering a partial conversation that
   * would read as if the rest had never happened.
   * @param sessionId - the session to read.
   * @param maxChars - per-entry text bound.
   * @returns the transcript payload the panel renders.
   */
  async function readWorkspaceSession(sessionId, maxChars) {
    const path = sharedWorkspacePath();
    const payload = {
      available: false,
      reason: null,
      session: { id: sessionId, title: null, time: null, cwd: null },
      workspace: { path, registered: workspaceStatus().registered },
      truncated: false,
      entries: [],
    };
    const query = sessionQuery();
    if (query === undefined) {
      payload.reason = '这个 DSH 组合没有 sessionQuery，读不到会话内容。';
      return payload;
    }
    let snapshot = null;
    try {
      snapshot = await query.readSession(sessionId);
    } catch (error) {
      payload.reason = `读取会话失败：${error?.message ?? String(error)}`;
      return payload;
    }
    const header = snapshot?.session;
    if (header === undefined || header === null) {
      payload.reason = `找不到会话 ${sessionId}。`;
      return payload;
    }
    payload.session.id = String(header.id);
    payload.session.cwd = asText(header.cwd);
    payload.session.time = isoTime(header.createdAt);
    // A record outside the workspace is still a record. The bridge takes a cwd per
    // call and the journal keeps every run, including the ones from before the
    // workspace was pointed here — refusing to read them left the list offering
    // rows it would not open. The page says where the session ran instead.
    payload.outside = path !== null && payload.session.cwd !== null
      && canonicalPath(payload.session.cwd) !== canonicalPath(path);
    try {
      const title = await query.readTitle(sessionId);
      payload.session.title = asText(title?.title);
    } catch {
      /* an untitled session is fine */
    }

    payload.available = true;
    let truncated = false;
    for (const entry of foldTranscript(snapshot.events)) {
      const text = entry.text.trim();
      if (text === '') continue;
      const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
      if (clipped !== text) truncated = true;
      payload.entries.push({
        role: entry.role,
        kind: entry.kind,
        tool: entry.tool,
        text: clipped,
        time: isoTime(entry.time),
        clock: shortestTime(entry.time),
      });
    }
    payload.truncated = truncated;
    return payload;
  }

  /**
   * Create the shared workspace, its `AGENTS.md`, and point Hermes at it.
   *
   * `AGENTS.md` is the shared context: DSH's `dsh-agent-instructions` looks for
   * that exact name, and Hermes' own `agent_init` / `prompt_builder` /
   * `runtime_cwd` read it too. No format conversion is involved — both sides
   * already agree on the file, so the plugin only has to make it exist in a
   * directory both sides work in.
   *
   * An existing `AGENTS.md` is never overwritten: it is the operator's file.
   * @returns what was created or changed.
   */
  async function applyWorkspace() {
    const path = sharedWorkspacePath();
    if (path === null) throw new Error('没有配置 sharedWorkspace：请先填一个共享目录。');

    let createdDirectory = false;
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
      createdDirectory = true;
      log(`已创建共享工作区：${path}`);
    }

    // Registration deliberately reports its own outcome; the path is already in
    // the returned status, so nothing here repeats it.

    const context = join(path, 'AGENTS.md');
    let createdContext = false;
    if (!existsSync(context)) {
      writeFileSync(context, AGENTS_TEMPLATE, 'utf8');
      createdContext = true;
      log(`已创建共享上下文：${context}`);
    }

    // Registering is what makes the directory — and every session recorded
    // inside it, including the ones Hermes drives over the bridge — show up in
    // the sidebar. It runs independently of discovery on purpose: a machine with
    // no Hermes yet still gets a workspace the operator can open and work in.
    const registration = await registerSharedWorkspace();
    if (registration.registered) log(`共享工作区已加入侧边栏：${path}`);

    if (!runtime.found) {
      return {
        changed: createdDirectory || createdContext || registration.registered,
        createdDirectory,
        createdContext,
        registered: registration.registered,
        registrationError: registration.error,
        configChanged: false,
        backup: null,
        note: '没有找到 Hermes，跳过了 terminal.cwd。',
      };
    }
    // The ACTIVE profile's config, not the shell home's: see liveConfigPath.
    const config = liveConfigPath();
    if (!existsSync(config)) {
      return {
        changed: createdDirectory || createdContext || registration.registered,
        createdDirectory,
        createdContext,
        registered: registration.registered,
        registrationError: registration.error,
        configChanged: false,
        backup: null,
        note: `找不到 ${config}，跳过了 terminal.cwd。`,
      };
    }
    // Both halves of "shared" in ONE write.
    //
    // `terminal.cwd` is where Hermes' own shell runs; `mcp_servers.dsh`'s
    // `DSH_MCP_WORKSPACE` is where the bridge runs DSH. Writing only the first is
    // how a file asked for "in the workspace" landed in the directory the bridge was
    // last configured with, while the panel reported the two as agreeing. They have
    // to move together or they are not shared.
    //
    // One write, not two: the same file, so one backup, one `hermes config check`,
    // one atomic replacement — and a failure rolls back both rather than half.
    const { text: after, action } = upsertBlockScalar(readFileSync(config, 'utf8'), 'terminal', 'cwd', yamlScalar(path));
    let text = after;
    let bridgeChanged = false;
    let bridgeError = null;
    try {
      const entry = bridgeEntryFor(path);
      const upserted = upsertMcpServerEntry(text, 'dsh', entry);
      text = upserted.text;
      bridgeChanged = upserted.text !== after;
    } catch (error) {
      // The bridge needs a python and a DSH root; a machine missing one still gets
      // its `terminal.cwd`, and the reason travels back in the result.
      bridgeError = error?.message ?? String(error);
    }
    const written = await writeConfigVerified(config, text, `共享工作区（terminal.cwd${bridgeChanged ? ' + mcp_servers.dsh' : ''}，${action}）`);

    // The bridge reads DSH_MCP_WORKSPACE from its own environment when it starts,
    // which is when the Hermes gateway starts. A gateway started before this write
    // keeps driving DSH in the old directory until it is restarted — and the run
    // shows up in the record list as "outside the workspace", looking like a bug.
    const gatewayRunning = state.gateway !== undefined && state.gateway !== null && state.gateway.status === 'running';

    return {
      changed: createdDirectory || createdContext || registration.registered || written.changed,
      createdDirectory,
      createdContext,
      registered: registration.registered,
      registrationError: registration.error,
      action,
      configChanged: written.changed,
      backup: written.backup,
      // Reported rather than thrown: `terminal.cwd` is written by now, and a bridge
      // that could not be built must not roll that back.
      bridgeChanged,
      bridgeError,
      note: gatewayRunning && written.changed
        ? '已写入。Hermes 网关正在运行，要重启一次它才会用上新的工作目录；在那之前 dsh_run 仍按旧目录跑。'
        : null,
    };
  }

  /**
   * What the two halves of the bridge currently look like.
   *
   * The Hermes half is a `mcp_servers.dsh` entry in `config.yaml`; the DSH half
   * is the `@deepseek-ai/dsh-mcp-client` package the profile resolves, which
   * DSH disables the row over when it does not match the runtime. Both are read
   * here rather than assumed, because "the bridge exists" and "the bridge works"
   * are different claims.
   * @returns the status the panel renders.
   */
  function bridgeStatus() {
    const script = bridgeScriptPath();
    const root = dshRootPath();
    const status = {
      available: runtime.found,
      configPath: runtime.found ? liveConfigPath() : null,
      scriptPath: script,
      scriptPresent: existsSync(script),
      dshRoot: root ?? null,
      python: hermesPython() ?? null,
      dshVersion: null,
      profiles: [],
      clientCompatible: null,
      workspace: null,
      profile: '',
      configured: false,
      pointsAtThisCopy: false,
      entry: null,
    };
    if (root !== undefined) {
      try {
        const dshPkg = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
        status.dshVersion = JSON.parse(readFileSync(dshPkg, 'utf8')).version ?? null;
      } catch {
        /* leave it unknown */
      }
      // A profile's rows resolve through THAT profile's node_modules, which is
      // a different tree from the one the dsh package carries — checking the
      // bundled copy would report a healthy version while the rows are disabled.
      const profilesDir = join(root, 'home', 'profiles');
      try {
        for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const manifest = join(profilesDir, entry.name, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'package.json');
          if (!existsSync(manifest)) continue;
          let version = null;
          try {
            version = JSON.parse(readFileSync(manifest, 'utf8')).version ?? null;
          } catch {
            /* leave it unknown */
          }
          status.profiles.push({
            name: entry.name,
            version,
            compatible: version === null ? null : version === status.dshVersion,
          });
        }
      } catch {
        /* no profiles directory: nothing to report */
      }
      const known = status.profiles.filter((profile) => profile.compatible !== null);
      status.clientCompatible = known.length === 0 ? null : known.every((profile) => profile.compatible === true);
    }
    if (!status.available || status.configPath === null || !existsSync(status.configPath)) return status;
    status.workspace = bridgeWorkspacePath();
    try {
      const lines = readMcpServerEntry(readFileSync(status.configPath, 'utf8'), 'dsh');
      status.entry = lines === null ? null : lines.join('\n');
      status.configured = lines !== null;
      status.pointsAtThisCopy = lines !== null && configuredRunsScript(lines.join('\n'), script);
    } catch {
      /* unreadable config is reported by `available` */
    }
    return status;
  }

  /**
   * Write (or refresh) the Hermes half of the bridge.
   *
   * The file is edited surgically and then *verified by Hermes itself*: a
   * backup is taken first, and `hermes config check` must accept the result or
   * the backup is restored. `config.yaml` is where a Hermes deployment keeps its
   * plaintext provider keys, so a write that cannot be undone is not one this
   * plugin is entitled to make.
   * @returns what changed.
   */
  /**
   * The `mcp_servers.dsh` entry for a given workspace, or a reason it cannot be built.
   * @param workspace - the directory the bridge should run DSH in.
   * @returns the entry's lines.
   */
  function bridgeEntryFor(workspace) {
    if (!runtime.found) throw new Error('没有找到可用的 Hermes 安装。');
    const script = bridgeScriptPath();
    if (!existsSync(script)) throw new Error(`找不到随插件分发的桥脚本：${script}`);
    const python = hermesPython();
    if (python === undefined) {
      throw new Error('找不到可以跑桥的 python：这个 Hermes 安装里没有 python.exe，PATH 上也没有。');
    }
    const root = dshRootPath();
    if (root === undefined) throw new Error('找不到 DSH 安装根（node_modules/@deepseek-ai/dsh 的上一层）。');
    return renderBridgeEntry({
      python,
      script,
      dshRoot: root,
      workspace,
      profile: '',
      journal: journalPath(),
    });
  }

  /**
   * Write the `mcp_servers.dsh` entry so the bridge runs in `workspace`.
   *
   * Factored out of `applyBridge` because 「创建并指向」 has to move the same value.
   * The bridge reads its working directory from this entry and nothing else moves
   * it, so a shared workspace that only reaches `terminal.cwd` is shared with Hermes
   * and not with DSH.
   * @param workspace - the directory the bridge should run DSH in.
   * @returns what was written, including whether the text actually changed.
   */
  async function applyBridgeWorkspace(workspace) {
    // The ACTIVE profile's config: see liveConfigPath. Writing the bridge entry to
    // the shell home is why it was never loaded until it was added by hand.
    const config = liveConfigPath();
    if (!existsSync(config)) throw new Error(`找不到 ${config}`);
    const entry = bridgeEntryFor(workspace);
    const before = readFileSync(config, 'utf8');
    const { text: after, action } = upsertMcpServerEntry(before, 'dsh', entry);
    const written = await writeConfigVerified(config, after, `mcp_servers.dsh（${action}）`);
    return {
      changed: written.changed,
      action,
      backup: written.backup,
      configPath: config,
      entry,
      workspace,
    };
  }

  async function applyBridge() {
    const workspace = bridgeWorkspacePath();
    if (workspace === null) throw new Error('无法确定桥的工作区：请先配置共享工作区（sharedWorkspace）。');
    return applyBridgeWorkspace(workspace);
  }

  /**
   * PIDs with a LISTENING socket on a local TCP port, per `netstat -ano`.
   *
   * Only lines whose LOCAL address is the port count. netstat also lists every
   * established connection that merely *targets* the port, and those lines
   * carry the CLIENT pid — killing those would take down the browser (or this
   * very DSH page) instead of the server. The state word is deliberately not
   * matched, because netstat localizes it.
   */
  async function listeningPids(port) {
    const { text } = await runTool(['netstat', '-ano']);
    const suffix = `:${port}`;
    const pids = new Set();
    for (const line of text.split(/\r?\n/)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 5 || fields[0] !== 'TCP') continue;
      if (!fields[1].endsWith(suffix)) continue;
      const pid = Number(fields[fields.length - 1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  }

  /**
   * End a process together with everything it spawned.
   *
   * `hermes dashboard` is a wrapper: the launcher stays alive while its child
   * serves the port, and the server in turn spawns one TUI worker per open
   * chat session. Killing only the wrapper would leave the listener behind, so
   * the whole tree has to go.
   */
  async function killTree(pid) {
    if (process.platform !== 'win32') {
      try {
        process.kill(pid);
        return true;
      } catch (error) {
        log(`结束 PID ${pid} 失败：${error?.message ?? error}`);
        return false;
      }
    }
    const { outcome, text } = await runTool(['taskkill', '/PID', String(pid), '/T', '/F']);
    const code = outcome?.exitCode;
    if (code !== 0) log(`taskkill PID ${pid} 失败（exitCode=${code}）：${text.trim()}`);
    return code === 0;
  }

  /** A gateway heartbeat older than this counts as dead (the gateway writes every ~30s). */
  const GATEWAY_STALE_SECONDS = 300;

  /**
   * Read a profile's gateway truth from disk, with no subprocess at all.
   *
   * `hermes cron status` cannot answer this on Windows 11: its process discovery
   * shells out to `wmic`/`Get-CimInstance Win32_Process`, and from a DSH-hosted
   * shell that comes back empty, so a live gateway is reported as "not running"
   * (2026-10-16: two gateways were live while `cron status` said none was). The
   * gateway itself writes `<profile>/gateway_state.json` and refreshes
   * `<profile>/state/gateway.heartbeat`, which is what this reads.
   */
  function readGatewayFiles(dir) {
    if (dir === null || dir === undefined) return null;
    const stateFile = join(dir, 'gateway_state.json');
    const heartbeatFile = join(dir, 'state', 'gateway.heartbeat');
    let pid = null;
    let gatewayState = null;
    let platforms = null;
    try {
      if (existsSync(stateFile)) {
        const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
        pid = Number.isInteger(raw?.pid) ? raw.pid : null;
        gatewayState = typeof raw?.gateway_state === 'string' ? raw.gateway_state : null;
        platforms = raw?.platforms ?? null;
      }
    } catch {
      /* a torn write mid-save: report unknown rather than guessing */
    }
    let heartbeatAgeMs = null;
    try {
      if (existsSync(heartbeatFile)) heartbeatAgeMs = Date.now() - statSync(heartbeatFile).mtimeMs;
    } catch {
      /* ignore */
    }
    return { pid, gatewayState, platforms, heartbeatAgeMs };
  }

  /** Signal 0 probes existence on Windows too; EPERM means "alive, not ours". */
  function pidLooksAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }

  /**
   * Report the DEFAULT profile's gateway (api_server / cron). Deliberately never
   * looks at companion's QQ gateway: those are separate processes now, and the
   * stop button must not be able to take QQ down with it.
   */
  async function probeGateway() {
    const info = readGatewayFiles(runtime.home ?? null);
    const ageSeconds = info?.heartbeatAgeMs === null || info?.heartbeatAgeMs === undefined
      ? null
      : Math.floor(info.heartbeatAgeMs / 1000);
    const stale = ageSeconds === null || ageSeconds > GATEWAY_STALE_SECONDS;
    const pid = info?.pid ?? null;
    const alive = pidLooksAlive(pid);
    const stateLabel = String(info?.gatewayState ?? '').toLowerCase();
    const failed = stateLabel === 'startup_failed' || stateLabel === 'failed';
    const running = info !== null && !stale && alive && !failed;
    const platforms = Object.entries(info?.platforms ?? {}).map(
      ([name, value]) => `${name}=${value?.state ?? 'unknown'}`,
    );
    state.gateway = {
      status: running ? 'running' : alive ? 'starting' : 'stopped',
      owned: gatewayChild !== null,
      pid,
      pids: Number.isInteger(pid) ? [pid] : [],
      detail: running ? 'healthy' : 'stopped',
      source: 'gateway_state.json',
      platforms,
      heartbeatAgeSeconds: ageSeconds,
      warning: null,
      error: null,
    };
    if (!running && !alive && ageSeconds !== null && ageSeconds <= GATEWAY_STALE_SECONDS) {
      state.gateway.warning = `网关心跳 ${ageSeconds}s 前还在跳，但 PID ${pid ?? '?'} 已经不在了。`;
      log(state.gateway.warning);
    }
    return state.gateway;
  }

  /** Ensure the messaging gateway is up. */
  async function startGateway() {
    if (!conf.manageGateway) return state.gateway;
    if (gatewayChild) {
      state.gateway = {
        status: 'running',
        owned: true,
        pid: state.gateway.pid,
        pids: state.gateway.pids ?? [],
        warning: null,
        error: null,
      };
      return state.gateway;
    }
    const probed = await probeGateway();
    if (probed.status === 'running') {
      log('网关已在运行（非本面板启动），沿用现有进程。');
      return probed;
    }
    // Start through `scripts/start-gateways.py` instead of `hermes gateway run`:
    //   * `hermes.exe` is a console shim, so spawning it flashes a black window;
    //   * a bare `gateway run` follows <home>/active_profile (companion on this
    //     machine), so the default profile's api_server could never come up;
    //   * the script gives every profile its own HERMES_HOME and launches each
    //     gateway detached with pythonw, so it also survives this DSH process.
    const python = hermesPython();
    const starter = runtime.home === null ? null : join(runtime.home, 'scripts', 'start-gateways.py');
    if (python === undefined || starter === null || !existsSync(starter)) {
      state.gateway = {
        ...state.gateway,
        status: 'error',
        error: `找不到 ${starter ?? 'start-gateways.py'} 或可用的 python，无法启动网关。`,
      };
      return state.gateway;
    }
    const pythonwPath = join(dirname(python), process.platform === 'win32' ? 'pythonw.exe' : 'pythonw');
    const launcher = existsSync(pythonwPath) ? pythonwPath : python;
    log(`正在启动 Hermes 网关（${basename(launcher)} start-gateways.py）…`);
    // Fire and forget: the launcher brings up every missing gateway and exits;
    // the gateways themselves are detached, so this panel owns none of them and
    // the stop button goes through the state file below.
    starterChild = ctx.subprocess.spawn({
      argv: [launcher, starter],
      cwd: runtime.home,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 65536 },
        stderr: { maxBytes: 65536 },
      },
      graceMs: 5000,
      env: hermesEnv({ HERMES_EXE: runtime.exe }),
    });
    starterChild.done.then(
      () => {
        starterChild = null;
      },
      (error) => {
        starterChild = null;
        log(`启动器退出异常：${error?.message ?? error}`);
      },
    );
    // The gateways need a moment to claim their locks and write a heartbeat.
    await new Promise((resolve) => setTimeout(resolve, 8000));
    await probeGateway();
    if (state.gateway.status !== 'running') {
      state.gateway = { ...state.gateway, status: 'starting' };
    }
    return state.gateway;
  }

  /** Render a gateway sub-status' PIDs for a log line. */
  function pidList(gateway) {
    return Array.isArray(gateway?.pids) && gateway.pids.length > 0 ? gateway.pids.join('、') : '?';
  }

  /** Stop the gateway: our own child, or a foreign one by PID. */
  async function stopGateway() {
    if (!conf.manageGateway) return state.gateway;
    if (!runtime.found) return state.gateway;
    if (gatewayChild) {
      log('正在停止本面板启动的网关…');
      const handle = gatewayChild;
      gatewayChild = null;
      try {
        handle.terminate();
      } catch {
        /* already gone */
      }
      try {
        await handle.waitForExit();
      } catch {
        /* provider lost sight of the range */
      }
      state.gateway = { status: 'stopped', owned: false, pid: null, pids: [], warning: null, error: null };
      return state.gateway;
    }
    const probed = await probeGateway();
    if (probed.status !== 'running') {
      state.gateway = { status: 'stopped', owned: false, pid: null, pids: [], warning: null, error: null };
      return state.gateway;
    }
    // A foreign gateway: let the CLI do the work. On Windows `gateway stop`
    // first writes the planned-stop marker so the gateway drains in-flight
    // agents and persists resume_pending, and only then escalates to a bounded
    // force-terminate of every PID it can see. A bare process.kill() skips the
    // drain entirely — and it is fragile here for the same reason the dashboard
    // was: `hermes` is a launcher that re-execs python, so the first reported
    // PID is not necessarily the process actually running the gateway.
    log(`正在停止默认 profile 的外部网关（PID ${pidList(probed)}）…`);
    try {
      // `-p default` is load-bearing: a bare `gateway stop` makes Hermes pick the
      // profile from <home>/active_profile (companion on this machine) and can
      // take the QQ gateway down with it. The stop button owns the default
      // profile only; companion(QQ) and librarian stay untouched.
      const { text } = await runHermes(['-p', 'default', 'gateway', 'stop'], 60000);
      if (text.trim()) log(text);
    } catch (error) {
      log(`hermes gateway stop 失败：${error?.message ?? error}`);
    }
    let after = await probeGateway();
    if (after.status === 'running') {
      // These PIDs come from probeGateway(), which reads the DEFAULT profile's
      // gateway_state.json only — companion's QQ gateway can never be in here.
      const targets = after.pids.length > 0 ? after.pids : [after.pid].filter((pid) => Number.isInteger(pid));
      if (targets.length > 0) {
        log(`网关仍在运行，按 PID 结束（${targets.join('、')}）…`);
        for (const pid of targets) await killTree(pid);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        after = await probeGateway();
      } else if (after.detail === 'external-provider') {
        // An external cron provider keeps no in-process gateway and reports no
        // PID, so there is nothing here to end — saying so beats "failed".
        state.gateway = { ...after, error: '这个部署用的是外部 cron provider：没有本进程网关可停，`gateway stop` 也已经跑过。' };
        return state.gateway;
      }
    }
    if (after.status === 'running') {
      state.gateway = { ...after, error: `无法结束外部网关（PID ${pidList(after)}）` };
      return state.gateway;
    }
    state.gateway = { status: 'stopped', owned: false, pid: null, pids: [], warning: null, error: null };
    return state.gateway;
  }

  /** Start the dashboard (or adopt one already listening). */
  async function startDashboard() {
    if (!runtime.found) {
      state.dashboard = {
        status: 'not-installed',
        owned: false,
        error: '没有找到可用的 Hermes 安装。',
      };
      return state.dashboard;
    }
    if (await probePort(conf.bindHost, runtime.port)) {
      log(`端口 ${runtime.port} 已在监听，沿用现有 dashboard。`);
      state.dashboard = { status: 'running', owned: false, error: null };
      return state.dashboard;
    }

    log(`正在启动 Hermes 原生 dashboard（端口 ${runtime.port}）…`);
    dashboardChild = ctx.subprocess.spawn({
      argv: [
        runtime.exe,
        'dashboard',
        '--tui',
        '--host',
        conf.bindHost,
        '--port',
        String(runtime.port),
        '--no-open',
        '--skip-build',
      ],
      cwd: runtime.home,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 131072 },
        stderr: { maxBytes: 131072 },
      },
      graceMs: 8000,
      env: hermesEnv({ HERMES_DASHBOARD_TUI: '1' }),
    });
    dashboardChild.done.then(
      (outcome) => {
        dashboardChild = null;
        if (state.dashboard.status === 'stopped') return;
        state.dashboard = {
          status: 'error',
          owned: false,
          error: `dashboard 意外退出（exitCode=${outcome.exitCode}）`,
        };
      },
      (error) => {
        dashboardChild = null;
        state.dashboard = {
          status: 'error',
          owned: false,
          error: error?.message ?? String(error),
        };
      },
    );

    const up = await waitForPort(conf.bindHost, runtime.port, conf.startTimeoutMs);
    if (!up) {
      state.dashboard = {
        status: 'error',
        owned: true,
        error: `dashboard 未在 ${conf.startTimeoutMs}ms 内监听 ${conf.bindHost}:${runtime.port}`,
      };
      log(state.dashboard.error);
      return state.dashboard;
    }
    state.dashboard = { status: 'running', owned: true, error: null };
    log('Hermes dashboard 已就绪。');
    return state.dashboard;
  }

  /** Stop the dashboard and make sure the port really closes. */
  async function stopDashboard() {
    // Without a resolved installation there is nothing this panel can own, and
    // the port would be the blind default: killing whatever happens to listen
    // there would be a way to shoot an unrelated service. Refuse instead.
    if (!runtime.found) {
      state.dashboard = { status: 'not-installed', owned: false, error: '没有找到可用的 Hermes 安装。' };
      return state.dashboard;
    }
    state.dashboard = { status: 'stopped', owned: false, error: null };

    const handle = dashboardChild;
    dashboardChild = null;
    if (handle) {
      log('正在停止本面板启动的 dashboard…');
      try {
        handle.terminate();
      } catch {
        /* already gone */
      }
      try {
        await handle.waitForExit();
      } catch {
        /* provider lost sight of the range */
      }
    } else if (process.platform === 'win32') {
      // No handle: this dashboard was started outside the panel (the user's
      // 启动.bat / start.ps1, or a previous DSH process), so there is nothing
      // to terminate. Find whatever owns the port and end its tree.
      //
      // `hermes dashboard --stop` is deliberately NOT the first thing tried
      // here. Its Windows discovery shells out to `wmic`, which Windows 11 no
      // longer ships, so it finds nothing, prints "No hermes dashboard
      // processes running." and exits 0 while the server keeps serving —
      // verified 2026-10-07 with two dashboards live. Even where wmic exists,
      // its pattern list ("hermes dashboard") would not match the quoted
      // `"...\Scripts\hermes.exe" dashboard` command line this deployment
      // launches. Port ownership is the fact we can actually rely on.
      let owners = [];
      try {
        owners = await listeningPids(runtime.port);
      } catch (error) {
        log(`按端口查找 dashboard 进程失败：${error?.message ?? error}`);
      }
      if (owners.length > 0) {
        log(`端口 ${runtime.port} 被外部 dashboard 占用（PID ${owners.join('、')}），正在结束…`);
        for (const pid of owners) {
          if (await killTree(pid)) log(`已结束 PID ${pid}`);
        }
      }
    }

    // The wrapper is meant to take its child down with it; verify, and fall
    // back to the CLI's own teardown when it did not.
    for (let i = 0; i < 12; i += 1) {
      if (!(await probePort(conf.bindHost, runtime.port))) return state.dashboard;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    log('端口仍被占用，调用 `hermes dashboard --stop` 兜底…');
    try {
      await runHermes(['dashboard', '--stop'], 30000);
    } catch (error) {
      log(`兜底停止失败：${error?.message ?? error}`);
    }
    for (let i = 0; i < 10; i += 1) {
      if (!(await probePort(conf.bindHost, runtime.port))) return state.dashboard;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    state.dashboard = {
      status: 'error',
      owned: false,
      error: `端口 ${runtime.port} 仍未释放，可能有残留进程`,
    };
    log(state.dashboard.error);
    return state.dashboard;
  }

  /** Full start: gateway then dashboard. */
  async function start() {
    if (!runtime.found) rediscover();
    if (!runtime.found) {
      state.dashboard = { status: 'not-installed', owned: false, error: '没有找到可用的 Hermes 安装。' };
      return snapshot();
    }
    if (runtime.exe === null || runtime.exe === undefined) {
      state.dashboard = { status: 'error', owned: false, error: CLI_MISSING };
      return snapshot();
    }
    if (state.dashboard.status === 'running') {
      await startGateway();
      return snapshot();
    }
    state.dashboard = { status: 'starting', owned: false, error: null };
    await startGateway();
    await startDashboard();
    return snapshot();
  }

  /** Full stop: dashboard then gateway. */
  async function stop() {
    await stopDashboard();
    await stopGateway();
    return snapshot();
  }

  /** Stop then start. */
  async function restart() {
    await stop();
    return start();
  }

  /**
   * Run a lifecycle command, coalescing concurrent callers onto one run.
   *
   * The client disables its buttons while a command is in flight, but that is
   * a convenience, not a lock: two simultaneous `POST /hermes/api/start` would
   * otherwise spawn two dashboards and two gateways. Overlapping callers
   * receive the in-flight result instead of starting a second run.
   * @param run - the lifecycle command.
   * @returns that command's snapshot.
   */
  function serialize(run) {
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      try {
        return await run();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  // Drain child output into the diagnostic ring. Offsets are tracked PER
  // handle: a single shared pair made the second child resume reading at the
  // first child's offset, silently truncating its output.
  ctx.effect(() => {
    const offsets = new WeakMap();
    const pump = (handle, sink) => {
      if (!handle) return;
      let offset = offsets.get(handle);
      if (offset === undefined) {
        offset = { out: 0, err: 0 };
        offsets.set(handle, offset);
      }
      const out = handle.collected.stdout?.readFrom(offset.out);
      if (out?.text) sink(out.text);
      if (out) offset.out = out.nextOffset;
      const err = handle.collected.stderr?.readFrom(offset.err);
      if (err?.text) sink(err.text);
      if (err) offset.err = err.nextOffset;
    };
    // The upgrade gets its own sink as well as the ring: its output is the
    // rollback instructions, so the panel shows it in place rather than asking
    // the user to dig it out of 200 lines of dashboard chatter.
    const updateSink = (text) => {
      for (const line of String(text).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        state.update.output.push(trimmed);
      }
      if (state.update.output.length > UPDATE_OUTPUT_LIMIT) {
        state.update.output.splice(0, state.update.output.length - UPDATE_OUTPUT_LIMIT);
      }
    };
    const timer = setInterval(() => {
      pump(dashboardChild, log);
      pump(gatewayChild, log);
      if (updateChild !== null) {
        pump(updateChild, (text) => {
          log(text);
          updateSink(text);
        });
      }
    }, 500);
    return () => clearInterval(timer);
  }, 'hermes-panel: child output pump');

  // Tear everything down when the plugin is disposed.
  ctx.effect(() => () => {
    for (const handle of [dashboardChild, gatewayChild, updateChild]) {
      try {
        handle?.terminate();
      } catch {
        /* ignore */
      }
    }
    dashboardChild = null;
    gatewayChild = null;
    updateChild = null;
    if (updateTimer !== null) clearTimeout(updateTimer);
    updateTimer = null;
  }, 'hermes-panel: lifecycle');

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/status',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
          // Cheap by design: a port probe only. The gateway CLI is never spawned
          // here, because this route is polled every few seconds.
          const listening = await probePort(conf.bindHost, runtime.port);
          if (listening && state.dashboard.status !== 'running') {
            state.dashboard = { status: 'running', owned: state.dashboard.owned, error: null };
          } else if (!listening && state.dashboard.status === 'running') {
            state.dashboard = { status: 'stopped', owned: false, error: null };
          }
          if (gatewayChild === null && state.gateway.owned) {
            state.gateway = { ...state.gateway, owned: false };
          }
          json(res, 200, snapshot());
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/start',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
          json(res, 200, await serialize(start));
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/stop',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
          json(res, 200, await serialize(stop));
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/restart',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
          json(res, 200, await serialize(restart));
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/refresh',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
          // The one route allowed to spawn the gateway CLI for a live check.
          // It also re-runs discovery, so installing Hermes while the panel is
          // open is picked up without restarting DSH.
          rediscover();
          if (runtime.found) await probeGateway();
          json(res, 200, snapshot());
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/health',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
          // Deliberately NOT part of the status poll: this one runs PowerShell
          // and, inside doctor.ps1, the Hermes CLI. The panel asks for it on a
          // button, never on a timer.
          if (!runtime.found) {
            return json(res, 200, {
              available: false,
              reason: '没有找到可用的 Hermes 安装，无法体检。',
              attempts: runtime.attempts,
            });
          }
          if (runtime.maintenance?.doctor !== true) {
            return json(res, 200, {
              available: false,
              reason: '这个 Hermes 安装里没有 official-web/doctor.ps1，没法体检——体检脚本是随 official-web 发行版一起装的。',
              attempts: runtime.attempts,
            });
          }
          try {
            const { outcome, text, host } = await runMaintenanceScript('doctor.ps1', ['-Json'], 120000);
            const checks = parseJsonArray(text);
            const code = outcome?.exitCode;
            const payload = {
              available: true,
              host,
              exitCode: code,
              ranAt: new Date().toISOString(),
              checks: checks ?? null,
              summary: checks === undefined ? null : summarizeChecks(checks),
            };
            if (checks === undefined) {
              // doctor.ps1 -Json printed something this plugin could not read.
              // Hand the tail back rather than inventing a verdict, and keep the
              // last few lines in the log ring for a bug report.
              payload.error = `doctor.ps1 的输出不是可解析的 JSON（exitCode=${code}）`;
              payload.raw = text.trim().slice(-4000);
              log(`体检输出无法解析（exitCode=${code}）：${text.trim().slice(-300)}`);
            } else if (code !== 0) {
              payload.error = `doctor.ps1 退出码 ${code}`;
              log(`体检退出码 ${code}`);
            } else {
              log(`体检完成：OK ${payload.summary.ok} / WARN ${payload.summary.warn} / FAIL ${payload.summary.fail}`);
            }
            json(res, 200, payload);
          } catch (error) {
            const message = error?.message ?? String(error);
            log(`体检失败：${message}`);
            json(res, 200, { available: true, error: message, host: null, checks: null, summary: null });
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/update/check',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
          if (!runtime.found) {
            return json(res, 200, { available: false, reason: '没有找到可用的 Hermes 安装。' });
          }
          if (runtime.maintenance?.checkUpdate !== true) {
            return json(res, 200, {
              available: false,
              reason: '这个 Hermes 安装里没有 official-web/check-update.ps1，无法检查版本。',
            });
          }
          try {
            const { outcome, text, host } = await runMaintenanceScript('check-update.ps1', [], 120000);
            state.updateReport = text.trim() || null;
            log(`版本检查完成（${host}，exitCode=${outcome?.exitCode}）`);
            json(res, 200, {
              available: true,
              host,
              exitCode: outcome?.exitCode,
              checkedAt: new Date().toISOString(),
              text: state.updateReport,
            });
          } catch (error) {
            const message = error?.message ?? String(error);
            log(`版本检查失败：${message}`);
            json(res, 200, { available: true, error: message, host: null, text: null });
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/update/apply',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
          // Starting is idempotent: a second press while the job runs returns
          // the job already in flight rather than launching a second pip.
          if (updateChild !== null) {
            return json(res, 200, { available: runtime.found, update: state.update });
          }
          if (!runtime.found) {
            return json(res, 200, { available: false, reason: '没有找到可用的 Hermes 安装。', update: state.update });
          }
          if (runtime.maintenance?.update !== true) {
            return json(res, 200, {
              available: false,
              reason: '这个 Hermes 安装里没有 official-web/update.ps1，无法升级（升级脚本随 official-web 发行版一起装）。',
              update: state.update,
            });
          }
          try {
            const update = await startUpdateApply();
            json(res, 200, { available: true, update });
          } catch (error) {
            const message = error?.message ?? String(error);
            state.update = { ...state.update, phase: 'error', error: message, finishedAt: Date.now() };
            log(`升级无法开始：${message}`);
            json(res, 200, { available: true, update: state.update });
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/update',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
          json(res, 200, {
            available: runtime.found,
            canUpgrade: runtime.found === true && runtime.maintenance?.update === true,
            report: state.updateReport,
            update: state.update,
          });
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/bridge',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
          json(res, 200, bridgeStatus());
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/bridge/apply',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
          try {
            const result = await applyBridge();
            json(res, 200, { applied: true, ...result, status: bridgeStatus() });
          } catch (error) {
            const message = error?.message ?? String(error);
            log(`注册 DSH 桥失败：${message}`);
            json(res, 200, { applied: false, error: message, status: bridgeStatus() });
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/workspace',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
          json(res, 200, workspaceStatus());
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/workspace/apply',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
          try {
            const result = await applyWorkspace();
            json(res, 200, { applied: true, ...result, status: workspaceStatus() });
          } catch (error) {
            const message = error?.message ?? String(error);
            log(`配置共享工作区失败：${message}`);
            json(res, 200, { applied: false, error: message, status: workspaceStatus() });
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/pick-directory',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
          try {
            json(res, 200, { picked: true, ...(await pickDirectory('选择共享工作区（Hermes 与 DSH 都在这干活）')) });
          } catch (error) {
            const message = error?.message ?? String(error);
            log(`目录选择器失败：${message}`);
            json(res, 200, { picked: false, error: message });
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/workspace/register',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
          // Idempotent, so the panel may call this on every status refresh while
          // the directory is merely unregistered; the registry reuses the record
          // already owning the canonical path.
          const result = await registerSharedWorkspace();
          if (result.registered) log(`共享工作区已加入侧边栏：${conf.sharedWorkspace}`);
          json(res, 200, { applied: result.registered, ...result, status: workspaceStatus() });
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/workspace/sessions',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const asked = Number.parseInt(String(url.searchParams.get('limit') ?? ''), 10);
          const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 200) : 50;
          json(res, 200, await readWorkspaceSessions(limit, url.searchParams.get('path')));
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/hermes/api/workspace/session',
        handler: async (req, res) => {
          if (!allowed(req, res)) return;
          if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const sessionId = String(url.searchParams.get('id') ?? '').trim();
          if (sessionId === '') return json(res, 400, { error: '需要 id 参数（会话 id）。' });
          const asked = Number.parseInt(String(url.searchParams.get('maxChars') ?? ''), 10);
          const maxChars = Number.isFinite(asked) ? Math.min(Math.max(asked, 200), 200000) : 20000;
          json(res, 200, await readWorkspaceSession(sessionId, maxChars));
        },
      }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'hermes-panel: routes');

  if (conf.autostart) {
    serialize(start).catch((error) => {
      state.dashboard = { status: 'error', owned: false, error: error?.message ?? String(error) };
    });
  }
}
