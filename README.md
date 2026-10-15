# dsh-hermes-panel

[中文文档](README.zh.md) | English

> **`1.1.0-rc.1` — a pre-release, published on purpose before it is finished.** It is on npm and in the
> market so that it can be installed, used and broken by someone other than its author, which is the only
> test that was ever going to catch the interesting bugs. Install it the same way as anything else; the
> version number is the honest part.

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sidebar panel for the
**native [Hermes](https://github.com/NousResearch/hermes-agent) agent**: it finds your Hermes
installation, starts and stops its messaging gateway and web dashboard, and embeds the native
dashboard in a panel.

There is **no Hermes panel in the left sidebar**. The plugin registers nothing there.
It ships **one seat**: a `Hermes` tab in the right column, opened from the ⊕ list's
**Open Hermes** row, with three faces switched by a row of icons in its strip (the
active one is marked, each has a tooltip):

| | |
|---|---|
| 🌐 | **Dashboard** — an iframe of the native Hermes dashboard, beside the conversation rather than in place of it: DSH on the left, Hermes on the right, one window |
| 💬 | **Record** — the Hermes ↔ DSH exchange, read from DSH's own session logs; every row says which directory it ran in |
| ⚙ | **Setup** — the health report and upgrade, the DSH bridge, and the shared workspace |

The same strip carries **start / stop**, **restart**, and **↗ open in a new tab**.

The tab belongs to no session, so it rides the conversation view: switching sessions
keeps it, and switching faces never reloads the page — the iframe never leaves the
document, it is only hidden.
| Health † | runs Hermes' own `official-web/doctor.ps1 -Json` and renders its nine-point report |
| Upgrade † | runs `check-update.ps1` to report, then `update.ps1 -Apply` to upgrade — stopping Hermes first, and **not** starting it again |
| Directories | the two settings the whole plugin reads — the runtime (Hermes' `VENV`) and the data directory (`HERMES_HOME`) — each with a folder picker and the evidence that the folder is the right one |
| DSH bridge | both halves of the DSH ↔ Hermes channel: writes `mcp_servers.dsh` into Hermes' `config.yaml`, diagnoses the MCP client version each profile resolves, and hands Hermes a **session id** so it can review a result and send a follow-up into the same session |
| Shared workspace | one directory both agents work in; the `AGENTS.md` inside it is read by both, so shared context needs no conversion |
| Configuration | two directories — a runtime and a volume. Nothing is guessed: an empty setting means a default under the DSH home, and the panel prints what it found there |
| Languages | Chinese and English, chosen at runtime |
| Platform | Windows (process control uses `netstat` / `taskkill`; see [Platform](#platform)) |

† **These two are the `official-web` distribution's own maintenance scripts.** An upstream
Hermes — `pip install hermes-agent`, data in a home directory with `config.yaml` — has none of
them, and there is no `hermes-agent` equivalent to call instead, so the panel **disables both
and says why** rather than offering a button that fails. Everything else (start/stop, the
dashboard, the record, the bridge, the shared workspace) works on any installation, and
`GET /hermes/api/status` reports the set as `capabilities`.

> **Not to be confused with `hermes-web-ui`.** That npm package brands itself *Ekko Studio* and
> used to be named *Hermes Studio*. This plugin targets the **native** Hermes Python agent
> (`hermes_agent`, `HERMES_HOME`), not that one.

## Install

```sh
dsh plugin --profile web add @guanyang14700/dsh-hermes-panel
```

Restart `dsh` afterwards — the **host** half is a Node module and browser refreshes do not reload it.
The panel then appears in the sidebar as **Hermes**.

### What it needs

| | |
|---|---|
| DSH | `>= 0.2.0-rc.2 < 1.0.0` (a peer dependency, checked by the panel and reported per profile) |
| Hermes | any installation the plugin can recognise — upstream (`pip`/`pipx`/`uv`, home with `config.yaml`), or the `official-web` distribution (home with `official-web/.env`). **Hermes is not bundled and not installed by this plugin**; the panel is told where it is |
| Optional | `official-web/` inside that home — its four PowerShell scripts are what 体检 / 查更新 / 升级 / 安装 wrap. Without it those three controls are disabled |
| For the DSH bridge | a `python` (the one carrying `hermes-agent`), a `node`, and `DEEPSEEK_API_KEY` in `~/.dsh/.env` |
| OS | Windows. Process control shells out to `netstat` / `taskkill`, and the maintenance scripts are PowerShell — see [Platform](#platform) |

> Development checkouts use `@guanyang14700/dsh-hermes-panel` through a `link:` dependency. See
> [PUBLISHING.md](PUBLISHING.md) for the rename procedure and what has to follow it — the profile
> needs the package linked under its new name before DSH can resolve the bundle.

## Runtime and volume

Nothing about *this machine* is hard-coded, and nothing is guessed. Two directories are named:

- **Runtime** — the Python environment Hermes runs in (its `VENV`). Empty means
  `<DSH home>/hermes-panel/runtime`.
- **Data directory** — `HERMES_HOME`: profiles, sessions, state, `config.yaml`, `official-web/`.
  Empty means `<DSH home>/hermes-panel/home`.

They are independent, on purpose: point the data directory at an existing Hermes to keep using its
sessions and keys, and point the runtime at whatever Python should run it. A machine with neither
gets both under the DSH home.

The only directory guessed at all is `HERMES_HOME` from the environment, and that is Hermes' own
variable, honoured after the settings.

**Earlier versions walked the filesystem looking for a sibling `Hermes` — a chain of ancestors,
the user profile, a few dotted spellings — and that walk was the bug.** An installed plugin lives
several levels down inside a profile's `node_modules`, so the walk was always one directory short:
it reported no installation beside a Hermes that was running, and the panel lost its start button.
Two named directories replaced it, and every failure now names the directory it looked at.

The CLI is resolved in this order: the runtime directory, `HERMES_EXE` from `official-web/.env`,
then **`hermes` on PATH**. A home with no runnable CLI is still reported as found — the panel shows
its status, its settings and the bridge, and says which setting to fill before it can start
anything.

If nothing is found, the panel says so and lists every path it tried. **Re-detect** re-runs the
search, so installing Hermes while the panel is open is picked up without restarting DSH.

### Settings

Because empty values mean *detect this*, override only what you need.

**Where to change them:** open the **Plugins** panel in the sidebar (the entry that installs and
manages plugins) and, under the **Official** group, click the **Hermes Panel settings** card. That
card exists because this plugin registers its own settings page into the panel's `plugins.item`
slot — see [why that is necessary](#why-the-settings-page-registers-itself).

> The panel lists this plugin **twice**, and both entries are real. Under **Installed** is the
> bundle card with the enable/disable switch; under **Official** is the settings page. They are
> named differently on purpose: two identically titled cards, only one of which carries the form,
> is how you end up opening the wrong one.

The same values live in the profile's own patch layer, which is what a settings save writes:

| Field | Default | Meaning |
|---|---|---|
| `runtimeDir` | `''` | Python environment (Hermes' `VENV`); empty = `<DSH home>/hermes-panel/runtime` |
| `dataDir` | `''` | `HERMES_HOME`; empty = `<DSH home>/hermes-panel/home` |
| `dashboardPort` | `0` | `0` = `DASHBOARD_PORT` from `.env`, else 9150 |
| `sharedWorkspace` | `''` | a directory both agents work in; empty = no sharing |
| `manageGateway` | `true` | start/stop the messaging gateway along with the dashboard |
| `autostart` | `false` | bring Hermes up when the plugin activates |

Two notes on the form, both consequences of how DSH composes settings:

- A field is only rendered when its schema node is reachable under a `.volatile()` marker. A
  `Config` without one is collected by the Host and then silently dropped, which is why every
  field here is marked.
- The boolean and list fields are staged as text (`true` / `false`; one path per line), because the
  shared field controls are text inputs. A draft the field does not accept blocks the save instead
  of being coerced, and an empty draft clears the override.

### Why the settings are read at runtime

Every field is `.volatile()`, which changes what that config object means. DSH serves volatile values
from the row's settings namespace and expects them to be read while it runs — so **the object handed
to `apply` is only the state at activation**, and a settings save persists to the profile patch
without re-activating the plugin.

An earlier revision normalized that object into a plain one inside `apply`, which pinned every field
to its boot value: the save landed, the settings page showed the new value, and the plugin kept
answering from the config it was born with. A workspace the user had just picked still read back as
unset.

The live values now come from `ctx.get('settings')`, whose `describe({ redactSecrets: true })`
returns one descriptor per namespace carrying the current `value`. It is a **soft** lookup, like the
client half's `configForms`: a deployment that mounts no settings service keeps working from the
applied config rather than failing to load. The read is memoized briefly, because `describe()`
projects every namespace and one status snapshot reads a dozen fields.

### Why the settings page registers itself

DSH does **not** render a form for a plugin's `Config` schema. Exporting a schema with volatile
fields makes the Host *serve* a settings namespace — `settings.describe()` returns a form for it,
writes are validated, and the profile patch can set it — but no UI is generated from it. Every
settings page in DSH is contributed by the owning plugin's own client half: the official terminal
page, for instance, ships as a separate companion package.

So this plugin registers **into all three slots the Plugins page declares**, while the Host serves
the namespace (`configForms.whileServed`):

| Slot | Where it lands | Key |
|---|---|---|
| `plugins.item` | a card beside the official bundles, in the **Official** group | the profile entry id, `hermes-panel` |
| `plugins.bundle.config` | the form on **this bundle's own detail page** | the bundle package name |
| `plugins.row.config` | the form on the bundle's row page | `bundle#rowId` |

Filling only the first one is the mistake this plugin made: the Plugins page renders the bundle's
config section under `data-plugin-config` **only when something registered under `plugins.bundle.config`
with that bundle's package name** — `configured: ledger.bundles.has(openPkg.name)` — so a plugin that
registers only `plugins.item` puts a card in the Official group while the page a user actually lands
on, the one they open by clicking the installed bundle, stays empty. Both surfaces now render the
same component: the panel opens it with `{ view: 'page' }` for the detail body and
`{ view: 'summary' }` for the card's one-liner.

`verify/client.mjs` fires each slot's injection the way its owner would, then checks the registration,
its key, and that all three faces render the form — a registration the test never fires would never
land, which is how the gap went unnoticed. It also cross-checks that the controls cover exactly the
fields the Host schema declares.

The page is a **soft** dependency: `configForms`, `locale` and the form primitives are looked up at
apply time, and a deployment without them gets the Hermes panel with no settings page rather than
no plugin at all.

## HTTP interface

Every route requires a **loopback peer**, a **same-origin `Origin`** (when present it must match
`Host`) and a `Sec-Fetch-Site` that is not cross-site. See [Security](#security).

| Route | Method | Notes |
|---|---|---|
| `/hermes/api/status` | GET | cheap poll: port probe plus cached state, **spawns nothing** |
| `/hermes/api/start` | POST | gateway (if down) → dashboard → wait for the port |
| `/hermes/api/stop` | POST | dashboard (with port fallback) → gateway |
| `/hermes/api/restart` | POST | stop → start |
| `/hermes/api/refresh` | POST | the only route that spawns `hermes cron status`; also re-runs discovery |
| `/hermes/api/health` | GET | runs Hermes' own `official-web/doctor.ps1 -Json` and returns its report verbatim. Without that script: `available: false` and a reason |
| `/hermes/api/update/check` | POST | runs `check-update.ps1`: installed vs PyPI latest, and whether the new version fits this Python. Changes nothing. Without it: `available: false` and a reason |
| `/hermes/api/update/apply` | POST | stops Hermes, then starts `update.ps1 -Apply` **in the background**. Idempotent while a job runs. Without it: refused, and nothing is spawned |
| `/hermes/api/update` | GET | the upgrade job: phase, exit code, and its captured output |
| `/hermes/api/bridge` | GET | both halves of the DSH ↔ Hermes bridge |
| `/hermes/api/bridge/apply` | POST | write or refresh `mcp_servers.dsh` in Hermes' `config.yaml`, after a backup |
| `/hermes/api/workspace` | GET | the shared workspace: the directory, its `AGENTS.md`, whether Hermes points there, and whether the sidebar lists it |
| `/hermes/api/workspace/apply` | POST | create the directory and its `AGENTS.md`, point Hermes' `terminal.cwd` at it, and **register it as a sidebar Workspace** |
| `/hermes/api/workspace/register` | POST | the registration step alone (idempotent); the panel calls it automatically while the directory exists but is not listed |
| `/hermes/api/workspace/sessions` | GET | the sessions recorded in the shared workspace (the `sessionQuery` corpus filtered by cwd) |
| `/hermes/api/workspace/session?id=` | GET | one of them, expanded: the task, DSH's answer, and the tool calls, in log order |
| `/hermes/api/pick-directory` | POST | open the Host's own folder dialog and return the chosen path |

### Shared workspace and shared context

The **DSH 桥** panel also carries the shared workspace. Setting `sharedWorkspace` and pressing
**创建并指向** does three things, each reported separately:

1. ensures the directory exists;
2. writes `AGENTS.md` there **only when it is absent** — an existing one is the operator's file and
   is never overwritten;
3. points Hermes' own `terminal.cwd` at the directory, through the same backup-and-`config check`
   path as the bridge entry.

**No format conversion is involved, and that is the whole reason this works.** Both sides already
agree on one file:

| Side | Where it looks |
|---|---|
| DSH | `@deepseek-ai/dsh-agent-instructions` reads `AGENTS.md` (and `CLAUDE.md`) |
| Hermes | `agent_init` / `prompt_builder` / `runtime_cwd` read `AGENTS.md` |

So "shared context" is not a sync problem — it is a *directory* problem. Put `AGENTS.md` where both
agents open, and both read it. The Hermes half of that is `terminal.cwd`: `runtime_cwd.py` documents
`TERMINAL_CWD` as the runtime carrier of the configured `terminal.cwd`, and the plugin creates that
key when it is absent and replaces it when it is not — leaving the rest of the `terminal:` block
alone.

The two halves are reported independently because they fail independently: the directory and its
file are one thing, and whether Hermes actually points there is another.

**选择目录… picks the directory through the Host's own folder dialog** rather than asking for a
typed path. It has to be the Host's dialog: browsers hide absolute paths from
`<input type="file" webkitdirectory>`, so no browser-side picker could return one. The Host runs it
through `powershell -STA` — the common dialogs need a single-threaded apartment — and the chosen
path is written back through the settings form's own `edit`/`save` actions, so it is validated like
a typed value and shows up in the settings page. A cancelled dialog is not an error; a machine with
no usable desktop session gets a message pointing at the typed field instead.

**The shared workspace IS the bridge's workspace** — one directory, not two. `bridgeWorkspace`
used to override it, which meant the panel said "shared" about somewhere the bridge was not told
to use, and files landed in the other place. That knob is gone.

### Why picking the shared workspace showed nothing, and what it shows now

The directory itself holds **only `AGENTS.md`**: it carries the shared *context*, while the trace of
an exchange is not in a file at all — it is in DSH's own session log. Every time Hermes drives DSH
through `dsh_run` it is a real `dsh --json` run whose `cwd` is this shared workspace, so that
exchange is already a complete session on disk. It simply had no owner: DSH's sidebar groups
sessions by canonical cwd, and this directory had never been registered as a Workspace, so the
session showed up nowhere.

Two things therefore happen now:

1. **The directory is registered as a Workspace.** "Create and point here" also calls
   `ctx.workspaceRegistry.create(path, '共享工作区（Hermes ↔ DSH）')`, which is idempotent — the
   registry reuses the record already owning that canonical path. Once registered, **every session
   under that cwd appears beneath that node in the sidebar.** While `sharedWorkspace` is set and its
   directory exists, the panel also registers it automatically, so no second press is needed.
2. **The records live in the same `Hermes` tab, under 「💬」.** Reach it: the right column's ⊕ →
   **Open Hermes** → press 💬. It lists the sessions DSH ran (time, title, live/finished, **and the
   directory it ran in**), and opening one renders that exchange — the task Hermes sent, what DSH
   answered, and the tool calls in between, in log order. Switching to it opens the newest exchange
   for you, because the list answers "how many" and the reader came for "what did they say".

   **The record is not filtered by directory any more.** It used to keep only sessions whose cwd was
   the shared workspace, and Hermes drives DSH from **its own** workspace — so the exchange you had
   just watched happen was hidden one directory over and the list came back empty. Everything DSH ran
   is listed now, and a row outside the shared directory tints its `cwd` so the split is visible.

For completeness, **why this cannot be a row in the "Add workspace…" menu**: that entry's slot,
`sidebar.workspaces.directoryFlow`, is `kind: 'single'` and is already held by DSH's own directory
picker, so a plugin cannot add a second menu item. It does not need to — owning the canonical
directory is the whole switch.

The record list reads `ctx.sessionQuery` (the `session-query-sqlite` row `dsh-base` mounts with
`openAt: never`: exact reads and the corpus listing work, content search does not, and this needs
only the former). That is also **why it is not part of the status poll** — listing the corpus is
storage work, not a 3-second liveness probe.

### DSH ↔ Hermes bridge

Both directions of this channel are MCP, and they are built from opposite ends:

| Direction | Mechanism |
|---|---|
| DSH → Hermes | DSH's `@deepseek-ai/dsh-mcp-client` mounts Hermes' own MCP servers |
| Hermes → DSH | this plugin ships `bridge/dsh_mcp_server.py`; Hermes lists it under `mcp_servers.dsh` |

The plugin owns the **Hermes half**: with **DSH 桥** open it reports the state and offers to write
the entry, pointing at the copy that ships in this package rather than at whatever path some other
checkout left behind. It refuses to ship a *default* source for it, for the same reason the guided
install has none — the entry names a Python interpreter, a workspace and a profile that belong to
the deployment, and the workspace/profile are settings.

Writing is deliberately cautious. `config.yaml` holds the runtime's **plaintext provider keys** and
a full set of explanatory comments, so it is edited **line by line** rather than parsed and
re-emitted — a YAML round trip would silently drop both. Before writing, a backup is taken; after
writing, `hermes config check` must accept the file or the backup is restored. `verify/bridge.mjs`
pins that down, including a byte-for-byte check that unrelated comments, secrets and neighbouring
servers survive.

**The DSH half is reported too, and it is the half that usually breaks.** DSH disables every MCP row
in a profile whose resolved `@deepseek-ai/dsh-mcp-client` does not match the running version — it
says so in the log and keeps going, so the tools simply are not there. The panel reads each
profile's resolved version and prints the exact command that fixes the one that is off:

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-mcp-client@<running version>
```

> It checks the **profile's** `node_modules`, not the copy bundled inside the `dsh` package. Those
> are different trees, and checking the bundled one reports a healthy version while the rows are
> disabled — which is the mistake an earlier revision of this check made.

### Driving DSH like a subagent

The bridge hands back a **session id**, and that is what turns a one-shot call into a loop:

```
dsh_run(task)                              → 会话 id: session-…  + the answer
   ↓ review it
dsh_resume(session_id, "第 2 点不对，改成 …")  → same session, history intact
   ↓ review again
…repeat
```

The id is only obtainable from the `--json` event stream — its first event is
`{"type":"session","sessionId":"session-…","cwd":"…"}`. The bridge therefore always runs with
`--json` and renders the stream itself:

| Event | Becomes |
|---|---|
| `session` | the `会话 id:` line — the handle for the next round |
| `text` | assistant text, and the fallback answer when there is no `final` |
| `tool_call` / `tool_result` | one trace line each, so the result can be reviewed |
| `thinking` | counted, not expanded |
| `final` | the answer |

Two facts are load-bearing:

- **`--session-id` can only resume, never create.** An id that does not exist fails with
  `session "…" does not exist` — measured — which is why the id has to be *discovered* rather than
  prescribed.
- **Plain-text stdout carries no id at all**, so a profile that ignores `--json` gets an honest
  `会话 id: （这次没拿到…）` instead of a handle that would fail on the next call.

The renderer lives in `bridge/dsh_events.py` with **no third-party imports**, so
| `verify\bridge-server.mjs` | the **server** half, which had no test of its own: that a task carrying quotes, backslashes, `%` and CJK reaches DSH as ONE argv element (no shell ever sees it again), that a resumed id is stripped and ordered, that truncation keeps head and tail, that the failure hints are still matched, and that the DSH version is read once and lands in the report header. It also imports the module with the `mcp` SDK blocked, so the tolerant import stays tolerant |
`verify/bridge-render.mjs` can run its selftest with any Python — no `mcp` package, no server.

### Installing Hermes

**This plugin does not install Hermes, and does not try to.** Hermes ships its own
installer inside a checkout, and a checkout is per-deployment: skills, memories and the
maintenance scripts all travel with it, so there is no repository this plugin could
point every user at.

Install Hermes the way its own documentation says, then tell the panel where it is:

| Setting | What to point it at |
|---|---|
| **Runtime** | the Python environment Hermes runs in — its `VENV` |
| **Data directory** | `HERMES_HOME` — profiles, sessions, `config.yaml`, `official-web/` |

Both are in the panel's 「设置」 view, with a folder picker, and both show what was found
there: the CLI for the runtime, the profile count and state size for the data directory.
A path that is right and a path that is wrong read identically in a text box, so the
evidence is printed next to it.

`start`, `stop` and `restart` share one **serialization lock**: concurrent callers receive the
in-flight result instead of spawning a second dashboard and gateway.

### Health check

**体检** runs `doctor.ps1 -Json` — Hermes' own nine-point check, not this plugin's opinion of it —
and renders the report under the control strip. It is deliberately **not** part of the status poll:
one run costs a PowerShell process and a Hermes CLI call (~4 s measured), so it happens on a button
press and the result is held until you dismiss it.

**This control only exists where `official-web/doctor.ps1` does.** On an upstream installation the
route answers `available: false` with the reason, so the report says so instead of failing silently.

The plugin owns no health, install or update logic of its own. `official-web/` already ships
`doctor.ps1`, `install.ps1` and `update.ps1` — the last with a pre-update snapshot, a post-update
SHA-256 comparison and a rollback command — and those travel with Hermes when it upgrades, so
wrapping them keeps this plugin from drifting out of step with a CLI that a hand-rolled
equivalent would. The script name is taken from a fixed allow-list, never from the request.

> The child's `[Console]::OutputEncoding` is pinned to UTF-8 before the script runs. Without it a
> Windows PowerShell host writes its stdout in the OEM code page, and a check's Chinese detail
> (the dashboard hint names a `.bat`) arrives as mojibake — measured, and covered by
> `verify/health-e2e.mjs`.

### Update

**检查更新** runs `check-update.ps1` — report only, it changes nothing — and shows what it said.
When a newer version exists the panel offers **升级到 X.Y.Z**, behind a second confirming press.

Applying is not a request, it is a **background job**, for three reasons:

- `pip install --upgrade hermes-agent` takes minutes; holding an HTTP request open for it would be
  a worse citizen than the poll it replaces;
- the panel needs the job's output live, because that output is where `update.ps1` prints its
  rollback command after a failure;
- the hard cap on the job is 30 minutes and is a last resort. Terminating pip mid-install is how a
  virtual environment gets broken, so the cap exists to stop a wedged child leaking, not as a
  normal path.

**Hermes is stopped first, and is not restarted afterwards.** `update.ps1` installs into the very
virtual environment the dashboard and gateway are executing from, and on Windows those files are
locked while they run — an upgrade attempted over a live installation fails at best. Whatever was
running is deliberately left stopped: bringing a freshly upgraded agent back up automatically is a
decision for the operator, not a side effect of pressing a button. The job records whether
anything was running so the panel can say so.

The version comparison in the panel parses `check-update.ps1`'s own output rather than asking PyPI
again — the script already handled the mirror, `requires_python`, and the "not installable on this
Python" case, and a second implementation would be a second thing to keep in step.

## Security

`webServer.register` routes are **not** behind DSH's index/`/api` auth guard, and the route
interface has no auth option of its own. A bare method check was therefore a cross-site request
forgery hole: any page the user visited could `POST http://127.0.0.1:3080/hermes/api/stop` — a
simple, preflight-free request — and kill their Hermes gateway. The plugin now enforces its own
three checks, and `verify/host-csrf.mjs` is the regression test for them.

**Credentials.** The plugin reads Hermes' `official-web/.env`, which also holds the runtime's API
key. Only `HERMES_HOME`, `VENV`, `HERMES_EXE` and `DASHBOARD_PORT` are retained; every other line
is discarded while parsing, so no secret reaches plugin state, the log ring, or any HTTP response.
`verify/config.mjs` asserts this.

Residual surface: a **local** process that can reach the loopback port can still read status and
start/stop Hermes. The dashboard itself binds `127.0.0.1` only and keeps its own session token.
**Do not bind DSH to `0.0.0.0` while this plugin is enabled.**

## Languages

DSH's own client packages ship Chinese and English and choose between them at runtime, so this
plugin does the same. Two namespaces carry the copy:

| Namespace | Surface |
|---|---|
| `hermes-panel.panel` | the sidebar panel — control strip, health report, update, install, bridge, workspace |
| `hermes-panel.settings` | the settings page's own form |

Both are registered with the locale service, and both fall back to Chinese when that service is not
mounted — the plugin keeps rendering on a deployment that composes no locale surface, which is the
same soft-dependency rule the rest of the client half follows.

`verify/client.mjs` enforces the properties that keep a translation honest:

- **no CJK outside a dictionary region**, so a new string cannot quietly stay untranslated;
- **the same keys in both languages**, because a key missing from one renders as the key itself;
- **no dictionary value calls `t`** — the pass that first moved the strings into the dictionary ran
  over the dictionary too and turned every value into a call to itself, which only fails at render
  time.

## Platform

**Windows is the supported platform, and all three reasons are load-bearing:**

- **Process control.** The plugin finds the process that owns the dashboard port with
  `netstat -ano` and ends its tree with `taskkill /T /F`. On other platforms a dashboard this panel
  did not start cannot be stopped (its own child is still terminated normally). A port would need
  `lsof`/`ss` and a POSIX tree kill.
- **The maintenance scripts** (`doctor.ps1` / `check-update.ps1` / `update.ps1` / `install.ps1`) are
  PowerShell, run through `pwsh` (falling back to `powershell.exe`). They exist only where the
  `official-web` distribution is; the three controls are disabled without them.
- **The folder picker** for the shared workspace opens a WinForms dialog through
  `powershell -STA`. Typing the path by hand is the fallback everywhere.

Nothing else is platform-bound: discovery, the dashboard iframe, the record, the bridge and the
configuration writer are plain Node and work wherever DSH does.

## Why there is no reverse proxy

The native dashboard is a plain uvicorn app that sets **no** `X-Frame-Options` and **no** CSP on
either its shell or its assets, so the DSH page frames `http://127.0.0.1:<port>/` directly.
`verify/host.mjs` asserts this. Skipping the bridge also avoids having to tunnel the dashboard's
own WebSocket traffic by hand.

## Process shapes worth knowing

**`hermes dashboard` is a wrapper, not a server.** It stays alive and spawns the real server
(`python.exe`, the process holding the port) as its child; that server spawns one TUI worker per
open chat session. So `stop` has two paths:

- **started by this panel** (we hold the handle): `terminate()` the range, then wait for the port;
- **started outside** (the user's own start script, or a previous DSH process): there is no
  handle, so the panel asks Windows which PID owns the port and ends that tree.

> Do not rely on `hermes dashboard --stop` as a fallback. Measured 2026-10-07 with two live
> dashboards: it printed `No hermes dashboard processes running.` and **exited 0**. Two
> independent reasons — its Windows discovery shells out to `wmic`, which Windows 11 no longer
> ships; and even where `wmic` exists, its pattern (`hermes dashboard`) does not match the quoted
> `"...\Scripts\hermes.exe" dashboard` command line. Port ownership is the fact that holds.

**Gateway detection is not part of the poll.** `hermes cron status` starts a Python process, far
too heavy for a 3-second poll, so the cheap status route only probes the port and the live check
happens on **Re-detect**.

**The gateway state file is not trustworthy.** `HERMES_HOME\gateway_state.json` goes stale —
observed on this machine: the file said PID 25512 and timestamped four days earlier, while the live
gateway was PID 14168. `hermes cron status` is the authority.

**The gateway report is read by its sentences, and an unrecognized one is `unknown`.** The command
prints one of a fixed set, and each means something different:

| Sentence | Meaning |
|---|---|
| `Gateway is running — cron jobs will fire automatically` | healthy |
| `... cron ticker looks STALLED — no heartbeat for Ns` | the process is up, the ticker thread is gone |
| `... no tick has succeeded in Ns` | both are up, every tick is failing |
| `Cron provider: X — ...` | an external provider; **no** in-process ticker and no `PID:` line |
| `Gateway is not running — cron jobs will NOT fire` | stopped |

Only that last sentence means stopped. Anything matching none of them is reported as **unknown**
with the raw tail attached, never as stopped — an earlier revision asked only "does it say the
gateway is running?" and answered "no" with "stopped", so any rewording of the CLI, or a stdout code
page that mangled it, silently turned a live gateway into a stopped one and offered to start
something already running. The markers deliberately contain no `✓`, `⚠` or em dash, so the parser
depends on wording rather than on the child's encoding; `PYTHONIOENCODING` is pinned to UTF-8
anyway. `verify/gateway-status.mjs` covers all five sentences, both `unknown` paths, and multiple
PIDs on one line.

The panel distinguishes the two unknowns: **无法识别** is a report it cannot read, **未知** is a
probe that failed.

**A foreign gateway cannot be killed by PID alone.** `hermes` is a launcher: `hermes gateway run`
stays resident while the real `python.exe` gateway is its child, and the PID in `gateway.pid` /
`cron status` is the gateway itself. So stopping a foreign gateway runs `hermes gateway stop`
first — which writes a planned-stop marker so the gateway drains in-flight agents and marks
sessions `resume_pending` before force-terminating what it can see (a bare `process.kill()`
skips the drain) — then re-checks `cron status` and `taskkill /T /F`s **every** PID it reports,
then re-checks once more before reporting failure.

## Development

```sh
npm test          # smoke, client, CSRF, config-schema, concurrency, health, update, install, bridge and workspace-record checks — hermetic, safe to run live
npm run test:e2e  # health-e2e + host.mjs + stop-foreign.mjs: really runs PowerShell and a dashboard
```

Every hermetic check builds its own throwaway Hermes installation under the OS temp directory, so
`npm test` neither reads nor disturbs the real one. The e2e scripts do drive a real installation;
they resolve it the same way the plugin does (set `HERMES_HOME` to override) — see
`verify/target.mjs`.

| Script | Purpose |
|---|---|
| `verify/smoke.mjs` | module loads with an empty config, registers 17 routes, activation has zero side effects |
| `verify/client.mjs` | client-half contract: the two seats, the settings page (registration, injected form face, controls covering exactly the Host schema's fields), and the panel's health button and report |
| `verify/host-csrf.mjs` | cross-site `Origin`, `Sec-Fetch-Site: cross-site` and non-loopback peers get 403 — asserted for every registered route, not just the ones with a named case |
| `verify/config.mjs` | `Config` loads with all 6 fields volatile; the live settings read (a value saved after activation, and the fallback when no settings service is mounted); `.env` parsing keeps only the whitelist and leaks no secret; the settings namespace matches the bundle row id |
| `verify/concurrency.mjs` | three simultaneous `start` calls spawn exactly one dashboard, and the lock releases afterwards |
| `verify/health.mjs` | the health route against a stubbed PowerShell: child argv, UTF-8 preamble, JSON located past a `[doctor]` prefix, failure reporting, and `pwsh` → `powershell.exe` fallback |
| `verify/health-e2e.mjs` | the same route against the **real** `doctor.ps1` — proves the part a stub cannot, including that non-ASCII details survive a real PowerShell |
| `verify/update.mjs` | the upgrade job: host commitment, `update.ps1 -Apply` argv, idempotent start, output capture, and the done/error/retry transitions. A real `-Apply` is deliberately never run — it would mutate this machine's Python environment |
| `verify/gateway-status.mjs` | every sentence `hermes cron status` can print, and both ways the answer can be unreadable: a report matching none of them, and a CLI that cannot run. The regression it exists for is that neither may be reported as *stopped* |
| `verify/bridge-render.mjs` | the `dsh --json` event stream the bridge renders: the session id that makes a follow-up possible, the final answer, tool calls as trace lines, a plain-text stdout that must **not** be mistaken for a stream, and a missing `final` falling back to the text blocks. Runs the renderer's own Python selftest, so it needs no `mcp` package and starts no server |
| `verify/package.mjs` | the packaging and metadata audit: the fields npm and DSH read, every `exports`/`files`/`main` target existing, the icon being a real PNG inside DSH's 256 KiB limit, both locale files parsing and describing the plugin's real scope, the changelog recording this version, **every verification script being wired into a script**, and nothing stray inside a published directory |
| `verify/workspace-records.mjs` | the shared workspace's two halves, against stubbed `workspaceRegistry` and `sessionQuery` services: that registration is what makes the directory (and every session under its cwd) visible, that it is idempotent and refused with a reason when the deployment has no registry, that the session list keeps only this workspace's cwd, and that one log folds into the exchange — Hermes' task, DSH's answer, reasoning, one tool call (the duplicate `tool/call` event dropped), and both tool results, the failed one marked |
| `verify/tmp.mjs` | shared helper, not an entry point: `mkdtemp` under the system temp, falling back inside the package when that directory refuses directory creation |
| `verify/bridge.mjs` | the bridge write, which is the most dangerous edit this plugin makes: that an unrelated comment, the plaintext secret and the neighbouring servers survive byte for byte, that a failed `hermes config check` rolls the file back, that a repeated apply is a no-op, and that a missing `mcp_servers:` block is created rather than appended into nowhere |
| `verify/host.mjs` | full lifecycle for a dashboard **this panel** started. Owns port 9150 by default; pass a spare port while the real one is up: `node verify/host.mjs 9266` |
| `verify/stop-foreign.mjs` | a dashboard the panel does **not** own is still really stopped. Uses 9260 by default; never touches 9150 |
| `verify/stop-gateway.mjs` | a gateway the panel does **not** own is really stopped, verified with an independent `hermes cron status`. **Starts a real gateway**, ~1 minute; make sure none is running first |

Client bundles are served as one file, so the Hermes glyph is inlined as a base64 data URL in
`client.js` rather than fetched. It is the same art the dashboard serves as its favicon. It is
rendered as a rounded **square** — a circular crop would take the top of the head with it.

## License

MIT — see [LICENSE](LICENSE).
