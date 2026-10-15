/**
 * `@guanyang14700/dsh-hermes-panel` — Client half.
 *
 * Registers ONE seat: the right column's `Hermes` tab. There is no panel in the
 * left sidebar and no `main` panel any more — the tab is the whole surface:
 *
 *  - `仪表盘` — an iframe of the NATIVE Hermes dashboard (`http://127.0.0.1:9150/`)
 *  - `记录`   — the Hermes ↔ DSH exchange, read from DSH's own session logs
 *  - `设置`   — health, upgrade, the DSH bridge and the shared workspace
 *
 * The iframe points straight at the dashboard's own origin: the native
 * dashboard sets no framing headers, so no reverse proxy is involved and the
 * page's absolute asset paths, API calls and WebSockets all stay same-origin
 * with themselves.
 *
 * Authored as a plain `window.__ModuleLoader__.load()` factory like this
 * deployment's other local bundles: React comes from the browser module table,
 * the stylesheet is injected in `apply` behind `ctx.effect`, and every colour
 * reads a `--dsw-alias-*` theme token. The client only ever calls the host's own
 * `/hermes/api/*` routes; it never spawns anything itself.
 */
/**
 * This bundle's own package name, in one place.
 *
 * Three things are keyed by it and all three break silently if they drift from
 * `package.json`:
 *
 *   - the client module id DSH loads this file under;
 *   - the `plugins.bundle.config` / `plugins.row.config` slot keys, which the
 *     Plugins page looks up by the *installed* package name — register under
 *     anything else and the bundle's own page renders no configuration at all;
 *   - the style tag, which is cosmetic but is how the stylesheet is found again.
 *
 * `scripts/publish-rename.mjs` rewrites this line along with the manifest, the
 * bundle patch and the profile dependency.
 */
const BUNDLE_PACKAGE_NAME = '@yang3333/dsh-hermes-panel';

window.__ModuleLoader__.load({
  id: BUNDLE_PACKAGE_NAME,
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/hermes/api';
    const POLL_MS = 3000;

    //#region panel-dictionaries
    // The panel's own copy, bilingual like DSH's official client packages. The
    // settings page below has a second, separate namespace: the two surfaces
    // have different vocabularies and neither should inherit the other's.
    const PANEL_LOCALE_NS = 'hermes-panel.panel';

    /** The right column's tab for the dashboard itself. */
    const DASHBOARD_KIND = 'hermes-dashboard';
    const PANEL_COPY = {
      zh: {
        'common.cancel': '取消',
        'common.hide': '收起',
        'common.confirmWrite': '确认写入',
        'common.noChange': '无需改动。',
        'common.listSeparator': ' · ',
        'common.writing': '正在写入…',
        'common.unknown': '未知',
        'common.unknownValue': '（未知）',
        'common.unsure': '（未确定）',
        'common.detecting': '检测中…',
        'common.redetect': '重新检测',
        'error.writeFailed': '写入失败',
        'error.pickerFailed': '打开目录选择器失败',
        'error.settingsNotReady': '设置表单还没就绪，请到「Hermes 面板设置」里直接填这个路径。',
        'error.noHermes': '没有找到可用的 Hermes 安装。',
        'bridge.title': 'DSH 桥',
        'bridge.noHermes': '没有找到 Hermes，无法配置桥。',
        'bridge.stateAbsent': '未接入：还没有 mcp_servers.dsh。',
        'bridge.stateOwn': '已接入本插件自带的桥脚本。',
        'bridge.stateForeign': '已接入，但指向别处（可能是另一个仓库里的旧副本）。',
        'bridge.hermesSide': 'Hermes 侧：{state}',
        'bridge.pathConfig': 'config.yaml',
        'bridge.pathScript': '桥脚本',
        'bridge.pathPython': 'Hermes python',
        'bridge.pathRoot': 'DSH 根',
        'bridge.pathWorkspace': '工作区',
        'bridge.confirmLabel': '接入',
        // 「自带副本」 read as "a Hermes this plugin bundled", which it is not. It is
        // the BRIDGE SCRIPT that ships inside this plugin.
        'bridge.switchToOwn': '改用它自己带的桥脚本',
        'bridge.warn': '会改写 Hermes 的 config.yaml（先备份，写完由 hermes config check 校验，不通过就自动回滚）。',
        'bridge.dshSide': 'DSH 侧（运行时 {version}）：',
        'bridge.profileLine': 'dsh-mcp-client {version}{note}',
        'bridge.profileMismatch': ' — 与运行时版本不一致，DSH 会禁用该 profile 的 MCP 行',
        'bridge.fixFor': '修 {name}：',
        'bridge.loop': '这一半不修，Hermes 就驱动不了 DSH，DSH 也调不到 Hermes。',
        'bridge.written': '已写入，备份：{backup}',
        'bridge.writtenNoBackup': '已写入。',
        'bridge.writeFailed': '桥写入失败：{error}',
        'directories.title': 'Hermes 目录',
        'directories.runtime': '运行时',
        'directories.runtimeHint': '跑 Hermes 的 Python 环境（它的 VENV）',
        'directories.data': '数据目录',
        'directories.dataHint': '会话、配置、密钥都在这里（HERMES_HOME）',
        'directories.pick': '选择…',
        'directories.picking': '等待选择…',
        'directories.pickHint': '在弹出的窗口里选一个目录（窗口开在运行 DSH 的那台机器上）。',
        'directories.notSet': '未设置 —— 用的是默认位置',
        'directories.runtimeFound': '在这个环境里找到了 {exe}',
        'workspace.title': '共享工作区',
        'workspace.pick': '选择目录…',
        'workspace.pickBusy': '等待选择…',
        'workspace.notConfigured': '还没配置共享工作区：选一个目录，Hermes 和 DSH 都会在它里面开工，里面的 AGENTS.md 两边都会读。',
        'workspace.pickHint': '在弹出的窗口里选一个目录（窗口开在运行 DSH 的那台机器上）。',
        'workspace.markContext': 'AGENTS.md',
        'workspace.markCwd': 'Hermes cwd',
        'workspace.markSidebar': '侧边栏',
        'workspace.volumeTitle': '数据卷',
        'workspace.volumeMissing': '这个目录不存在',
        'workspace.volumeEmpty': '目录是空的，还没有 profile',
        'workspace.volumeDetail': '{profiles} · {size} 状态',
        'workspace.volumeOfficialWeb': '有 official-web',
        'workspace.volumeUpstream': '没有 official-web（上游安装的正常情况）',
        'workspace.hermesElsewhere': 'Hermes 现在跑在 {path}',
        'workspace.bridgeElsewhere': '桥给 DSH 的是 {path}',
        'workspace.agentsMissing': '不存在',
        'workspace.agentsPresent': '存在（{bytes} 字节）',
        'workspace.dirMissing': '（不存在）',
        'workspace.cwdUnset': '（未设置 terminal.cwd）',
        'workspace.cwdHere': ' ✓ 已指向本工作区',
        'workspace.createAndPoint': '创建并指向',
        'workspace.warn': '会做三件事：确保目录存在；目录里没有 AGENTS.md 时创建一份模板（已存在则绝不覆盖）；把 Hermes 的 terminal.cwd 指过来（先备份 config.yaml，写完由 hermes config check 校验，不通过就回滚）。',
        // Picking a directory only fills the setting. It does NOT make Hermes or the
        // bridge use it — 「创建并指向」 does that — and a hint that says only "已选目录"
        // reads like the job is done. It is not, and that is a trap.
        'workspace.picked': '已选目录：{path} —— 还要按「创建并指向」，Hermes 和桥才会用上它',
        'workspace.createdDir': '已创建目录',
        'workspace.createdContext': '已创建 AGENTS.md',
        'workspace.wroteCwd': '已写入 terminal.cwd',
        'workspace.writeFailed': '共享工作区写入失败：{error}',
        'workspace.registered': '已加入（点侧边栏就能看到里面的会话记录）',
        // Says what to DO, not just what is missing. 「还没加入」 left the obvious
        // question — "so how do I add it" — with no answer on screen.
        'workspace.unregistered': '还没加入 —— 按下面的「创建并指向」，或刷新一下让面板自动补上',
        'workspace.cannotRegister': '这个 DSH 组合没有工作区注册表，加不进去',
        'workspace.registeredNow': '已加入侧边栏',
        'records.title': 'Hermes ↔ DSH 记录',
        'records.show': '看交流记录',
        'records.hide': '收起记录',
        'records.guideTitle': '交流记录',
        'records.hint': 'Hermes 每驱动一次 DSH，都会在这个共享工作区里留下一条会话记录。点开就能看到它发了什么、DSH 回了什么。',
        'records.loading': '正在读取会话记录…',
        'records.reading': '正在读取这一轮…',
        'records.empty': '这个工作区里还没有会话记录。等 Hermes 通过 dsh_run 驱动一次 DSH 就会出现。',
        'records.count': '共 {count} 条会话记录{truncated}',
        'records.truncated': '（只显示最近的）',
        'records.cwdUnknown': '（没记下工作目录）',
        'records.elsewhere': '不在共享工作区 · {path}',
        'records.untitled': '（未命名会话）',
        'records.live': '进行中',
        'records.past': '已结束',
        'records.sessionMeta': '会话 {id}\ncwd: {cwd}',
        'records.clipped': '单条内容过长已截断。',
        'records.fromHermes': 'Hermes → DSH',
        'records.fromDsh': 'DSH → Hermes',
        'records.toolsUsed': '用了 {count} 次工具：{names}',
        'records.toolsFailed': '其中有失败的调用',
        'records.noAnswer': '（这一轮没有回答）',
        'records.turnUnknown': '（没读到任务正文）',
        'records.role.tool': '工具',
        'update.title': '更新',
        'update.unavailable': '这个 Hermes 安装里没有 official-web/update.ps1，面板不能替你升级——请用你当初安装它的方式升级（例如 pip install -U hermes-agent）。',
        'update.stopping': '正在停止 Hermes…',
        'update.upgrading': '正在升级…',
        'update.done': '升级完成',
        'update.failed': '升级失败（退出码 {code}）：',
        'update.failedNoCode': '升级失败：',
        'update.checking': '正在检查版本…',
        'update.requestFailed': '更新请求失败：{error}',
        'update.available': '有新版本：{installed} → {latest}。升级会先停止 Hermes，升级后不会自动启动。',
        'update.confirm': '确认升级',
        'update.upgradeTo': '升级到 {latest}',
        'update.latest': '已是本机可用的最新版（{latest}）。',
        'update.incompatible': '最新版与本机的 Python 不匹配，update.ps1 不建议升级。',
        'update.unparsed': '读不出可比较的版本号，原样附上脚本输出。',
        'health.title': '体检',
        'check.title': '检查',
        'check.busy': '检查中…',
        'health.busy': '体检中…',
        'health.failed': '体检请求失败：{error}',
        'dashboard.tabTitle': 'Hermes',
        'setup.title': '设置',
        'dashboard.guideTitle': '打开 Hermes',
        'dashboard.guideHint': '在这一栏里直接操作 Hermes，边看对话边看它',
        'frame.openTab': '新标签打开',
        'frame.starting': '正在启动 Hermes，首次启动需要几秒…',
        'frame.failed': 'Hermes 未能启动。',
        'frame.stopped': 'Hermes 未在运行。点「启动」后，原生 dashboard 会在这里打开。',
        'empty.notFoundTitle': '没有找到 Hermes',
        'empty.notFoundHow': '在「设置」里填「运行时」和「数据目录」，指向你已经装好的 Hermes。',
        'gateway.raw': 'cron status 的输出无法识别，原文尾部：',
        'lifecycle.start': '启动',
        'lifecycle.starting': '启动中…',
        'lifecycle.stop': '停止',
        'lifecycle.stopping': '停止中…',
        'lifecycle.restart': '重启',
        'lifecycle.restarting': '重启中…',
        'badge.dashboard': '仪表盘 {status}',
        'badge.gateway': '网关 {status}',
        'state.running': '运行中',
        'state.starting': '启动中',
        'state.problem': '异常',
        'state.stopped': '已停止',
        'state.missing': '未找到安装',
        'state.notLoaded': '面板未加载',
        'state.unparsed': '无法识别',
      },
      en: {
        'common.cancel': 'Cancel',
        'common.hide': 'Hide',
        'common.confirmWrite': 'Write it',
        'common.noChange': 'Nothing to change.',
        'common.listSeparator': ' · ',
        'common.writing': 'Writing…',
        'common.unknown': 'unknown',
        'common.unknownValue': '(unknown)',
        'common.unsure': '(not determined)',
        'common.detecting': 'Detecting…',
        'common.redetect': 'Re-detect',
        'error.writeFailed': 'Write failed',
        'error.pickerFailed': 'Could not open the folder picker',
        'error.settingsNotReady': 'The settings form is not mounted yet; type this path in Hermes panel settings instead.',
        'error.noHermes': 'No usable Hermes installation was found.',
        'bridge.title': 'DSH bridge',
        'bridge.noHermes': 'No Hermes installation found, so the bridge cannot be configured.',
        'bridge.stateAbsent': 'Not connected: there is no mcp_servers.dsh entry yet.',
        'bridge.stateOwn': 'Connected to the bridge script this package ships.',
        'bridge.stateForeign': 'Connected, but pointing somewhere else — possibly an older copy in another checkout.',
        'bridge.hermesSide': 'Hermes side: {state}',
        'bridge.pathConfig': 'config.yaml',
        'bridge.pathScript': 'bridge script',
        'bridge.pathPython': 'Hermes python',
        'bridge.pathRoot': 'DSH root',
        'bridge.pathWorkspace': 'workspace',
        'bridge.confirmLabel': 'Connect',
        'bridge.switchToOwn': 'Use the shipped copy',
        'bridge.warn': 'This rewrites Hermes\\u2019 config.yaml: it is backed up first, and hermes config check must accept the result or the backup is restored.',
        'bridge.dshSide': 'DSH side (running {version}):',
        'bridge.profileLine': 'dsh-mcp-client {version}{note}',
        'bridge.profileMismatch': ' — does not match the running version, so DSH disables this profile\\u2019s MCP rows',
        'bridge.fixFor': 'Fix {name}:',
        'bridge.loop': 'Until this half is fixed, Hermes cannot drive DSH and DSH cannot reach Hermes.',
        'bridge.written': 'Written. Backup: {backup}',
        'bridge.writtenNoBackup': 'Written.',
        'bridge.writeFailed': 'Bridge write failed: {error}',
        'directories.title': 'Hermes directories',
        'directories.runtime': 'Runtime',
        'directories.runtimeHint': 'The Python environment Hermes runs in (its VENV)',
        'directories.data': 'Data directory',
        'directories.dataHint': 'Sessions, config, keys (HERMES_HOME)',
        'directories.pick': 'Choose…',
        'directories.picking': 'Waiting for a choice…',
        'directories.pickHint': 'Choose a folder in the window that just opened (it opens on the machine running DSH).',
        'directories.notSet': 'not set — using the default location',
        'directories.runtimeFound': 'found {exe} in this environment',
        'workspace.title': 'Shared workspace',
        'workspace.pick': 'Choose folder…',
        'workspace.pickBusy': 'Waiting for a choice…',
        'workspace.notConfigured': 'No shared workspace yet. Pick a folder: both Hermes and DSH will work inside it, and the AGENTS.md in it is read by both.',
        'workspace.pickHint': 'Choose a folder in the window that just opened (it opens on the machine running DSH).',
        'workspace.markContext': 'AGENTS.md',
        'workspace.markCwd': 'Hermes cwd',
        'workspace.markSidebar': 'sidebar',
        'workspace.volumeTitle': 'Data volume',
        'workspace.volumeMissing': 'this directory does not exist',
        'workspace.volumeEmpty': 'empty — no profiles yet',
        'workspace.volumeDetail': '{profiles} · {size} of state',
        'workspace.volumeOfficialWeb': 'official-web present',
        'workspace.volumeUpstream': 'no official-web (normal for an upstream install)',
        'workspace.hermesElsewhere': 'Hermes works in {path}',
        'workspace.bridgeElsewhere': 'the bridge gives DSH {path}',
        'workspace.agentsMissing': 'absent',
        'workspace.agentsPresent': 'present ({bytes} bytes)',
        'workspace.dirMissing': '(missing)',
        'workspace.cwdUnset': '(terminal.cwd is not set)',
        'workspace.cwdHere': ' ✓ already points here',
        'workspace.createAndPoint': 'Create and point here',
        'workspace.warn': 'Three things happen: the directory is created if missing; AGENTS.md is written from a template only when absent (an existing one is never overwritten); and Hermes\\u2019 terminal.cwd is pointed here, with config.yaml backed up and checked by hermes config check or rolled back.',
        // Picking a directory only fills the setting. It does NOT make Hermes or the
        // bridge use it — 「创建并指向」 does that — and a hint that says only "chosen"
        // reads like the job is done. It is not, and that is a trap.
        'workspace.picked': 'Chosen: {path} — now press 「Create and point」 so Hermes and the bridge use it',
        'workspace.createdDir': 'directory created',
        'workspace.createdContext': 'AGENTS.md created',
        'workspace.wroteCwd': 'terminal.cwd written',
        'workspace.writeFailed': 'Shared workspace write failed: {error}',
        'workspace.registered': 'listed (open it in the sidebar to see the sessions inside)',
        // Says what to DO, not just what is missing.
        'workspace.unregistered': 'not listed yet — press 「Create and point」 below, or refresh and the panel adds it',
        'workspace.cannotRegister': 'this DSH composition has no workspace registry, so it cannot be listed',
        'workspace.registeredNow': 'added to the sidebar',
        'records.title': 'Hermes ↔ DSH record',
        'records.show': 'Show the exchange',
        'records.hide': 'Hide the record',
        'records.guideTitle': 'Exchange record',
        'records.hint': 'Every time Hermes drives DSH it leaves a session record in this shared workspace. Open one to see what Hermes sent and what DSH answered.',
        'records.loading': 'Reading the session records…',
        'records.reading': 'Reading this exchange…',
        'records.empty': 'No session records here yet. They appear as soon as Hermes drives DSH through dsh_run.',
        'records.count': '{count} session record(s){truncated}',
        'records.truncated': ' (most recent only)',
        'records.cwdUnknown': '(no working directory recorded)',
        'records.elsewhere': 'outside the shared workspace · {path}',
        'records.untitled': '(untitled session)',
        'records.live': 'live',
        'records.past': 'finished',
        'records.sessionMeta': 'session {id}\ncwd: {cwd}',
        'records.clipped': 'A long entry was clipped.',
        'records.fromHermes': 'Hermes → DSH',
        'records.fromDsh': 'DSH → Hermes',
        'records.toolsUsed': '{count} tool call(s): {names}',
        'records.toolsFailed': 'some of them failed',
        'records.noAnswer': '(no answer in this turn)',
        'records.turnUnknown': '(the task text was not captured)',
        'records.role.tool': 'tool',
        'update.title': 'Update',
        'update.unavailable': 'This Hermes installation has no official-web/update.ps1, so the panel cannot upgrade it — upgrade it the way you installed it (for example pip install -U hermes-agent).',
        'update.stopping': 'Stopping Hermes…',
        'update.upgrading': 'Upgrading…',
        'update.done': 'Upgrade finished',
        'update.failed': 'Upgrade failed (exit code {code}):',
        'update.failedNoCode': 'Upgrade failed:',
        'update.checking': 'Checking the version…',
        'update.requestFailed': 'Update request failed: {error}',
        'update.available': 'A newer version exists: {installed} → {latest}. Upgrading stops Hermes first and does not start it again.',
        'update.confirm': 'Confirm upgrade',
        'update.upgradeTo': 'Upgrade to {latest}',
        'update.latest': 'Already the newest version available for this machine ({latest}).',
        'update.incompatible': 'The newest version does not fit this machine\\u2019s Python, so update.ps1 advises against upgrading.',
        'update.unparsed': 'No comparable version number could be read; the script output is attached unchanged.',
        'health.title': 'Health check',
        'check.title': 'Check',
        'check.busy': 'Checking…',
        'health.busy': 'Checking…',
        'health.failed': 'Health request failed: {error}',
        'dashboard.tabTitle': 'Hermes',
        'setup.title': 'Setup',
        'dashboard.guideTitle': 'Open Hermes',
        'dashboard.guideHint': 'Drive Hermes in this column, beside the conversation',
        'frame.openTab': 'Open in a tab',
        'frame.starting': 'Starting Hermes; the first start takes a few seconds…',
        'frame.failed': 'Hermes did not start.',
        'frame.stopped': 'Hermes is not running. Press Start and the native dashboard opens here.',
        'empty.notFoundTitle': 'No Hermes found',
        'empty.notFoundHow': 'Under Settings, point 「Runtime」 and 「Data directory」 at the Hermes you already installed.',
        'gateway.raw': 'The cron status output could not be read; raw tail:',
        'lifecycle.start': 'Start',
        'lifecycle.starting': 'Starting…',
        'lifecycle.stop': 'Stop',
        'lifecycle.stopping': 'Stopping…',
        'lifecycle.restart': 'Restart',
        'lifecycle.restarting': 'Restarting…',
        'badge.dashboard': 'Dashboard {status}',
        'badge.gateway': 'Gateway {status}',
        'state.running': 'running',
        'state.starting': 'starting',
        'state.problem': 'problem',
        'state.stopped': 'stopped',
        'state.missing': 'not installed',
        'state.notLoaded': 'panel not loaded',
        'state.unparsed': 'unreadable',
      },
    };
    //#endregion panel-dictionaries

    /**
     * The bound translator, once `apply` has registered the dictionaries.
     *
     * Null until then, and on a deployment that composes no locale service at
     * all — the same soft dependency the settings page and the primitives have.
     * `t` falls back to the Chinese dictionary so the panel still renders.
     */
    let panelTranslate = null;

    /**
     * Translate one string of the panel's own dictionary.
     * @param key - key in {@link PANEL_COPY}.
     * @param params - `{name}` substitutions, stringified as the official client
     *   packages stringify theirs.
     * @returns the localised string, or the key itself when it is unknown.
     */
    function t(key, params) {
      if (panelTranslate !== null) {
        return params === undefined ? panelTranslate(key) : panelTranslate(key, params);
      }
      const template = PANEL_COPY.zh[key] ?? key;
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
    }

    /**
     * One label/value row of a detail block.
     *
     * Both panels used to join five `label: value` lines into a monospace block
     * and pad the labels by hand. That only ever lined up in one language at one
     * font size, and it broke the moment a label was translated — which is
     * exactly what happened when these strings moved into the dictionaries.
     * These rows align through the parent grid instead.
     * @param key - react key.
     * @param label - the row's label.
     * @param value - the row's value.
     * @param options - `path` renders the value with the app's path label.
     */
    function field(key, label, value, options = {}) {
      return h('div', { className: 'hp-field', key }, [
        h('span', { className: 'hp-field-label', key: 'label' }, `${label}: `),
        options.path === true
          ? h(ui.PathLabel, { key: 'value', className: 'hp-field-value', path: String(value) })
          : h('span', { className: 'hp-field-value', key: 'value' }, value),
      ]);
    }

    /**
     * The app's own component library, with plain stand-ins.
     *
     * DSH ships buttons, status dots, tags and path labels, and using them is
     * what makes this panel look like part of the app instead of a widget that
     * happens to sit inside it. They are still a **soft** dependency — the
     * browser module table may not carry them — so each one is looked up once and
     * defaulted, never assumed.
     */
    const FALLBACK_UI = {
      Button: (props) => h(
        'button',
        {
          key: props.key,
          type: props.type ?? 'button',
          className: `hp-btn${props.variant === 'primary' ? ' hp-btn-primary' : ''}`,
          disabled: props.disabled,
          title: props.title,
          // An icon-only control carries its whole meaning here. Dropping these
          // on the fallback path would leave a button that says nothing — not to
          // a screen reader, and not to anything reading the tree.
          'aria-label': props['aria-label'],
          onClick: props.onClick,
        },
        props.icon ?? null,
        props.children,
      ),
      StateDot: (props) => h('span', { className: 'hp-dot', style: { background: dotColor(props.state) } }),
      Tag: (props) => h('span', { className: 'hp-badge' }, props.children),
      PathLabel: (props) => h('code', { className: 'hp-meta' }, props.path),
      TextShimmer: (props) => h('span', {}, props.children),
    };

    /** DSH's directory picker, when the composition carries one; set by `apply`. */
    let uiWorkspaceService = null;

    /** Mutated by `apply` with whatever the module table actually provides. */
    const ui = { ...FALLBACK_UI };

    /**
     * The plugin's own status words, mapped onto the app's dot states so the
     * colours come from the theme rather than from this file.
     * @param status - a `dashboard.status` / `gateway.status` value.
     * @returns the matching `StateDotState`.
     */
    /**
     * Two paths are the same directory if they mean the same thing.
     *
     * Compared as text on purpose: the Host already canonicalised its side, and this
     * only has to decide whether to say "somewhere else" — a false negative costs a
     * line of text, and a browser cannot resolve a Windows path anyway.
     * @param value - a path from the Host, possibly null.
     * @returns a comparable form.
     */
    function normalizePath(value) {
      return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }

    function dotState(status) {
      if (status === 'running' || status === 'done') return 'done';
      if (status === 'starting' || status === 'ongoing') return 'ongoing';
      if (status === 'stopped') return 'idle';
      if (status === 'unknown' || status === 'not-installed') return 'warning';
      return 'error';
    }

    /**
     * Small inline icons, by the names this panel asks for.
     *
     * Only the actions whose meaning is unambiguous get one: an icon that has to
     * be guessed is worse than a word that does not.
     */
    /**
     * Hermes' own face, from the plugin's `icon.png`, embedded so it cannot 404.
     *
     * The ⊕ list wants an artwork COMPONENT — DSH's neighbouring panels pass
     * `PluginArtworkTerminal` and friends — and there is no Hermes drawing among
     * them. This is the picture the plugin already ships: the dashboard favicon,
     * which is also the browser tab's.
     */
    const HERMES_FACE = 'data:image/png;base64,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';

    /**
     * The ⊕ entry's artwork: the Hermes face at the size that row wants (26px).
     * @returns the icon element.
     */
    function HermesArtwork() {
      return h('img', {
        src: HERMES_FACE,
        alt: '',
        width: 26,
        height: 26,
        style: { display: 'block', borderRadius: '6px' },
      });
    }

    const ICON_NAMES = {
      start: 'IconPlayOutlineMedium',
      stop: 'IconStopFillMedium',
      restart: 'IconRefreshOutlineMedium',
      health: 'IconGaugeOutlineMedium',
      update: 'IconDownloadOutlineMedium',
      bridge: 'IconLinkOutlineMedium',
      folder: 'IconFolderOpenOutlineMedium',
      close: 'IconCloseOutlineMedium',
      // ↗ — the arrow DSH itself uses to mean "open this somewhere else".
      openTab: 'IconRightUpOutlineMedium',
      // A list, for the exchange record the tab can show instead of the dashboard.
      records: 'IconQueueOutlineMedium',
      // The dashboard is a web page; the setup face is settings.
      globe: 'IconGlobeOutlineMedium',
      settings: 'IconSettingsOutlineMedium',
    };

    /** Icons the module table actually carries, by the keys above. */
    const icons = {};

    /**
     * @param name - a key of {@link ICON_NAMES}.
     * @returns the icon element, or null when the icon set is unavailable.
     */
    function icon(name) {
      const Component = icons[name];
      return typeof Component === 'function' ? h(Component, { key: `icon-${name}` }) : null;
    }


    /**
     * The Hermes avatar, inlined as a data URL (the client bundle is served as
     * one file, so a separate image request would have no stable base).
     * This is the SAME art the dashboard serves as its favicon: an opaque white
     * rounded square with black line work and transparent corners. It therefore
     * needs no backdrop of its own and stays legible on a dark sidebar.
     * Rendered as a rounded SQUARE, not a circle — a circular crop would take
     * the top of the head and the shoulders with it.
     */

    const CSS = [
      '.hp-root{flex:1 1 auto;height:100%;min-height:0;display:flex;flex-direction:column;',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'font-size:12px;line-height:1.5}',
      '.hp-bar{display:flex;align-items:center;gap:8px;flex:0 0 auto;flex-wrap:wrap;padding:8px 12px;',
      'border-bottom:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1)}',
      '.hp-title{font-weight:500;font-size:12px}',
      '.hp-badge{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:10px}',
      '.hp-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}',
      '.hp-sep{width:1px;height:14px;background:var(--dsw-alias-border-l3)}',
      '.hp-spacer{flex:1 1 auto}',
      '.hp-btn{display:inline-flex;align-items:center;border:.5px solid var(--dsw-alias-border-l3);',
      'border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);',
      'font:inherit;font-size:11px;padding:5px 12px;cursor:pointer;text-decoration:none}',
      '.hp-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}',
      '.hp-btn:disabled{opacity:.5;cursor:default}',
      // The shared Button supplies the real look when the app exports it; these
      // two classes are what the stand-in renders, and they keep the strip
      // legible on a deployment whose module table has no component library.
      '.hp-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-bg-layer-1));',
      'color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-label-primary));border-color:transparent}',
      // The frame is positioned over this, so the slot only has to claim the space.
      '.hp-frame-slot{flex:1 1 auto;min-height:0;display:flex;overflow:hidden}',
  // The right column's dashboard: a strip of controls, then the frame.
      '.hp-dashboard-tab{display:flex;flex-direction:column;height:100%;min-height:0}',
      '.hp-setup-tab{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px}',
      '.hp-sections{display:flex;flex-direction:column;gap:10px}',
      '.hp-dash-bar{display:flex;align-items:center;gap:4px;padding:4px 8px;',
      'border-bottom:1px solid var(--dsw-alias-border-l2);flex:0 0 auto}',
      // One rule, not two. This was wrapped across two pieces, and the label rule was
      // inserted between them — which left `.hp-dash-head` open, so every rule after it
      // became part of its value. That is what 「字体大小坏了」 was: one unclosed rule.
      // three screens away from the symptom.
      '.hp-dash-head{display:inline-flex;align-items:center;gap:5px;font-size:11px;',
      'color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.hp-dash-head-label{color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.hp-dash-tab-title{display:inline-flex;align-items:center;gap:5px}',
      // …and this fills the fixed-position host that carries it, wherever the
      // panel has been moved to.
      '.hp-frame{width:100%;height:100%;border:0;display:block;background:var(--dsw-alias-bg-layer-1)}',
      '.hp-empty-box{max-width:420px;display:flex;flex-direction:column;gap:6px}',
      '.hp-empty-title{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.hp-empty-why{font-size:10px;font-family:ui-monospace,Consolas,monospace;',
      'color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.hp-empty-how{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:4px}',
      '.hp-empty{flex:1 1 auto;display:grid;place-items:center;padding:24px;text-align:center;',
      'color:var(--dsw-alias-label-tertiary)}',
      '.hp-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:8px;max-width:520px}',
      '.hp-empty .hp-log{border-top:0;background:transparent;text-align:left;margin-top:10px;max-height:200px}',
      '.hp-meta{color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Consolas,monospace;font-size:10px}',
      '.hp-health{flex:0 0 auto;max-height:38%;overflow:auto;padding:8px 12px;',
      'border-bottom:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1)}',
      '.hp-health-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}',
      '.hp-health-title{font-weight:500;font-size:12px}',
      // Detail rows: `display:contents` on each row lets the parent grid place
      // every label and every value in one column pair, so a block of these
      // lines up without padding anything by hand.
      '.hp-fields{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 10px;',
      'align-items:baseline;font-size:12px;margin-top:8px;max-width:620px}',
      '.hp-field{display:contents}',
      '.hp-field-label{color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.hp-field-value{color:var(--dsw-alias-label-tertiary);word-break:break-all;min-width:0}',
      '.hp-fields .hp-field-value{font-family:ui-monospace,Consolas,monospace;font-size:11px}',
      // The shared-workspace facts on one line: a dot, a name, the sentence on hover.
      '.hp-workspace-path{font-size:11px;margin-top:6px;word-break:break-all}',
      // One rule. This was wrapped across two pieces, and the directories block below was
      // inserted between them — so `.hp-marks` stayed open and swallowed every `.hp-dir-*`
      // rule as if they were property declarations. The layout held (the rules still had
      // their braces) while nothing in them applied. Same mistake as `.hp-dash-head`
      // earlier in this session; the nesting check that would have caught both is back in
      // `verify/styles.mjs`, where I had taken it out for being noisy.
      '.hp-marks{display:flex;flex-wrap:wrap;gap:12px;margin-top:6px;font-size:10px;',
      'color:var(--dsw-alias-label-tertiary)}',
      '.hp-directories{margin-bottom:10px;padding-bottom:10px;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.hp-dir{display:flex;flex-direction:column;gap:2px;margin-top:8px;min-width:0}',
      '.hp-dir-label{font-size:10px;color:var(--dsw-alias-label-tertiary)}',
      '.hp-dir-value{display:flex;align-items:center;gap:8px;min-width:0}',
      '.hp-dir-path{flex:1 1 auto;min-width:0;font-size:11px;font-family:ui-monospace,Consolas,monospace;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hp-dir-hint{font-size:10px;color:var(--dsw-alias-label-tertiary);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hp-volume{margin-top:8px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l3);',
      'color:var(--dsw-alias-label-tertiary)}',
      '.hp-volume-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0}',
      '.hp-volume-title{font-size:10px;color:var(--dsw-alias-label-tertiary);flex:0 0 auto}',
      '.hp-volume-detail{margin-top:3px;font-size:10px;color:var(--dsw-alias-label-tertiary);',
      'word-break:break-all}',
      '.hp-where{margin-top:4px;font-size:10px;word-break:break-all;',
      'color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Consolas,monospace}',
      '.hp-mark{display:inline-flex;align-items:center;gap:5px}',
      '.hp-mark-ok{color:var(--dsw-alias-label-secondary)}',
      '.hp-icon-btn{align-items:center;justify-content:center;display:inline-flex;width:28px;height:28px;',
      'border-radius:6px;color:var(--dsw-alias-label-secondary);text-decoration:none}',
      '.hp-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.hp-icon-btn svg{width:16px;height:16px}',
      // A session row that expands: a full-width, left-aligned ghost button.
      '.hp-session-head{width:100%;max-width:100%;min-width:0;box-sizing:border-box;justify-content:flex-start;text-align:left;height:auto;padding:4px 6px}',
      // The right-sidebar tab: the column supplies the frame, so this fills it.
      '.hp-records-tab{height:100%;min-height:0;overflow:auto;padding:10px 12px;font-size:11px;',
      // A record row: what was asked on top, where and how it ended below.
      '.hp-rec-row{display:flex;flex-direction:column;width:100%;min-width:0;text-align:left}',
      '.hp-rec-top{display:flex;align-items:baseline;gap:8px;width:100%;min-width:0}',
      '.hp-rec-task{flex:1 1 auto;min-width:0;font-size:11px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hp-rec-when{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-tertiary)}',
      '.hp-rec-sub{display:flex;align-items:center;gap:8px;margin-top:3px;width:100%;min-width:0}',
      '.hp-rec-cwd{flex:1 1 auto;min-width:0;font-size:10px;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hp-rec-cwd-out{color:var(--dsw-alias-label-warning,var(--dsw-alias-label-tertiary))}',
      '.hp-rec-state{flex:0 0 auto;font-size:10px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.hp-rec-state-done{opacity:.7}',
      'display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}',
      '.hp-records-tab .hp-workspace{border-bottom:0;background:transparent;padding:0}',
      '.hp-records-tab .hp-checks{margin-top:6px}',
      '.hp-checks{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.hp-check{display:flex;align-items:baseline;gap:8px;font-size:11px;line-height:17px}',
      '.hp-check-name{flex:0 0 132px;color:var(--dsw-alias-label-secondary)}',
      '.hp-check-detail{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary);word-break:break-word}',
      '.hp-check-stack{display:block}',
      '.hp-check-stack .hp-check-name{flex:0 0 auto}',
      '.hp-turn-body{margin:4px 0 8px;min-width:0;overflow-wrap:anywhere}',
      '.hp-transcript{display:flex;flex-direction:column;gap:6px;border-left:.5px solid var(--dsw-alias-border-l3);padding-left:8px;min-width:0}',
      '.hp-turn{display:flex;flex-direction:column;gap:2px}',
      '.hp-turn{gap:4px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l3)}',
      '.hp-turn-head{align-items:baseline;gap:6px;display:flex}',
      '.hp-turn-who{font-size:10px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.hp-turn-when{font-size:10px;color:var(--dsw-alias-label-tertiary)}',
      '.hp-turn-said{font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word}',
      '.hp-turn-tools{font-size:10px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.hp-install{display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:12px;max-width:560px}',
      '.hp-install .hp-health-head{justify-content:center}',
      '.hp-install .hp-log{width:100%;max-height:220px;border-top:.5px solid var(--dsw-alias-border-l3);text-align:left}',
      '.hp-workspace{flex:0 0 auto;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);',
      'display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1)}',
      '.hp-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.hp-err{color:var(--dsw-alias-state-error-primary)}',
      '.hp-log{flex:0 0 auto;max-height:110px;overflow:auto;margin:0;padding:8px 12px;',
      'border-top:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);',
      'color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,Consolas,monospace;',
      'font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all}',
    ].join('');

    /**
     * This bundle's own package name — see the module-level constant above,
     * which is also the client module id. The Plugins page keys the bundle's
     * configuration slot by the installed package name, so this must equal
     * `package.json`'s `name` or that page renders nothing.
     */
    const STYLE_TAG_ID = `${BUNDLE_PACKAGE_NAME}/panel.css`;

    /**
     * The settings form's actions, published by the settings page once it has
     * mounted, so the panel can write a value the user *picked* instead of typed.
     *
     * Null until then. In practice the settings page mounts before the panel
     * renders, but the panel must not assume it — the whole client half is built
     * so a missing settings page degrades instead of throwing.
     */
    let settingsActions = null;

    /**
     * One shared status store, so the rail icon and the panel never poll twice.
     * @returns the store handle.
     */
    function createStore() {
      let state = {
        dashboard: { status: 'unknown', owned: false, error: null },
        gateway: { status: 'unknown', owned: false, pid: null, warning: null, error: null },
        url: null,
        /** Where the Host found Hermes, and what it tried when it did not. */
        discovery: { found: false, home: null, port: null, source: null, attempts: [] },
        /**
         * What the Host says this installation can do (体检 / 升级 / 安装).
         *
         * Null until the first status poll. On an upstream Hermes there is no
         * `official-web/`, so all three are false and the panel says so instead
         * of offering a button that fails.
         */
        capabilities: null,
        log: [],
        busy: false,
        /** Which command is in flight (`start`/`stop`/`restart`/`refresh`), for button labels. */
        busyAction: null,
        /**
         * Last `doctor.ps1 -Json` report, or null before the first run.
         *
         * Kept across status polls on purpose: each report costs a PowerShell
         * process and a Hermes CLI call, so it is fetched on a button press and
         * then held, never refreshed behind the user's back.
         */
        health: null,
        healthBusy: false,
        healthError: null,
        /** Last `check-update.ps1` report, as text. */
        updateReport: null,
        /** The upgrade job as the Host reports it, or null before the first run. */
        update: null,
        updateBusy: false,
        updateError: null,
        /** True between the first press of 升级 and the confirming second one. */
        updateConfirm: false,
        /** Whether the DSH-bridge section is expanded. */
        bridgeOpen: false,
        bridgeBusy: false,
        bridgeError: null,
        /** True between the first press of 接入 and the confirming second one. */
        bridgeConfirm: false,
        /** What the Host said the last time the bridge was written. */
        bridgeResult: null,
        /** The shared workspace's own busy/confirm state, read from the poll. */
        workspaceBusy: false,
        workspaceError: null,
        /** True between the first press of 创建并指向 and the confirming second one. */
        workspaceConfirm: false,
        workspaceResult: null,
        /** True while the native folder picker is open. */
        workspacePicking: false,
        /**
         * The shared workspace's records, collapsed until asked for.
         *
         * Kept out of the status poll: listing sessions reads the persistence
         * corpus, and a 3-second liveness probe must not do that.
         */
        recordsWatched: false,
        recordsBusy: false,
        recordsError: null,
        records: null,
        /** Which session's transcript is expanded, and the transcripts fetched so far. */
        sessionOpen: null,
        sessionBusy: null,
        sessionError: null,
        transcripts: {},
        /**
         * The workspace path the auto-registration attempt has already run for.
         *
         * Two surfaces can show the dashboard and each status refresh would ask
         * again, so the attempt is guarded — but on the PATH, not by a boolean: a
         * chosen directory that changes deserves a fresh attempt, and one that
         * failed once deserves a second.
         */
        registerTriedFor: null,
        // Shared by BOTH surfaces that can show the dashboard — the main panel
        // and the right column's tab. A module-scope number would not re-render
        // either of them when the other bumped it.
        frameNonce: 0,
        // Which face the right column shows. Three now that the left sidebar's panel
        // is gone and its sections live here: the dashboard, the exchange record, or
        // the setup sections. In the store rather than the component so it survives
        // closing and reopening the tab, and so a test can drive it as the strip does.
        view: 'hermes',
      };
      const listeners = new Set();

      /**
       * Replace the snapshot when anything actually changed.
       * @param patch - partial next state.
       */
      function set(patch) {
        const next = { ...state, ...patch };
        if (JSON.stringify(next) === JSON.stringify(state)) return;
        state = next;
        for (const listener of [...listeners]) listener();
      }

      async function refresh() {
        try {
          const response = await fetch(`${API}/status`, {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          set({ ...payload, busy: false, busyAction: null });
          // "配置好就自动注册": the Host reports the directory as existing but not
          // yet listed in the sidebar, so put it there without a second press.
          void autoRegisterWorkspace(payload?.workspace);
        } catch (cause) {
          set({
            dashboard: { status: 'unreachable', owned: false, error: String(cause?.message ?? cause) },
            busy: false,
            busyAction: null,
          });
        }
      }

      /**
       * Ask the Host half for a lifecycle transition.
       * @param action - `start`, `stop`, `restart` or `refresh`.
       */
      async function command(action) {
        set({ busy: true, busyAction: action });
        try {
          const response = await fetch(`${API}/${action}`, {
            method: 'POST',
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          set({ ...(await response.json()), busy: false, busyAction: null });
        } catch (cause) {
          set({ busy: false, busyAction: null, dashboard: { ...state.dashboard, error: String(cause?.message ?? cause) } });
        }
      }

      /**
       * Run Hermes' own `doctor.ps1 -Json` and hold the report.
       *
       * Deliberately outside the poll: this one spawns PowerShell and, inside
       * doctor, the Hermes CLI — a few seconds of work, not a liveness probe.
       */
      async function health() {
        set({ healthBusy: true, healthError: null });
        try {
          const response = await fetch(`${API}/health`, {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          set({ health: await response.json(), healthBusy: false, healthError: null });
        } catch (cause) {
          set({ healthBusy: false, healthError: String(cause?.message ?? cause) });
        }
      }

      /**
       * Ask Hermes whether a newer runtime exists. Report only; changes nothing.
       */
      /**
       * Both checks, from one press.
       *
       * Kept as one action rather than two calls in the click handler so that a
       * test can drive it the same way the button does, and so the two reports
       * land in the same tick.
       * @returns nothing.
       */
      async function checkAll() {
        await Promise.all([health(), checkUpdate()]);
      }

      async function checkUpdate() {
        set({ updateBusy: true, updateError: null, updateConfirm: false });
        try {
          const response = await fetch(`${API}/update/check`, {
            method: 'POST',
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          set({
            updateReport: payload.text ?? null,
            updateBusy: false,
            // A Host that has no `update.ps1` answers with a reason and no error:
            // without this the press would look like a no-op.
            updateError: payload.error ?? (payload.available === false ? payload.reason ?? null : null),
          });
        } catch (cause) {
          set({ updateBusy: false, updateError: String(cause?.message ?? cause) });
        }
      }

      let updateTimer = null;

      /**
       * Poll the upgrade job until it settles.
       *
       * The job is deliberately not part of the status poll: its output is the
       * part that matters (it is where `update.ps1` prints its rollback
       * command), and it changes far faster than a 3-second liveness probe.
       */
      function pollUpdate() {
        if (updateTimer !== null) return;
        updateTimer = setInterval(async () => {
          try {
            const response = await fetch(`${API}/update`, { headers: { accept: 'application/json' }, cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            set({ update: payload.update ?? null, updateReport: payload.report ?? state.updateReport });
            const phase = payload.update?.phase;
            if (phase !== 'running' && phase !== 'stopping') {
              clearInterval(updateTimer);
              updateTimer = null;
            }
          } catch {
            /* keep polling: the job, not this request, is what matters */
          }
        }, 1500);
      }

      /** Start the upgrade. Idempotent: a second call returns the running job. */
      async function applyUpdate() {
        set({ updateBusy: true, updateError: null, updateConfirm: false });
        try {
          const response = await fetch(`${API}/update/apply`, {
            method: 'POST',
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          set({ update: payload.update ?? null, updateBusy: false });
          pollUpdate();
        } catch (cause) {
          set({ updateBusy: false, updateError: String(cause?.message ?? cause) });
        }
      }

      /**
       * Write (or refresh) the Hermes half of the DSH bridge.
       *
       * This edits the user's live `config.yaml`, so it is behind a confirming
       * press and the Host backs the file up and verifies it with Hermes before
       * keeping the result.
       */
      async function applyBridge() {
        set({ bridgeBusy: true, bridgeError: null, bridgeConfirm: false });
        try {
          const response = await fetch(`${API}/bridge/apply`, {
            method: 'POST',
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          set({
            bridgeBusy: false,
            bridgeError: payload.applied === true ? null : (payload.error ?? t('error.writeFailed')),
            bridgeResult: payload.applied === true ? { changed: payload.changed, backup: payload.backup ?? null } : null,
          });
          // The row is read by the status poll, which refreshes within a few
          // seconds; no need to fold the returned status in by hand.
        } catch (cause) {
          set({ bridgeBusy: false, bridgeError: String(cause?.message ?? cause) });
        }
      }

      /**
       * Create the shared workspace, its `AGENTS.md`, and point Hermes at it.
       *
       * The `AGENTS.md` write is the only part that needs the Host's permission
       * story: it is skipped when the file already exists.
       */
      async function applyWorkspace() {
        set({ workspaceBusy: true, workspaceError: null, workspaceConfirm: false });
        try {
          const response = await fetch(`${API}/workspace/apply`, {
            method: 'POST',
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          set({
            workspaceBusy: false,
            workspaceError: payload.applied === true ? null : (payload.error ?? t('error.writeFailed')),
            workspaceResult: payload.applied === true
              ? { createdDirectory: payload.createdDirectory, createdContext: payload.createdContext, configChanged: payload.configChanged, backup: payload.backup ?? null, note: payload.note ?? null }
              : null,
          });
        } catch (cause) {
          set({ workspaceBusy: false, workspaceError: String(cause?.message ?? cause) });
        }
      }

      /**
       * Pick the shared workspace with the machine's own folder dialog.
       *
       * The chosen path is written through the settings form's own actions rather
       * than through a bespoke route, so it goes in the same way a typed value
       * does — validated against the Host schema, and visible in the settings
       * page afterwards.
       */
      async function pickWorkspace() {
        set({ workspacePicking: true, workspaceError: null });
        try {
          const path = await askForDirectory();
          if (path === null) {
            set({ workspacePicking: false });
            return;
          }
          if (settingsActions === null) {
            throw new Error(t('error.settingsNotReady'));
          }
          // edit() only stages the draft; save() is what the Host validates.
          settingsActions.edit('sharedWorkspace', path);
          await settingsActions.save();
          set({ workspacePicking: false, workspaceResult: { picked: path } });
        } catch (cause) {
          set({ workspacePicking: false, workspaceError: String(cause?.message ?? cause) });
        }
      }

      /**
       * Point one of the two directory settings at a picked folder.
       *
       * The same picker the shared workspace uses, and the same reason: a path typed
       * into a box is the one input that cannot be checked by looking at it.
       * @param field - `runtimeDir` or `dataDir`.
       */
      async function pickDirectoryFor(field) {
        set({ workspacePicking: true, workspaceError: null });
        try {
          const path = await askForDirectory();
          if (path === null) {
            set({ workspacePicking: false });
            return;
          }
          if (settingsActions === null) {
            throw new Error(t('error.settingsNotReady'));
          }
          // edit() only stages the draft; save() is what the Host validates.
          settingsActions.edit(field, path);
          await settingsActions.save();
          set({ workspacePicking: false });
        } catch (cause) {
          set({ workspacePicking: false, workspaceError: String(cause?.message ?? cause) });
        }
      }

      /**
       * Ask for a directory, DSH first.
       *
       * `uiWorkspace.pickDirectory()` is the picker DSH's own workspace flows use,
       * and it is wired to whatever this composition actually has — the native
       * dialog, the in-app browser, or a desktop bridge. Spawning our own modal
       * PowerShell dialog was the thing that hung.
       * @returns the chosen path, or null when the user cancelled.
       */
      async function askForDirectory() {
        const uiWorkspace = uiWorkspaceService;
        if (uiWorkspace !== undefined && uiWorkspace !== null && typeof uiWorkspace.pickDirectory === 'function') {
          const chosen = await uiWorkspace.pickDirectory();
          return typeof chosen === 'string' && chosen !== '' ? chosen : null;
        }
        // Fallback: the plugin's own route, for a composition with no uiWorkspace.
        const response = await fetch(`${API}/pick-directory`, {
          method: 'POST',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (payload.picked !== true) throw new Error(payload.error ?? t('error.pickerFailed'));
        return payload.cancelled === true ? null : payload.path;
      }

      /**
       * Put the shared workspace in the sidebar without a second press.
       *
       * Runs at most once per page and only when the Host says the directory
       * exists but is not listed yet, so a poll that keeps reporting the same
       * state cannot turn into a loop. The registration itself is idempotent on
       * the Host side; this guard is about not asking repeatedly, not about
       * correctness.
       * @param workspace - the `workspace` block from the status payload.
       */
      async function autoRegisterWorkspace(workspace) {
        if (workspace?.needsRegistration !== true) return;
        // Once PER PATH, not once per session.
        //
        // A bare boolean meant the panel tried exactly one time and then never
        // again: if the first attempt happened while the setting pointed somewhere
        // else — or simply failed — the sidebar mark stayed amber for the rest of
        // the session, even after a new workspace was chosen. Keyed on the path, a
        // new choice gets a new attempt and a retry cannot become a request storm.
        if (state.registerTriedFor === workspace?.path) return;
        set({ registerTriedFor: workspace?.path ?? null });
        try {
          const response = await fetch(`${API}/workspace/register`, {
            method: 'POST',
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          if (payload.applied !== true) {
            set({ workspaceError: payload.error ?? t('error.writeFailed') });
            return;
          }
          set({
            workspaceResult: { registered: true, path: payload.status?.path ?? workspace.path },
            // Fold the returned status in rather than asking for another poll:
            // `refresh()` is already in flight when this runs, and a second
            // concurrent status request would read the same pre-registration
            // state and flip the flag straight back.
            ...(payload.status === undefined ? {} : { workspace: payload.status }),
          });
          // The sidebar reads its own feed, which the Host pushes to every
          // connected client the moment the registry commits. The record list is
          // this panel's own read, so it has to be asked for again.
          if (state.recordsWatched) await loadRecords(true);
        } catch (cause) {
          set({ workspaceError: String(cause?.message ?? cause) });
        }
      }

      /** Read the workspace's session records into the store. @returns nothing. */
      async function loadRecords(quiet = false) {
        // The poll refreshes silently: a busy line that appears every few
        // seconds reads as flicker, not as progress.
        if (quiet !== true) set({ recordsBusy: true, recordsError: null });
        try {
          const response = await fetch(`${API}/workspace/sessions`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          set({
            records: payload,
            recordsBusy: false,
            recordsError: payload.available === true ? null : (payload.reason ?? null),
          });
        } catch (cause) {
          set({ recordsBusy: false, recordsError: String(cause?.message ?? cause) });
        }
      }

      /**
       * Follow the record while its right-column tab is on screen.
       *
       * The tab is the only reader now, so it announces itself: listing the
       * session corpus is storage work rather than a liveness probe, and it stays
       * off the poll entirely while no tab is mounted.
       * @param on - whether the tab is mounted.
       * @returns nothing.
       */
      function watchRecords(on) {
        set({ recordsWatched: on === true });
      }

      /**
       * Expand one record: the exchange Hermes sent, and what DSH answered.
       *
       * A transcript is fetched once and kept — reading a session replays its
       * whole log, so re-reading on every toggle would be wasteful — and a
       * failed read stays on screen as a sentence rather than as an empty
       * conversation.
       * @param sessionId - the session to read.
       */
      /**
       * Open the newest exchange, so the summary is what you see first.
       *
       * The record list on its own answers "how many" and not "what did they say" —
       * a reader who just switched to the record wants the exchange, and the newest
       * one is the exchange they were watching. Opening it is the difference between
       * a list and a summary.
       * @returns nothing.
       */
      async function openNewestRecord() {
        const sessions = Array.isArray(state.records?.sessions) ? state.records.sessions : [];
        const newest = sessions[0];
        if (newest === undefined || state.sessionOpen === newest.id) return;
        await toggleSession(newest.id);
      }

      async function toggleSession(sessionId) {
        if (state.sessionOpen === sessionId) {
          set({ sessionOpen: null });
          return;
        }
        set({ sessionOpen: sessionId, sessionError: null });
        if (state.transcripts[sessionId] !== undefined) return;
        set({ sessionBusy: sessionId });
        try {
          const response = await fetch(`${API}/workspace/session?id=${encodeURIComponent(sessionId)}`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          set({
            transcripts: { ...state.transcripts, [sessionId]: payload },
            sessionBusy: null,
            sessionError: payload.available === true ? null : (payload.reason ?? null),
          });
        } catch (cause) {
          set({ sessionBusy: null, sessionError: String(cause?.message ?? cause) });
        }
      }

      let timer = null;
      /**
       * Start polling once for the whole page.
       *
       * A hidden tab skips its ticks: the poll is a liveness probe for a panel
       * nobody is looking at, and DSH sessions stay open for hours.
       * @param intervalMs - poll period.
       * @returns the stop function.
       */
      function startPolling(intervalMs) {
        if (timer) return () => {};
        void refresh();
        timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          void refresh();
        }, intervalMs);
        return () => {
          if (timer) clearInterval(timer);
          timer = null;
          if (updateTimer !== null) clearInterval(updateTimer);
          updateTimer = null;
        };
      }

      return {
        getState: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        startPolling,
        command,
        /** Show the exchange record in the right column, or the dashboard again. */
        /** Show one of the tab's faces. @param name - hermes, records or setup. */
        setView: (name) => set({ view: name }),
        toggleRecords: () => set({ view: state.view === 'records' ? 'hermes' : 'records' }),
        openNewestRecord,
        /** Discard the dashboard frame and load it again. */
        reloadFrame: () => set({ frameNonce: (state.frameNonce ?? 0) + 1 }),
        health,
        dismissHealth: () => set({ health: null, healthError: null }),
        checkUpdate,
        checkAll,
        applyUpdate,
        confirmUpdate: () => set({ updateConfirm: true }),
        cancelUpdate: () => set({ updateConfirm: false }),
        dismissUpdate: () => set({ updateReport: null, update: null, updateError: null, updateConfirm: false }),
        toggleBridge: () => set({ bridgeOpen: state.bridgeOpen !== true, bridgeConfirm: false, bridgeError: null }),
        applyBridge,
        confirmBridge: () => set({ bridgeConfirm: true }),
        cancelBridge: () => set({ bridgeConfirm: false }),
        applyWorkspace,
        confirmWorkspace: () => set({ workspaceConfirm: true }),
        cancelWorkspace: () => set({ workspaceConfirm: false }),
        pickWorkspace,
        pickDirectoryFor,
        watchRecords,
        toggleSession,
        // The poll's own read, and the record list, so a test can await an
        // effect instead of sleeping through the poll interval.
        refresh,
        loadRecords,
      };
    }

    const store = createStore();

    /** Subscribe a component to the shared store. */
    function useStatus() {
      const [snapshot, setSnapshot] = React.useState(() => store.getState());
      React.useEffect(() => store.subscribe(() => setSnapshot(store.getState())), []);
      return snapshot;
    }

    /**
     * Read `check-update.ps1`'s report for whether an upgrade is worth offering.
     *
     * This parses Hermes' own output rather than asking PyPI again: the script
     * already handled the mirror, `requires_python`, and the "not installable on
     * this Python" case, and second-guessing it here would be a second
     * implementation to keep in step.
     * @param report - the script's text.
     * @returns a verdict: `unknown`, `blocked`, `current` or `available`.
     */
    function updateAvailability(report) {
      if (typeof report !== 'string' || report === '') return { state: 'unknown' };
      if (/NOT installable/i.test(report)) return { state: 'blocked' };
      const latest = /latest\s*:\s*(\d+\.\d+\.\d+)/.exec(report);
      if (latest === null) return { state: 'unknown' };
      const installed = /installed\s*:\s*.*?v(\d+\.\d+\.\d+)/.exec(report);
      if (installed !== null && installed[1] === latest[1]) return { state: 'current', latest: latest[1] };
      return { state: 'available', latest: latest[1], installed: installed === null ? null : installed[1] };
    }


    /**
     * The DSH ↔ Hermes bridge, both halves.
     *
     * The two halves fail independently: the Hermes half is a `mcp_servers.dsh`
     * entry in `config.yaml`, and the DSH half is the `@deepseek-ai/dsh-mcp-client`
     * package a profile resolves. DSH disables the MCP rows outright when that
     * package does not match the runtime, so the panel reports both rather than
     * a single "connected" light that would hide which half is broken.
     * @param props - the status, busy/error flags, the confirm flag and actions.
     */
    function BridgePanel(props) {
      const { status, busy, error, confirm, result } = props;
      if (status === null || status === undefined) return null;

      const head = [h('span', { key: 'title', className: 'hp-health-title' }, t('bridge.title'))];
      head.push(h('span', { key: 'spacer', className: 'hp-spacer' }));
      // In the right column's 「设置」 view this section IS the view: there is no
      // disclosure around it, so a button offering to collapse it would do nothing.
      if (props.fixed !== true) {
        head.push(h(
          ui.Button,
          { key: 'hide', variant: 'ghost', size: 'sm', onClick: () => props.onToggle() },
          t('common.hide'),
        ));
      }
      const children = [h('div', { key: 'head', className: 'hp-health-head' }, head)];

      if (status.available !== true) {
        children.push(h('div', { key: 'none', className: 'hp-hint' }, t('bridge.noHermes')));
        return h('div', { className: 'hp-health' }, children);
      }

      // ---- the Hermes half
      const hermesState = status.configured !== true
        ? t('bridge.stateAbsent')
        : (status.pointsAtThisCopy === true
          ? t('bridge.stateOwn')
          : t('bridge.stateForeign'));
      children.push(h('div', { key: 'hermes', className: 'hp-hint' }, t('bridge.hermesSide', { state: hermesState })));
      children.push(h('div', { key: 'paths', className: 'hp-fields' }, [
        field('config', t('bridge.pathConfig'), status.configPath ?? t('common.unknownValue'), { path: true }),
        field('script', t('bridge.pathScript'), status.scriptPath ?? t('common.unknownValue'), { path: true }),
        field('python', t('bridge.pathPython'), status.python ?? t('common.unknownValue'), { path: true }),
        field('root', t('bridge.pathRoot'), status.dshRoot ?? t('common.unknownValue'), { path: true }),
        field('workspace', t('bridge.pathWorkspace'), status.workspace ?? t('common.unknownValue'), { path: true }),
      ]));

      if (status.pointsAtThisCopy !== true) {
        children.push(h('div', { key: 'actions', className: 'hp-health-head' }, confirm
          ? [
              h(ui.Button, { key: 'go', variant: 'outline', size: 'sm', disabled: busy, onClick: () => props.onApply() }, t('common.confirmWrite')),
              h(ui.Button, { key: 'cancel', variant: 'ghost', size: 'sm', onClick: () => props.onCancel() }, t('common.cancel')),
            ]
          : [h(ui.Button, { key: 'apply', variant: 'outline', size: 'sm', disabled: busy, onClick: () => props.onConfirm() }, status.configured === true ? t('bridge.switchToOwn') : t('bridge.confirmLabel'))]));
        if (confirm) {
          children.push(h('div', { key: 'warn', className: 'hp-hint' }, t('bridge.warn')));
        }
      }

      // ---- the DSH half
      const profiles = Array.isArray(status.profiles) ? status.profiles : [];
      if (profiles.length > 0) {
        const broken = profiles.filter((profile) => profile.compatible === false);
        children.push(h('div', { key: 'dsh-head', className: 'hp-hint' }, t('bridge.dshSide', { version: status.dshVersion ?? '?' })));
        children.push(h('ul', { key: 'dsh-list', className: 'hp-checks' }, profiles.map((profile, index) => h(
          'li',
          { key: `${profile.name}-${index}`, className: 'hp-check' },
          [
            h('span', { key: 'dot', className: 'hp-dot', style: { background: profile.compatible === true ? checkColor('OK') : checkColor('FAIL') } }),
            h('span', { key: 'name', className: 'hp-check-name' }, profile.name),
            h('span', { key: 'detail', className: 'hp-check-detail' }, t('bridge.profileLine', {
              version: profile.version ?? '?',
              note: profile.compatible === true ? '' : t('bridge.profileMismatch'),
            })),
          ],
        ))));
        for (const profile of broken) {
          const fix = `dsh plugin --profile ${profile.name} add @deepseek-ai/dsh-mcp-client@${status.dshVersion ?? '?'}`;
          children.push(h('div', { key: `fix-${profile.name}`, className: 'hp-hint' }, t('bridge.fixFor', { name: profile.name })));
          children.push(h('pre', { key: `fixcmd-${profile.name}`, className: 'hp-log hp-hint' }, fix));
        }
        if (broken.length > 0) {
          children.push(h('div', { key: 'loop', className: 'hp-hint' }, t('bridge.loop')));
        }
      }

      if (result !== null && result !== undefined) {
        children.push(h('div', { key: 'result', className: 'hp-hint' }, result.changed === true ? (result.backup ? t('bridge.written', { backup: result.backup }) : t('bridge.writtenNoBackup')) : t('common.noChange')));
      }
      if (error !== null && error !== undefined) {
        children.push(h('pre', { key: 'error', className: 'hp-log hp-err' }, t('bridge.writeFailed', { error: String(error) })));
      }
      if (busy === true) children.push(h('div', { key: 'busy', className: 'hp-hint' }, t('common.writing')));
      return h('div', { className: 'hp-health' }, children);
    }

    /**
     * The shared workspace, and whether both sides actually work in it.
     *
     * The context half needs no format conversion: DSH's `dsh-agent-instructions`
     * looks for `AGENTS.md`, and Hermes' own context discovery reads the same
     * file. What the plugin has to get right is the *directory* — one place both
     * agents open in — after which the file is simply picked up by both.
     * @param props - the status, busy/error flags, the confirm flag and actions.
     */
    /**
     * One `● AGENTS.md` mark: a dot, a name, and the whole sentence behind it
     * as a tooltip. Three of these replace what used to be three rows.
     * @param key - react key.
     * @param ok - whether that half of the setup is in place.
     * @param label - the name shown.
     * @param detail - the sentence, shown on hover.
     * @returns the mark.
     */
    function mark(key, ok, label, detail) {
      return h('span', { key, className: ok ? 'hp-mark hp-mark-ok' : 'hp-mark', title: detail }, [
        h(ui.StateDot, { key: 'dot', state: ok ? 'done' : 'warning' }),
        h('span', { key: 'text' }, label),
      ]);
    }

    /**
     * One line describing a Hermes home, from the facts the Host counted.
     * @param volume - the `volume` report, or null when the directory is gone.
     * @returns the sentence.
     */
    function volumeDetail(volume) {
      if (volume === null || volume === undefined) return t('workspace.volumeMissing');
      const profiles = Array.isArray(volume.profiles) ? volume.profiles : [];
      if (profiles.length === 0) return t('workspace.volumeEmpty');
      const bytes = Number(volume.stateBytes) || 0;
      const size = bytes >= 1048576
        ? `${(bytes / 1048576).toFixed(1)} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} KB`;
      return [
        t('workspace.volumeDetail', { profiles: profiles.slice(0, 3).join('、') + (profiles.length > 3 ? '…' : ''), size }),
        volume.officialWeb === true ? t('workspace.volumeOfficialWeb') : t('workspace.volumeUpstream'),
      ].join(' · ');
    }

    /**
     * The two directories the panel reads, each with a picker.
     *
     * A path is the one setting a text box cannot validate, so each row carries the
     * evidence: for the data directory, what is inside it; for the runtime, the CLI
     * that was found there.
     * @param props - the discovery payload and the pick handlers.
     * @returns the section.
     */
    function DirectoriesSection(props) {
      const { discovery, busy, picking, onPickRuntime, onPickData } = props;
      const row = (key, label, hint, value, onPick, detail) => h('div', { key, className: 'hp-dir' }, [
        h('div', { key: 'label', className: 'hp-dir-label' }, label),
        h('div', { key: 'value', className: 'hp-dir-value' }, [
          h('span', { key: 'path', className: 'hp-dir-path' }, value === null || value === ''
            ? t('directories.notSet')
            : value),
          h(ui.Button, {
            key: 'pick',
            variant: 'outline',
            size: 'sm',
            disabled: busy,
            onClick: onPick,
          }, picking ? t('directories.picking') : t('directories.pick')),
        ]),
        h('div', { key: 'hint', className: 'hp-dir-hint' }, detail ?? hint),
      ]);
      return h('div', { className: 'hp-directories' }, [
        h('div', { key: 'head', className: 'hp-health-head' },
          h('span', { key: 'title', className: 'hp-health-title' }, t('directories.title'))),
        row('runtime', t('directories.runtime'), t('directories.runtimeHint'),
          discovery?.runtimeDir ?? null, onPickRuntime,
          discovery?.exe ? t('directories.runtimeFound', { exe: String(discovery.exe) }) : null),
        row('data', t('directories.data'), t('directories.dataHint'),
          discovery?.dataDir ?? null, onPickData, null),
        picking ? h('div', { key: 'pickwait', className: 'hp-hint' }, t('directories.pickHint')) : null,
      ]);
    }

    function WorkspaceSection(props) {
      const { status, busy, error, confirm, result } = props;
      if (status === null || status === undefined) return null;

      const children = [];
      const picking = props.picking === true;

      /** The directory picker: the only path input that cannot be mistyped. */
      const pickButton = h(ui.Button, {
        key: 'pick',
        variant: 'ghost',
        size: 'sm',
        disabled: busy || picking,
        onClick: () => props.onPick(),
      }, picking ? t('workspace.pickBusy') : t('workspace.pick'));

      children.push(h('div', { key: 'head', className: 'hp-health-head' }, [
        h('span', { key: 'title', className: 'hp-health-title' }, t('workspace.title')),
        h('span', { key: 'spacer', className: 'hp-spacer' }),
        pickButton,
      ]));

      if (status.configured !== true) {
        children.push(h('div', { key: 'hint', className: 'hp-hint' }, t('workspace.notConfigured')));
        if (picking) children.push(h('div', { key: 'pickwait', className: 'hp-hint' }, t('workspace.pickHint')));
        if (error !== null && error !== undefined) {
          children.push(h('pre', { key: 'error', className: 'hp-log hp-err' }, `${error}`));
        }
        return h('div', { className: 'hp-workspace' }, children);
      }

      const needsWork = status.exists !== true || status.contextExists !== true || status.hermesPointsHere !== true;
      children.push(h('div', { key: 'path', className: 'hp-workspace-path' }, h(ui.PathLabel, {
        path: `${status.path ?? t('common.unknownValue')}${status.exists === true ? '' : ` ${t('workspace.dirMissing')}`}`,
      })));
      // Three facts, one line, each with its full sentence behind the tooltip.
      children.push(h('div', { key: 'marks', className: 'hp-marks' }, [
        mark('context', status.contextExists === true, t('workspace.markContext'), status.contextExists === true
          ? t('workspace.agentsPresent', { bytes: String(status.contextBytes ?? '?') })
          : t('workspace.agentsMissing')),
        mark('cwd', status.hermesPointsHere === true, t('workspace.markCwd'),
          status.hermesPointsHere === true ? t('workspace.cwdHere') : t('workspace.cwdUnset')),
        mark('sidebar', status.registered === true, t('workspace.markSidebar'), status.registered === true
          ? t('workspace.registered')
          : (status.canRegister === true ? t('workspace.unregistered') : t('workspace.cannotRegister'))),
      ]));
      // The volume, and what is in it. `dataDir` is the one setting a text box cannot
      // validate — a right path and a wrong path read identically — so the evidence
      // goes next to it: which profiles are in there, how much state, whether the
      // maintenance folder came with it.
      children.push(h('div', { key: 'volume', className: 'hp-volume' }, [
        h('div', { key: 'head', className: 'hp-volume-head' }, [
          h('span', { key: 'title', className: 'hp-volume-title' }, t('workspace.volumeTitle')),
          h(ui.PathLabel, { key: 'path', path: String(status.dataDir ?? t('common.unknownValue')) }),
        ]),
        h('div', { key: 'detail', className: 'hp-volume-detail' }, volumeDetail(status.volume)),
      ]));
      // "Which workspace?" is the question this whole section exists to answer, and
      // a red mark only says THAT the two disagree, never where the other one is.
      // So when Hermes works somewhere else, say where.
      if (status.hermesPointsHere !== true && typeof status.hermesTerminalCwd === 'string' && status.hermesTerminalCwd !== '') {
        children.push(h('div', { key: 'elsewhere', className: 'hp-where' },
          t('workspace.hermesElsewhere', { path: status.hermesTerminalCwd })));
      }
      if (typeof status.bridgeWorkspace === 'string' && status.bridgeWorkspace !== ''
        && normalizePath(status.bridgeWorkspace) !== normalizePath(status.path)) {
        children.push(h('div', { key: 'bridgewhere', className: 'hp-where' },
          t('workspace.bridgeElsewhere', { path: status.bridgeWorkspace })));
      }

      if (needsWork) {
        children.push(h('div', { key: 'actions', className: 'hp-health-head' }, confirm
          ? [
              h(ui.Button, { key: 'go', variant: 'outline', size: 'sm', disabled: busy, onClick: () => props.onApply() }, t('common.confirmWrite')),
              h(ui.Button, { key: 'cancel', variant: 'ghost', size: 'sm', onClick: () => props.onCancel() }, t('common.cancel')),
            ]
          : [h(ui.Button, { key: 'apply', variant: 'outline', size: 'sm', disabled: busy, onClick: () => props.onConfirm() }, t('workspace.createAndPoint'))]));
      } else {
        // Three green marks above are the confirmation; a sentence saying so
        // again would be one line of nothing.
      }
      if (confirm) {
        children.push(h('div', { key: 'warn', className: 'hp-hint' }, t('workspace.warn')));
      }

      if (result !== null && result !== undefined) {
        const bits = [];
        if (result.path) bits.push(t('workspace.picked', { path: result.path }));
        if (result.registered) bits.push(t('workspace.registeredNow'));
        if (result.createdDirectory) bits.push(t('workspace.createdDir'));
        if (result.createdContext) bits.push(t('workspace.createdContext'));
        if (result.configChanged) bits.push(t('workspace.wroteCwd'));
        children.push(h('div', { key: 'result', className: 'hp-hint' }, bits.length > 0 ? bits.join(t('common.listSeparator')) : t('common.noChange')));
      }
      if (result?.note) children.push(h('div', { key: 'note', className: 'hp-hint' }, result.note));
      if (error !== null && error !== undefined) {
        children.push(h('pre', { key: 'error', className: 'hp-log hp-err' }, t('workspace.writeFailed', { error: String(error) })));
      }
      if (busy === true) children.push(h('div', { key: 'busy', className: 'hp-hint' }, t('common.writing')));

      // The exchange record deliberately does NOT live here. It is a right-column
      // tab, beside 工作区文件 and 新建终端, because the panel replaces the DSH
      // view while it is open: a record shown inside this panel is one you have
      // to leave your DSH conversation to read.
      return h('div', { className: 'hp-workspace' }, children);
    }

    /**
     * The Hermes ↔ DSH record for the shared workspace.
     *
     * This is the half that was missing: the directory and its `AGENTS.md` are
     * the shared *context*, but an exchange leaves its trace in DSH's session
     * log, not in a file on disk. So the list here is the session corpus
     * filtered by working directory, and each row expands into the turned-down
     * conversation: the task Hermes sent, what DSH answered, and the tool calls
     * in between.
     * @param props - the record payload, expansion state, and the two actions.
     */
    /**
     * Fold the flat entry list into turns.
     *
     * The raw list is every message, every tool call and every tool result —
     * accurate and unreadable. A turn is the unit a reader actually wants: one
     * task Hermes sent, whatever it caused, and the answer that came back.
     * @param entries - the transcript entries, in order.
     * @returns one record per turn; a preamble with no task is its own turn.
     */
    function foldTurns(entries) {
      const turns = [];
      let current = null;
      let injected = false;
      for (const entry of entries) {
        if (entry.role === 'user') {
          // Injected context is not something Hermes said: it is the system
          // preamble DSH assembled, and printing it as a task would be a lie.
          if (entry.kind === 'context') { injected = true; continue; }
          current = { task: entry, tools: [], answers: [], hadContext: injected };
          injected = false;
          turns.push(current);
          continue;
        }
        if (current === null) {
          current = { task: null, tools: [], answers: [], hadContext: injected };
          injected = false;
          turns.push(current);
        }
        if (entry.role === 'assistant') {
          // A tool call arrives as an assistant message with `kind: 'tool-call'`.
          // It is not an answer — filing it under answers would print a JSON
          // argument blob where the reply belongs.
          if (entry.kind === 'tool-call') current.tools.push(entry);
          else current.answers.push(entry);
        } else if (entry.role === 'tool') current.tools.push(entry);
      }
      return turns;
    }

    /**
     * `read · write · pwsh ×4` — the tool names, counted rather than listed.
     * @param tools - the tool entries of one turn.
     * @returns the one-line summary.
     */
    function toolSummary(tools) {
      const counts = new Map();
      for (const tool of tools) {
        const name = tool.tool ?? t('records.role.tool');
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([name, count]) => (count === 1 ? name : `${name} ×${count}`))
        .join(t('common.listSeparator'));
    }

    function WorkspaceRecords(props) {
      // `bare` is the right-sidebar tab: the column already provides the frame,
      // so the card header and its Hide toggle would be a second one inside it.
      const head = [h('span', { key: 'title', className: 'hp-health-title' }, t('records.title'))];
      head.push(h('span', { key: 'spacer', className: 'hp-spacer' }));
      head.push(h(
        ui.Button,
        { key: 'toggle', variant: 'ghost', size: 'sm', disabled: props.busy, onClick: () => props.onToggle?.() },
        props.open ? t('records.hide') : t('records.show'),
      ));
      const children = props.bare === true
        ? []
        : [h('div', { key: 'head', className: 'hp-health-head' }, head)];

      if (props.open !== true) {
        children.push(h('div', { key: 'hint', className: 'hp-hint' }, t('records.hint')));
        return h('div', { className: 'hp-workspace' }, children);
      }
      if (props.busy === true && props.records === null) {
        children.push(h('div', { key: 'loading', className: 'hp-hint' }, t('records.loading')));
        return h('div', { className: 'hp-workspace' }, children);
      }
      if (props.error !== null && props.error !== undefined) {
        children.push(h('pre', { key: 'error', className: 'hp-log hp-err' }, String(props.error)));
      }
      const sessions = Array.isArray(props.records?.sessions) ? props.records.sessions : [];
      if (sessions.length === 0) {
        children.push(h('div', { key: 'empty', className: 'hp-hint' }, t('records.empty')));
        return h('div', { className: 'hp-workspace' }, children);
      }
      children.push(h('div', { key: 'count', className: 'hp-hint' }, t('records.count', {
        count: String(sessions.length),
        truncated: props.records?.truncated === true ? t('records.truncated') : '',
      })));

      const transcripts = props.transcripts ?? {};
      children.push(h('ul', { key: 'list', className: 'hp-checks' }, sessions.map((session) => {
        const open = props.sessionOpen === session.id;
        const busy = props.sessionBusy === session.id;
        const transcript = transcripts[session.id];
        // Two lines with a hierarchy: what was asked, then where and how it ended.
        // The task is the journal's — the transcript cannot supply it.
        //
        // Wrapped in ONE element: the Button lays its children out in a row, so two
        // siblings would sit side by side and the cwd would land on the task's line.
        // The wrapper owns the column.
        const row = h('div', { key: 'row', className: 'hp-rec-row' }, [
          h('div', { key: 'top', className: 'hp-rec-top' }, [
            h('span', { key: 'task', className: 'hp-rec-task' }, session.task ?? session.title ?? t('records.untitled')),
            h('span', { key: 'when', className: 'hp-rec-when' }, formatWhen(session.since)),
          ]),
          h('div', { key: 'sub', className: 'hp-rec-sub' }, [
            h('span', {
              key: 'cwd',
              className: session.shared === true ? 'hp-rec-cwd' : 'hp-rec-cwd hp-rec-cwd-out',
              title: session.shared === true
                ? (session.cwd ?? t('records.cwdUnknown'))
                : t('records.elsewhere', { path: session.cwd ?? t('records.cwdUnknown') }),
            }, session.cwd ?? t('records.cwdUnknown')),
            h('span', {
              key: 'state',
              className: session.live === true ? 'hp-rec-state' : 'hp-rec-state hp-rec-state-done',
            }, session.live === true ? t('records.live') : t('records.past')),
          ]),
        ]);
        const body = [];
        if (busy) body.push(h('div', { key: 'loading', className: 'hp-hint' }, t('records.reading')));
        if (open && props.sessionError !== null && props.sessionError !== undefined) {
          body.push(h('pre', { key: 'serror', className: 'hp-log hp-err' }, String(props.sessionError)));
        }
        if (open && transcript !== undefined) {
          if (transcript.reason) body.push(h('div', { key: 'reason', className: 'hp-hint' }, transcript.reason));
          const entries = Array.isArray(transcript.entries) ? transcript.entries : [];
          body.push(h('div', { key: 'session-meta', className: 'hp-hint' }, t('records.sessionMeta', {
            id: transcript.session?.id ?? session.id,
            cwd: transcript.session?.cwd ?? t('common.unsure'),
          })));
          const turns = foldTurns(entries);
          body.push(h('div', { key: 'transcript', className: 'hp-transcript' }, turns.map((turn, index) => {
            const answer = turn.answers.length === 0 ? null : turn.answers[turn.answers.length - 1];
            const failed = turn.tools.some((tool) => tool.kind === 'tool-error');
            return h('div', { key: `turn-${index}`, className: 'hp-turn' }, [
              h('div', { key: 'said-by-hermes', className: 'hp-turn-head' }, [
                h('span', { key: 'who', className: 'hp-turn-who' }, t('records.fromHermes')),
                h('span', { key: 'when', className: 'hp-turn-when' }, turn.task?.clock ?? ''),
              ]),
              h('div', { key: 'task', className: 'hp-turn-said' },
                // The journal is the only place the task exists: DSH receives it as a
                // CLI argument, so the session log has no user message carrying it.
                turn.task?.text ?? session.task ?? t('records.turnUnknown')),
              h('div', { key: 'said-by-dsh', className: 'hp-turn-head' }, [
                h('span', { key: 'who', className: 'hp-turn-who' }, t('records.fromDsh')),
                h('span', { key: 'when', className: 'hp-turn-when' }, answer?.clock ?? ''),
              ]),
              h('div', { key: 'answer', className: answer === null ? 'hp-turn-said hp-hint' : 'hp-turn-said' }, answer === null ? t('records.noAnswer') : answer.text),
              turn.tools.length === 0 ? null : h('div', {
                key: 'tools',
                className: failed ? 'hp-turn-tools hp-err' : 'hp-turn-tools',
              }, `${t('records.toolsUsed', { count: String(turn.tools.length), names: toolSummary(turn.tools) })}${failed ? ` · ${t('records.toolsFailed')}` : ''}`),
            ]);
          })));
          if (transcript.truncated === true) body.push(h('div', { key: 'clipped', className: 'hp-hint' }, t('records.clipped')));
        }
        return h('li', { key: session.id, className: 'hp-check hp-check-stack' }, [
          h(ui.Button, {
            key: 'head',
            variant: 'ghost',
            className: 'hp-session-head',
            onClick: () => props.onToggleSession(session.id),
          }, row),
          h('div', { key: 'body', className: 'hp-turn-body', hidden: !open }, body),
        ]);
      })));
      return h('div', { className: 'hp-workspace' }, children);
    }

    /**
     * The version report and the upgrade job.
     *
     * An upgrade stops Hermes first and does not restart it, so the copy says so
     * before the second press rather than after the damage.
     * @param props - report, job, busy/error flags, the confirm flag and actions.
     */
    function UpdatePanel(props) {
      const { report, job, busy, error, confirm, capability } = props;
      const phase = job === null || job === undefined ? 'idle' : job.phase;
      const running = phase === 'running' || phase === 'stopping';
      // The store keeps an *idle job object* rather than null, so "is there a
      // job" is a phase question, not a null check. Testing for null is how this
      // section ended up rendering a permanent header with a Hide button, an
      // empty body, and nothing to hide.
      const hasJob = phase !== 'idle';
      if (capability === false && !hasJob) {
        // The installation exists but carries no updater of its own. Saying so is
        // the whole point: a button that fails teaches the user nothing.
        return h('div', { className: 'hp-health' }, [
          h('div', { key: 'head', className: 'hp-health-head' }, [
            h('span', { key: 'title', className: 'hp-health-title' }, t('update.title')),
            h('span', { key: 'spacer', className: 'hp-spacer' }),
            h(
              ui.Button,
              { key: 'hide', variant: 'ghost', size: 'sm', onClick: () => props.onDismiss() },
              t('common.hide'),
            ),
          ]),
          h('div', { key: 'unavailable', className: 'hp-hint' }, t('update.unavailable')),
        ]);
      }
      if (report === null && !hasJob && error === null && busy !== true) return null;

      const verdict = updateAvailability(report);
      const statusText =
        phase === 'stopping' ? t('update.stopping')
          : phase === 'running' ? t('update.upgrading')
            : phase === 'done' ? t('update.done')
              : phase === 'error' ? (job?.exitCode === null || job?.exitCode === undefined
                  ? t('update.failedNoCode')
                  : t('update.failed', { code: String(job.exitCode) }))
                : null;

      const head = [h('span', { key: 'title', className: 'hp-health-title' }, t('update.title'))];
      if (statusText !== null) {
        head.push(h('span', { key: 'status', className: 'hp-badge' }, [
          h('span', { key: 'dot', className: 'hp-dot', style: { background: phase === 'done' ? checkColor('OK') : phase === 'error' ? checkColor('FAIL') : checkColor('WARN') } }),
          h('span', { key: 'label' }, statusText),
        ]));
      }
      head.push(h('span', { key: 'spacer', className: 'hp-spacer' }));
      head.push(h(
        ui.Button,
        { key: 'hide', variant: 'ghost', size: 'sm', disabled: running, onClick: () => props.onDismiss() },
        t('common.hide'),
      ));

      const children = [h('div', { key: 'head', className: 'hp-health-head' }, head)];

      if (busy === true && report === null && !hasJob) {
        children.push(h('div', { key: 'busy', className: 'hp-hint' }, t('update.checking')));
      }
      if (error !== null && error !== undefined) {
        children.push(h('div', { key: 'error', className: 'hp-hint hp-err' }, t('update.requestFailed', { error: String(error) })));
      }

      if (verdict.state === 'available' && !running) {
        children.push(h('div', { key: 'verdict', className: 'hp-hint' }, t('update.available', { installed: verdict.installed ?? '?', latest: verdict.latest })));
        children.push(h('div', { key: 'actions', className: 'hp-health-head' }, confirm
          ? [
              h(ui.Button, { key: 'go', variant: 'outline', size: 'sm', disabled: busy, onClick: () => props.onApply() }, t('update.confirm')),
              h(ui.Button, { key: 'cancel', variant: 'ghost', size: 'sm', onClick: () => props.onCancel() }, t('common.cancel')),
            ]
          : [h(ui.Button, { key: 'up', variant: 'outline', size: 'sm', onClick: () => props.onConfirm() }, t('update.upgradeTo', { latest: verdict.latest }))]));
      } else if (verdict.state === 'current') {
        children.push(h('div', { key: 'current', className: 'hp-hint' }, t('update.latest', { latest: verdict.latest })));
      } else if (verdict.state === 'blocked') {
        children.push(h('div', { key: 'blocked', className: 'hp-hint hp-warn' }, t('update.incompatible') ));
      } else if (verdict.state === 'unknown' && report !== null && !running) {
        children.push(h('div', { key: 'unknown', className: 'hp-hint' }, t('update.unparsed')));
      }

      if (report !== null) children.push(h('pre', { key: 'report', className: 'hp-log' }, report));
      if (job !== null && Array.isArray(job.output) && job.output.length > 0) {
        children.push(h('pre', { key: 'output', className: phase === 'error' ? 'hp-log hp-err' : 'hp-log' }, job.output.join('\n')));
      }
      if (job?.error) children.push(h('pre', { key: 'joberror', className: 'hp-log hp-err' }, job.error));
      return h('div', { className: 'hp-health' }, children);
    }

    /** @param status - one doctor check's status. @returns its theme token. */
    function checkColor(status) {
      const value = String(status ?? '').toUpperCase();
      if (value === 'OK') return 'var(--dsw-alias-state-success-primary)';
      if (value === 'WARN') return 'var(--dsw-alias-state-warn-primary)';
      if (value === 'FAIL') return 'var(--dsw-alias-state-error-primary)';
      return 'var(--dsw-alias-state-idle-primary)';
    }

    /**
     * One session row's time, in the browser's own locale.
     *
     * The Host sends epoch milliseconds rather than a formatted string: the
     * panel runs in the user's browser, which knows their zone and locale, and a
     * timestamp formatted on the Host would be the server's.
     * @param value - epoch milliseconds, or anything else.
     * @returns a short local timestamp, or '' when the value is not a time.
     */
    function formatWhen(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '';
      try {
        return new Date(value).toLocaleString();
      } catch {
        return new Date(value).toISOString();
      }
    }

    /**
     * The `doctor.ps1 -Json` report as a list of rows.
     *
     * `doctor` is Hermes' own health check, so this renders what it said rather
     * than this plugin's opinion of it: an unreadable report, a missing
     * installation and a non-zero exit are three different sentences, and each
     * gets its own.
     *
     * Copy is Chinese, like the rest of this panel; the settings page has its
     * own locale dictionary, and the panel moves onto one only when the whole
     * surface is translated.
     * @param props - the report, the fetch error, and whether a run is in flight.
     */
    function HealthReport(props) {
      const { report, error, busy } = props;
      if (busy && report === null) {
        return h('div', { className: 'hp-health' }, h('div', { className: 'hp-hint' }, t('health.busy')));
      }
      if (error !== null && error !== undefined) {
        return h('div', { className: 'hp-health' }, h('div', { className: 'hp-hint hp-err' }, t('health.failed', { error: String(error) })));
      }
      if (report === null || report === undefined) return null;

      const head = [h('span', { key: 'title', className: 'hp-health-title' }, t('health.title'))];
      const summary = report.summary;
      const counts = [
        ['OK', summary?.ok ?? 0, false],
        ['WARN', summary?.warn ?? 0, true],
        ['FAIL', summary?.fail ?? 0, true],
      ];
      if (summary) {
        for (const [label, count, onlyWhenPresent] of counts) {
          if (onlyWhenPresent && count === 0) continue;
          head.push(h('span', { key: label, className: 'hp-badge' }, [
            h('span', { key: 'dot', className: 'hp-dot', style: { background: checkColor(label) } }),
            h('span', { key: 'label' }, `${label} ${count}`),
          ]));
        }
      }
      if (report.host) head.push(h('span', { key: 'host', className: 'hp-meta' }, report.host));
      head.push(h('span', { key: 'spacer', className: 'hp-spacer' }));
      head.push(h(
        ui.Button,
        { key: 'hide', variant: 'ghost', size: 'sm', onClick: () => props.onDismiss() },
        t('common.hide'),
      ));

      const children = [h('div', { key: 'head', className: 'hp-health-head' }, head)];
      if (report.available === false) {
        children.push(h('div', { key: 'unavailable', className: 'hp-hint' }, report.reason ?? t('error.noHermes')));
      } else if (Array.isArray(report.checks)) {
        children.push(h('ul', { key: 'checks', className: 'hp-checks' }, report.checks.map((entry, index) => h(
          'li',
          { key: `${entry.check}-${index}`, className: 'hp-check' },
          [
            h('span', { key: 'dot', className: 'hp-dot', style: { background: checkColor(entry.status) } }),
            h('span', { key: 'name', className: 'hp-check-name' }, String(entry.check)),
            h('span', { key: 'detail', className: 'hp-check-detail' }, String(entry.detail)),
          ],
        ))));
      }
      if (report.error) children.push(h('pre', { key: 'error', className: 'hp-log hp-err' }, report.error));
      if (report.raw) children.push(h('pre', { key: 'raw', className: 'hp-log' }, report.raw));
      return h('div', { className: 'hp-health' }, children);
    }

    /**
     * @param status - lifecycle status.
     * @returns the theme token backing the status dot.
     */
    function dotColor(status) {
      if (status === 'running') return 'var(--dsw-alias-state-success-primary)';
      if (status === 'starting') return 'var(--dsw-alias-state-warn-primary)';
      if (status === 'error' || status === 'unreachable') return 'var(--dsw-alias-state-error-primary)';
      if (status === 'not-installed') return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-state-idle-primary)';
    }

    /** @param status - lifecycle status. @returns its Chinese label. */
    function statusLabel(status) {
      if (status === 'running') return t('state.running');
      if (status === 'starting') return t('state.starting');
      if (status === 'error') return t('state.problem');
      if (status === 'stopped') return t('state.stopped');
      if (status === 'not-installed') return t('state.missing');
      if (status === 'unreachable') return t('state.notLoaded');
      return t('common.unknown');
    }

    /**
     * Attach the dashboard frame to the slot this component renders, and keep it
     * alive while it is away.
     *
     * There is one surface now — the right column's tab — but it shows the frame in
     * one face and hides it in another, so the frame still has to survive being
     * taken off screen: the page never reloads, and neither does the answer it was
     * writing.
     *
     * @returns the slot to render and whether the dashboard is up.
     */
    function useDashboardFrame() {
      const state = useStatus();
      // Stable per call site, so a surface only ever hides a frame it still owns.
      const owner = React.useRef(`frame-${Math.random().toString(36).slice(2)}`);
      const slot = React.useRef(null);
      const runningNow = state.discovery?.found === true && state.dashboard?.status === 'running';
      const frameUrl = state.url ?? null;
      const nonce = state.frameNonce ?? 0;
      /**
       * Put the frame over whatever `slot.current` is RIGHT NOW.
       *
       * Reading the ref here rather than closing over the element is the whole
       * fix: the dashboard and the record swap this slot in and out, and a
       * captured node goes detached — its rect reads zero for ever, which hides
       * the frame and then never un-hides it.
       */
      const placeRef = React.useRef(() => {});
      React.useEffect(() => {
        if (frameUrl === null || runningNow !== true) return undefined;
        const host = ensureFrameHost(frameUrl, nonce);
        if (host === null) return undefined;
        let hidZero = false;
        let observer = null;
        let observed = null;
        // The host floats over the slot this component reserved for it. Measured
        // rather than inherited because the two are not in the same tree — that is
        // the whole point: the frame must not be a child of a component DSH
        // unmounts on every panel switch.
        const place = () => {
          const target = slot.current;
          if (target === null || target === undefined) {
            host.style.display = 'none';
            return;
          }
          // Follow the element: the slot div is replaced when the record takes
          // over, and an observer still watching the old one would go quiet.
          if (observer !== null && target !== observed) {
            if (observed !== null) observer.unobserve(observed);
            observer.observe(target);
            observed = target;
          }
          const box = typeof target.getBoundingClientRect === 'function'
            ? target.getBoundingClientRect()
            : { top: 0, left: 0, width: 0, height: 0 };
          if (box.width <= 0 || box.height <= 0) {
            host.style.display = 'none';
            // Said once per transition, not per tick: a frame that is in the
            // document, still loading, and hidden is invisible in a way no
            // screenshot can explain. This line says which measurement did it.
            if (!hidZero) {
              hidZero = true;
              console.warn('[hermes-panel] frame hidden: the tab slot measured 0 —', JSON.stringify({ w: Math.round(box.width), h: Math.round(box.height), display: String((target.ownerDocument?.defaultView?.getComputedStyle?.(target) ?? {}).display ?? '?') }));
            }
            return;
          }
          hidZero = false;
          frameOwner = owner.current;
          host.style.display = 'block';
          host.style.top = `${box.top}px`;
          host.style.left = `${box.left}px`;
          host.style.width = `${box.width}px`;
          host.style.height = `${box.height}px`;
        };
        placeRef.current = place;
        place();
        if (typeof ResizeObserver === 'function') observer = new ResizeObserver(place);
        if (typeof window !== 'undefined') window.addEventListener('resize', place);
        const timer = setInterval(place, 500);
        return () => {
          if (observer !== null) observer.disconnect();
          if (typeof window !== 'undefined') window.removeEventListener('resize', place);
          clearInterval(timer);
          // Hidden, NOT detached: the element stays in the document, so the page
          // keeps running and any answer still being written survives.
          //
          // But only if this surface still owns it. Two of them can be mounted at
          // once while DSH swaps panels, and the one that unmounts last would
          // otherwise blank the one that is still on screen.
          if (frameOwner === owner.current) {
            host.style.display = 'none';
            frameOwner = null;
          }
        };
      }, [frameUrl, runningNow, nonce]);
      // After every render, not just when the effect re-runs: the swap between the
      // dashboard and the record replaces the slot, and waiting for the 500ms tick
      // would show a blank column for half a second each way.
      React.useEffect(() => {
        placeRef.current();
      });

      return { runningNow, frameUrl, slot };
    }

    /**
     * The one live dashboard frame, kept in the document for good.
     *
     * DSH renders only the ACTIVE `main` panel, so switching to a DSH
     * conversation unmounts this component. An iframe that unmounts is
     * destroyed, and so is one that is merely moved out of the document —
     * Chromium discards a removed element's browsing context, so re-inserting
     * it later reloads it just the same. That is why the frame gets a
     * fixed-position host on `document.body`, is sized to the slot the panel
     * renders, and is only ever HIDDEN when the panel goes away.
     */
    let frameHost = null;
    let frameElement = null;
    let frameKey = null;
    /**
     * Which surface last put the frame where it is.
     *
     * Two components can show this frame — the main panel and the right column
     * — and they are meant to be mutually exclusive, but DSH can have both
     * mounted while it swaps panels. Without this, the one that unmounts LAST
     * hides the host and leaves the other showing an empty rectangle.
     */
    let frameOwner = null;

    /**
     * The dashboard frame and the host that keeps it in the document.
     * @param src - the dashboard URL.
     * @param nonce - bumped by "reload the page", the one thing that is meant
     *   to discard the frame.
     * @returns the host element, or null where there is no document to build one in.
     */
    function ensureFrameHost(src, nonce) {
      if (typeof document === 'undefined' || document.body === undefined || document.body === null) return null;
      if (frameHost === null) {
        frameHost = document.createElement('div');
        frameHost.setAttribute('data-hermes-panel-frame', '');
        frameHost.style.position = 'fixed';
        frameHost.style.display = 'none';
        // Above DSH's dock layer (10) and float layer (60) — otherwise the right
        // column paints over the frame and the tab looks empty, which is exactly
        // what it looked like. Still far below anything modal.
        frameHost.style.zIndex = '200';
        document.body.appendChild(frameHost);
      }
      const key = `${src}#${nonce}`;
      if (frameElement !== null && frameKey === key) return frameHost;
      if (frameElement !== null) {
        frameElement.remove();
        frameElement = null;
      }
      const frame = document.createElement('iframe');
      frame.className = 'hp-frame';
      frame.setAttribute('title', 'Hermes Dashboard');
      frame.setAttribute('allow', 'clipboard-read; clipboard-write');
      frame.src = src;
      frameHost.appendChild(frame);
      frameElement = frame;
      frameKey = key;
      return frameHost;
    }

    /**
     * The exchange record as a tab in DSH's right sidebar.
     *
     * The right sidebar's tabs are *providers*, not plain slot registrations: the
     * column asks `sidebarRightTabs` which kinds exist and renders each one's
     * `guide` entry as a row in its start panel — which is what puts this beside
     * 工作区文件 and 新建终端. The two slot registrations give it a body and a
     * title.
     *
     * The reason it belongs there rather than only in the panel: the panel
     * replaces the DSH view while it is open, so watching what Hermes and DSH are
     * saying to each other meant leaving the conversation you were watching it
     * from. This column stays put while you switch between the two.
     *
     * Every part is soft, and every part *waits*: `ctx.inject` runs its callback
     * when the service exists, and never if the composition has no right column.
     *
     * Reading the table once at activation with `ctx.get` is what made this fail
     * in production while passing every test — the right column composes after
     * this plugin does, so the lookup saw a table that was still being built, and
     * the whole block returned early. Neither the guide row nor the panel's
     * button ever appeared.
     */
    function mountRecordsTab(ctx) {
      // A context without `inject` is a test double, not a deployment: the real
      // one always has it. Saying so beats throwing and being caught upstream.
      if (typeof ctx.inject !== 'function') return;
      ctx.inject(['sidebarRightTabs'], (scope) => {
        // The dashboard, beside the conversation rather than in place of it.
        // This is the shape the panel could not be, and on purpose: the right
        // column belongs to a Conversation, so it exists exactly where the reader
        // already is.
        scope.effect(() => scope.sidebarRightTabs.register({
          id: DASHBOARD_KIND,
          kind: DASHBOARD_KIND,
          multiple: false,
          title: () => t('dashboard.tabTitle'),
          guide: [{
            id: 'open',
            order: 10,
            title: () => t('dashboard.guideTitle'),
            description: () => t('dashboard.guideHint'),
            // Without this the row draws DSH's generic cube, which says nothing.
            icon: HermesArtwork,
          }],
        }), 'hermes-panel: right-sidebar dashboard tab');

        scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
          name: 'sidebar.right.pane.tab',
          key: DASHBOARD_KIND,
        }, DashboardTab)), 'hermes-panel: right-sidebar dashboard body');

        scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: DASHBOARD_KIND,
        }, DashboardTabTitle)), 'hermes-panel: right-sidebar dashboard title');

      });

    }

    /**
     * The right column's dashboard: the whole Hermes interface, beside the
     * conversation instead of in place of it.
     *
     * This is the shape the panel could not be. The right column belongs to a
     * Conversation, so it exists exactly where the reader already is; the panel
     * replaces that view, which is why nothing in the panel can reach the column.
     *
     * A narrow strip of controls sits above the frame, because a column is not a
     * full window: enough to see what is happening and to start, stop or reload it
     * without leaving the conversation.
     */
    function DashboardTab() {
      const state = useStatus();
      const { runningNow, slot } = useDashboardFrame();
      // The face this tab is showing. The store owns it so it survives the tab being
      // closed and reopened, and so a test can drive it the way the strip does.
      const view = state.view ?? 'hermes';
      const records = view === 'records';
      const workspacePath = state.workspace?.path ?? null;
      React.useEffect(() => {
        if (!records) return undefined;
        store.watchRecords(true);
        void store.loadRecords().then(() => store.openNewestRecord());
        return () => store.watchRecords(false);
      }, [records, workspacePath]);
      const dashboard = state.dashboard ?? { status: 'unknown' };
      const gateway = state.gateway ?? { status: 'unknown' };
      const discovery = state.discovery ?? {};
      const installed = discovery.found === true;
      const status = installed ? dashboard.status : 'not-installed';
      const busy = state.busy === true;

      /** One small control; the column has no room for words. */
      const act = (key, label, iconName, onClick, options = {}) => h(ui.Button, {
        key,
        variant: options.primary === true ? 'primary' : 'ghost',
        size: 'sm',
        icon: icon(iconName),
        disabled: busy,
        title: label,
        'aria-label': label,
        onClick,
      });

      // The status is the dot; its word is the tooltip. Every control here is a
      // glyph with its words on hover — a column has no room for labels, and a
      // row that wraps onto a second line is worse than a row of icons.
      //
      // Left to right: what it is (the dot), which face it is showing (the view
      // switcher), what it can do (the lifecycle), and where else it can open.
      //
      // Two dots in this column, and they used to be the SAME dot. The chip's is the
      // dashboard's state and it earns its place — the chip is visible when this tab
      // is not the active one, which is exactly when nobody can see the dashboard
      // itself. This one carried the same value, so the column showed one fact twice
      // and never showed the other half of what the plugin manages: the messaging
      // gateway.
      //
      // So the toolbar dot is the gateway — and it says so in words, not only on
      // hover. A dot whose meaning is behind a tooltip is a dot nobody reads: the
      // question 「这个绿点代表什么」 is the evidence, and the answer should be on
      // screen. Two words cost 40px of a column that has room.
      const head = [
        h('span', {
          key: 'dot',
          className: 'hp-dash-head',
          title: t('badge.gateway', { status: statusLabel(gateway.status) }),
        }, [
          h(ui.StateDot, { key: 'd', state: installed ? dotState(gateway.status) : 'missing' }),
          h('span', { key: 'label', className: 'hp-dash-head-label' },
            t('badge.gateway', { status: statusLabel(gateway.status) })),
        ]),
        h('span', { key: 'spacer', className: 'hp-spacer' }),
      ];
      // The view switcher. `primary` marks the one you are looking at, which is the
      // only thing that makes three same-size glyphs readable as a switcher.
      for (const face of [
        ['hermes', t('dashboard.tabTitle'), 'globe'],
        ['records', t('records.guideTitle'), 'records'],
        ['setup', t('setup.title'), 'settings'],
      ]) {
        head.push(act(`view-${face[0]}`, face[1], face[2],
          () => store.setView(face[0]), { primary: view === face[0] }));
      }
      if (installed && runningNow) {
        head.push(act('stop', t('lifecycle.stop'), 'stop', () => void store.command('stop')));
        head.push(act('restart', t('lifecycle.restart'), 'restart', () => void store.command('restart')));
      } else if (installed) {
        head.push(act('start', busy ? t('lifecycle.starting') : t('lifecycle.start'), 'start', () => void store.command('start'), { primary: true }));
      }
      if (runningNow && typeof state.url === 'string') {
        head.push(h('a', {
          key: 'open',
          className: 'hp-icon-btn',
          href: state.url,
          target: '_blank',
          rel: 'noreferrer',
          title: t('frame.openTab'),
          'aria-label': t('frame.openTab'),
        }, icon('openTab')));
      }

      const frameBody = runningNow
        ? [h('div', { key: 'frame-slot', className: 'hp-frame-slot', ref: slot })]
        : [h('div', { key: 'empty', className: 'hp-empty' }, h('div', { className: 'hp-empty-box' }, installed
            ? [h('div', { key: 'title' }, t('frame.stopped'))]
            : [
              h('div', { key: 'title', className: 'hp-empty-title' }, t('empty.notFoundTitle')),
              // Where it looked, and why that did not qualify. The Host already
              // writes this down; the panel used to discard it.
              ...(Array.isArray(discovery.attempts) ? discovery.attempts.slice(0, 3).map((line, index) => (
                h('div', { key: `why-${index}`, className: 'hp-empty-why' }, String(line))
              )) : []),
              h('div', { key: 'how', className: 'hp-empty-how' }, t('empty.notFoundHow')),
            ]))];

      // Three faces, one strip. 「设置」 is the left sidebar panel's content, kept
      // whole: nothing was dropped when that panel went, only moved.
      const face = view === 'records'
        ? h('div', { key: 'records', className: 'hp-records-tab' }, h(WorkspaceRecords, {
            bare: true,
            open: true,
            busy: state.recordsBusy === true,
            error: state.recordsError,
            records: state.records,
            transcripts: state.transcripts,
            sessionOpen: state.sessionOpen,
            sessionBusy: state.sessionBusy,
            sessionError: state.sessionError,
            onToggleSession: (sessionId) => void store.toggleSession(sessionId),
          }))
        : view === 'setup'
          ? h('div', { key: 'setup', className: 'hp-setup-tab' }, h(HermesPanel, { only: 'sections' }))
          : frameBody;

      return h('div', { className: 'hp-dashboard-tab' }, [
        h('div', { key: 'head', className: 'hp-dash-bar' }, head),
        face,
      ]);
    }

    /** The dashboard tab's title: a dot and the name, like the panel's chip. */
    function DashboardTabTitle() {
      const state = useStatus();
      const installed = state.discovery?.found === true;
      const status = installed ? (state.dashboard ?? {}).status : 'not-installed';
      return h('span', { className: 'hp-dash-tab-title' }, [
        h(ui.StateDot, { key: 'd', state: installed ? dotState(status) : 'missing' }),
        h('span', { key: 't' }, t('dashboard.tabTitle')),
      ]);
    }




    /**
     * The full-width panel: control strip over the embedded dashboard.
     */
    function HermesPanel(props) {
      const state = useStatus();
      // The frame, its slot and the reload counter are shared with the right
      // column's tab — see `useDashboardFrame`.
      const { runningNow, slot: frameSlot } = useDashboardFrame();
      const dashboard = state.dashboard ?? { status: 'unknown' };
      const gateway = state.gateway ?? { status: 'unknown' };
      const discovery = state.discovery ?? {};
      /** Discovery, not the last command, decides whether Hermes is usable. */
      const installed = discovery.found === true;
      const dashboardStatus = installed ? dashboard.status : 'not-installed';
      const running = installed && dashboard.status === 'running';
      const busy = state.busy === true || dashboard.status === 'starting';
      /** An upgrade is in flight; its output lives in the update panel. */
      const updatePhase = state.update?.phase ?? 'idle';
      const updateRunning = updatePhase === 'running' || updatePhase === 'stopping';
      /** Either half of 「检查」 still running. */
      const checkBusy = state.healthBusy === true || state.updateBusy === true;
      /**
       * The gateway badge is driven by the CLI's own sentence rather than by a
       * yes/no, and `unknown` is split further: "无法识别" is a report this
       * plugin cannot read (a changed CLI), while "未知" is a probe that failed.
       * They need different next steps, so they get different words.
       */
      const gatewayKnown = gateway.status === 'running' || gateway.status === 'stopped';
      const gatewayLabel = gateway.status === 'unknown'
        ? (gateway.detail === 'unparsed' ? t('state.unparsed') : t('common.unknown'))
        : statusLabel(gateway.status);
      // A stop/restart can take a while — the host asks the CLI to drain the
      // gateway before it force-kills anything. Saying WHICH command is running
      // is what keeps a disabled button from reading as "nothing happened".
      const busyAction = state.busy === true ? state.busyAction : null;

      /**
       * One control on the strip, on the app's own button.
       * @param key - react key.
       * @param label - visible text.
       * @param options - variant, icon, disabled, title, onClick.
       */
      const control = (key, label, options = {}) => h(ui.Button, {
        key,
        variant: options.primary === true ? 'primary' : (options.plain === true ? 'ghost' : 'toolbar'),
        size: 'sm',
        icon: icon(options.icon),
        disabled: options.disabled === true,
        // An icon-only control carries its word in the tooltip and the
        // accessible name rather than on the button.
        title: options.title ?? (options.iconOnly === true ? label : undefined),
        'aria-label': options.iconOnly === true ? label : undefined,
        onClick: options.onClick,
      }, options.iconOnly === true ? null : label);

      /**
       * One status chip: the app's dot inside the app's tag, so the colours come
       * from the theme instead of from this file.
       */
      const chip = (key, state, label) => h(ui.Tag, { key }, [
        h(ui.StateDot, { key: 'dot', state }),
        h('span', { key: 'label' }, label),
      ]);

      // A stalled ticker or failing ticks still mean the gateway is up, so the
      // warning rides the label and only tints the dot.
      const gatewayDot = gatewayKnown && gateway.warning !== true ? dotState(gateway.status) : 'warning';

      const children = [
        h('div', { className: 'hp-bar', key: 'bar' }, [
          h('span', { className: 'hp-title', key: 'title' }, 'Hermes'),
          chip('db', dotState(dashboardStatus), t('badge.dashboard', { status: statusLabel(dashboardStatus) })),
          installed ? chip('gw', gatewayDot, t('badge.gateway', { status: gatewayLabel })) : null,
          h('span', { className: 'hp-spacer', key: 'spacer' }),

          // Lifecycle first, and only one of these is ever filled: there is one
          // obvious thing to press. Icon-only throughout — each one carries its
          // words in the tooltip and the accessible name, which is what keeps the
          // whole row on a single line.
          running
            ? control('stop', busyAction === 'stop' ? t('lifecycle.stopping') : t('lifecycle.stop'), { icon: 'stop', iconOnly: true, disabled: busy, onClick: () => void store.command('stop') })
            : installed
              ? control('start', busy ? t('lifecycle.starting') : t('lifecycle.start'), { icon: 'start', iconOnly: true, primary: true, disabled: busy, onClick: () => void store.command('start') })
              : null,
          running
            ? control('restart', busyAction === 'restart' ? t('lifecycle.restarting') : t('lifecycle.restart'), { icon: 'restart', iconOnly: true, disabled: busy, onClick: () => void store.command('restart') })
            : null,

          installed ? h('span', { className: 'hp-sep', key: 'sep-1' }) : null,

          installed
            ? control('check', checkBusy ? t('check.busy') : t('check.title'), { icon: 'health', iconOnly: true, disabled: busy || checkBusy || updateRunning, onClick: () => void store.checkAll() })
            : null,
          installed
            ? control('bridge', t('bridge.title'), { icon: 'bridge', iconOnly: true, onClick: () => store.toggleBridge() })
            : null,
          // View controls, quieter and always last. The reload keeps its word —
          // it is the one a reader looks for by name — while a second tab is
          // self-evident from the arrow DSH uses for the same thing.
          h('span', { className: 'hp-sep', key: 'sep-2' }),

          running
            ? h('a', {
                key: 'open',
                className: 'hp-icon-btn',
                href: state.url,
                target: '_blank',
                rel: 'noreferrer',
                title: t('frame.openTab'),
                'aria-label': t('frame.openTab'),
              }, icon('openTab'))
            : null,
        ]),
      ];

      // The sections that are not the dashboard. Collected first and used twice:
      // once above the frame in the panel, and on their own in the right column's
      // 「设置」 view — which is now the only place they live.
      const sections = [];
      const sectionsOnly = props?.only === 'sections';

      // The report sits above the frame so it stays readable whether or not the
      // dashboard is up — a FAIL is exactly when the frame is missing.
      sections.push(h(HealthReport, {
        key: 'health',
        report: state.health,
        error: state.healthError,
        busy: state.healthBusy === true,
        onDismiss: () => store.dismissHealth(),
      }));

      sections.push(h(UpdatePanel, {
        key: 'update',
        // `undefined` means the first status poll has not landed yet; treat that
        // as capable rather than flashing an explanation at every page load.
        capability: state.capabilities?.update === false ? false : undefined,
        report: state.updateReport,
        job: state.update,
        busy: state.updateBusy === true,
        error: state.updateError,
        confirm: state.updateConfirm === true,
        onConfirm: () => store.confirmUpdate(),
        onCancel: () => store.cancelUpdate(),
        onApply: () => void store.applyUpdate(),
        onDismiss: () => store.dismissUpdate(),
      }));

      // In the dedicated view there is no disclosure to open: the section IS the view.
      if (state.bridgeOpen === true || sectionsOnly) {
        sections.push(h(BridgePanel, {
          key: 'bridge',
          // No disclosure to offer in the dedicated view.
          fixed: sectionsOnly,
          status: state.bridge,
          busy: state.bridgeBusy === true,
          error: state.bridgeError,
          confirm: state.bridgeConfirm === true,
          result: state.bridgeResult,
          onToggle: () => store.toggleBridge(),
          onConfirm: () => store.confirmBridge(),
          onCancel: () => store.cancelBridge(),
          onApply: () => void store.applyBridge(),
        }));
      }

      sections.push(h(DirectoriesSection, {
        key: 'directories',
        discovery: state.discovery,
        busy: state.workspaceBusy === true,
        picking: state.workspacePicking === true,
        onPickRuntime: () => void store.pickDirectoryFor('runtimeDir'),
        onPickData: () => void store.pickDirectoryFor('dataDir'),
      }));

      // Nothing to install from here any more: the user installs Hermes and points the
      // panel at it. What a machine with no Hermes still needs is a way to re-run
      // discovery — it is the only thing that re-reads the directories, since the poll
      // serves a cached result.
      if (!installed) {
        sections.push(h('div', { key: 'redetect', className: 'hp-health-head' }, h(ui.Button, {
          key: 'go',
          variant: 'outline',
          size: 'sm',
          disabled: state.busy === true,
          onClick: () => void store.refresh(true),
        }, t('common.redetect'))));
      }

      // Its own section, NOT a child of the bridge disclosure.
      //
      // It used to render only inside `if (state.bridgeOpen === true)`, and that flag
      // starts false — so the one thing that answers "which directory do the two
      // sides share" was invisible until you pressed a button named after something
      // else. They share a directory; that is not a reason to share a disclosure.
      if (installed || sectionsOnly) {
        sections.push(h(WorkspaceSection, {
          key: 'workspace',
          status: state.workspace,
          busy: state.workspaceBusy === true,
          picking: state.workspacePicking === true,
          error: state.workspaceError,
          confirm: state.workspaceConfirm === true,
          result: state.workspaceResult,
          onConfirm: () => store.confirmWorkspace(),
          onCancel: () => store.cancelWorkspace(),
          onApply: () => void store.applyWorkspace(),
          onPick: () => void store.pickWorkspace(),
        }));
      }

      // The right column's 「设置」 view: the same sections, on their own. This is
      // where they live now that the left sidebar's panel is gone.
      if (sectionsOnly) return h('div', { className: 'hp-sections' }, sections);

      children.push(...sections);

      if (running && state.url) {
        // A placeholder: the frame itself is attached to it — and taken back
        // out on unmount — by the effect below, so that switching away from
        // this panel reloads nothing.
        children.push(h('div', { key: 'frame-slot', className: 'hp-frame-slot', ref: frameSlot }));
      } else if (!installed) {
        const attempts = Array.isArray(discovery.attempts) ? discovery.attempts : [];
        // The same sentence the tab's empty state uses: what is true, why, and what to
        // do. 「没有找到可用的 Hermes 安装」 is a fact, not an instruction.
        children.push(h('div', { className: 'hp-empty', key: 'empty' }, h('div', { className: 'hp-empty-box' }, [
          h('div', { key: 'title', className: 'hp-empty-title' }, t('empty.notFoundTitle')),
          h('div', { key: 'how', className: 'hp-empty-how' }, t('empty.notFoundHow')),
          // Re-detection lives here rather than in the toolbar: it is the only
          // thing that re-runs discovery (the poll reads a cached result), and
          // the only place it is worth pressing is right after discovery failed.
          h('div', { key: 'redetect', className: 'hp-health-head' }, h(ui.Button, {
            key: 'go',
            variant: 'outline',
            size: 'sm',
            disabled: busy,
            onClick: () => void store.command('refresh'),
          }, busyAction === 'refresh' ? t('common.detecting') : t('common.redetect'))),
          attempts.length > 0
            ? h('pre', { key: 'attempts', className: 'hp-log hp-hint' }, attempts.join('\n'))
            : null,
        ])));
      } else {
        const message =
          dashboard.status === 'starting'
            ? t('frame.starting')
            : dashboard.status === 'error'
              ? t('frame.failed')
              : t('frame.stopped');
        children.push(h('div', { className: 'hp-empty', key: 'empty' }, h('div', null, message)));
      }

      if (gateway.warning) {
        children.push(h('pre', { className: 'hp-log hp-warn', key: 'warn' }, gateway.warning));
      }
      if (gateway.detail === 'unparsed' && typeof gateway.raw === 'string') {
        children.push(h('pre', { className: 'hp-log hp-warn', key: 'gwraw' }, `${t('gateway.raw')}\n${gateway.raw}`));
      }
      const problem = dashboard.error ?? gateway.error;
      if (problem) {
        children.push(h('pre', { className: 'hp-log hp-err', key: 'error' }, problem));
      } else if (!running && Array.isArray(state.log) && state.log.length > 0) {
        children.push(h('pre', { className: 'hp-log', key: 'log' }, state.log.slice(-10).join('\n')));
      }

      return h('div', { className: 'hp-root' }, children);
    }

    //#region settings page

    /**
     * The profile entry id this bundle patch declares (`cordis.patch.yml`), which
     * is also the settings namespace the Host serves. A settings namespace is keyed
     * by the loader entry id, not by anything the UI uses.
     */
    const SETTINGS_NAMESPACE = 'hermes-panel';

    /** Locale namespace this plugin owns for its settings page copy. */
    const SETTINGS_LOCALE_NS = 'hermes-panel.settings';

    /** Settings-page copy, in the two languages this plugin ships. */
    //#region settings-dictionaries
    const SETTINGS_COPY = {
      zh: {
        // Deliberately not just the plugin title. The Plugins panel lists this
        // page under 官方 and the installed bundle of the same name under
        // 已安装; two identically named cards, only one of which carries the
        // form, is how a user opens the wrong one.
        title: 'Hermes 面板设置',
        summary: '把 Hermes 的运行时和数据目录交给它，启停网关与仪表盘。',
        save: '保存',
        saving: '保存中…',
        saveFailed: '本部署没有接受这些值，已保留供你修改。',
        readOnly: '本部署的设置为只读。',
        unavailable: '该插件当前未加载，暂时无法配置。',
        overridden: '已覆盖',
        reset: '恢复默认',
        invalid: '请填有效值；留空表示恢复默认。',
        'field.runtimeDir': '运行时（Python 环境）',
        'hint.runtimeDir': 'conda 环境或 venv 目录。留空 = 插件自己装',
        'field.dataDir': '数据目录',
        'hint.dataDir': '会话、配置、密钥。留空 = 插件新建一个空的',
        'field.dashboardPort': '仪表盘端口',
        'hint.dashboardPort': '0 = 用 .env 里的 DASHBOARD_PORT，取不到时用 9150',
        'field.sharedWorkspace': '共享工作区',
        'hint.sharedWorkspace': '两边都在这里干活，里面的 AGENTS.md 双方都读。留空 = 不共享',
        'field.manageGateway': '随面板启停网关',
        'hint.manageGateway': '默认 true',
        'field.autostart': 'DSH 启动时自动拉起',
        'hint.autostart': '默认 false',
      },
      en: {
        title: 'Hermes Panel settings',
        summary: 'Point it at a Hermes runtime and data directory; it manages the gateway and dashboard.',
        save: 'Save',
        saving: 'Saving…',
        saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
        readOnly: 'This deployment stores settings read-only.',
        unavailable: 'This plugin is not loaded, so it cannot be configured yet.',
        overridden: 'Overridden',
        reset: 'Reset',
        invalid: 'Enter a valid value, or leave blank to reset.',
        'title': 'Hermes panel',
        'field.runtimeDir': 'Runtime (Python environment)',
        'hint.runtimeDir': 'Your conda env or venv. Blank = the plugin installs one',
        'field.dataDir': 'Data directory',
        'hint.dataDir': 'Sessions, config, keys. Blank = a fresh empty one',
        'field.dashboardPort': 'Dashboard port',
        'hint.dashboardPort': '0 = DASHBOARD_PORT from .env, and 9150 when that is unreadable',
        'field.sharedWorkspace': 'Shared workspace (both sides work here)',
        'hint.sharedWorkspace': 'A directory both agents open in; the AGENTS.md inside it is read by both. Blank = no sharing',
        'field.manageGateway': 'Manage the gateway too',
        'hint.manageGateway': 'true / false; blank = the default, true',
        'field.autostart': 'Start with DSH',
        'hint.autostart': 'true / false; blank = the default, false',
      },
    };
    //#endregion settings-dictionaries

    /**
     * A boolean field, staged as text.
     *
     * The shared field controls are text inputs, and a boolean has no
     * `settingsTextField` helper, so this pairs the value with the drafts it
     * accepts. A draft it accepts is the only thing that can be saved; anything
     * else blocks the save rather than being silently coerced.
     * @param field - field name inside the namespace.
     * @returns the field's conversion spec.
     */
    function settingsBooleanField(field) {
      return {
        field,
        format: (value) => (typeof value === 'boolean' ? String(value) : ''),
        parse: (text) => {
          const draft = text.trim().toLowerCase();
          if (draft === '') return { kind: 'clear' };
          if (draft === 'true' || draft === '1' || draft === 'yes') return { kind: 'set', value: true };
          if (draft === 'false' || draft === '0' || draft === 'no') return { kind: 'set', value: false };
          return undefined;
        },
      };
    }

    /**
     * Mount this plugin's page on the Plugins panel.
     *
     * A Host module that exports a `.volatile()` Config schema gets its settings
     * namespace SERVED — `settings.describe()` returns a form for it and the Host
     * validates writes — but DSH renders no form of its own. Every settings page
     * is contributed by the owning plugin's client half through the
     * `plugins.item` slot, which is also what puts the card on the panel; the
     * manager hands the page `{ view: 'summary' }` for the card line and
     * `{ view: 'page' }` for the detail body. Without this registration the
     * schema is live and has no face.
     * @param ctx - client plugin context.
     * @param primitives - the shared settings-form primitives.
     * @param configForms - the settings service exposing per-namespace forms.
     * @param locale - the client locale service.
     */
    function mountSettingsPage(ctx, primitives, configForms, locale) {
      const t = locale.bind(SETTINGS_LOCALE_NS);
      ctx.effect(() => locale.register(SETTINGS_LOCALE_NS, SETTINGS_COPY), 'hermes-panel: settings dictionaries');

      /**
       * The fields this page edits, in display order.
       *
       * Seven, and the first two are the whole point: the runtime and the volume,
       * kept apart. One `hermesHome` used to carry both, and the plugin guessed the
       * pair by walking up from its own directory — which is always one directory
       * short for an installed plugin, and which failed three different ways before
       * anyone could see its cause.
       *
       * `runtimeDir` is Hermes' `VENV`; `dataDir` is `HERMES_HOME`. Both blank means
       * a location under the DSH home, derived from the user's, never written here:
       * this file ships to other machines.
       *
       * The rest: `dashboardPort`
       * is what the panel connects to, `sharedWorkspace` is the directory both agents
       * work in, and `manageGateway` / `autostart` are preferences.
       */
      const fields = [
        { field: 'runtimeDir', spec: primitives.settingsTextField('runtimeDir') },
        { field: 'dataDir', spec: primitives.settingsTextField('dataDir') },
        { field: 'dashboardPort', spec: primitives.settingsNumberField('dashboardPort'), numeric: true },
        { field: 'sharedWorkspace', spec: primitives.settingsTextField('sharedWorkspace') },
        { field: 'manageGateway', spec: settingsBooleanField('manageGateway') },
        { field: 'autostart', spec: settingsBooleanField('autostart') },
      ];

      const form = new primitives.SettingsFormModel(
        configForms.get(SETTINGS_NAMESPACE),
        fields.map((entry) => entry.spec),
      );
      const store = form.bind(() => {
        const projection = { ...form.shell() };
        for (const entry of fields) projection[entry.field] = form.field(entry.field);
        return projection;
      });
      const actions = form.actions();
      settingsActions = actions;
      ctx.effect(() => () => {
        if (settingsActions === actions) settingsActions = null;
      }, 'hermes-panel: settings actions');

      /**
       * One settings page: the shared form frame over this plugin's fields.
       * @param props - slot-provided `t`/`view` plus the injected form face.
       */
      function HermesSettingsCard(props) {
        const read = typeof props.useHermesForm === 'function' ? props.useHermesForm : () => store.getSnapshot();
        const state = read((snapshot) => snapshot);
        const copy = typeof props.t === 'function' ? props.t : t;
        if (props.view === 'summary') return copy('summary');
        const disabled = !state.writable;
        const edit = typeof props.edit === 'function' ? props.edit : actions.edit;
        const resetField = typeof props.resetField === 'function' ? props.resetField : actions.resetField;
        return h(
          primitives.SettingsForm,
          {
            labels: {
              unavailable: copy('unavailable'),
              readOnly: copy('readOnly'),
              saveFailed: copy('saveFailed'),
              save: copy('save'),
              saving: copy('saving'),
            },
            state,
            onSave: typeof props.save === 'function' ? props.save : actions.save,
            onDiscard: typeof props.discard === 'function' ? props.discard : actions.discard,
          },
          fields.map((entry) => h(primitives.SettingsValueField, {
            key: entry.field,
            id: `${SETTINGS_LOCALE_NS}-${entry.field}`,
            label: copy(`field.${entry.field}`),
            hint: copy(`hint.${entry.field}`),
            overriddenLabel: copy('overridden'),
            resetLabel: copy('reset'),
            invalidLabel: copy('invalid'),
            numeric: entry.numeric === true,
            disabled,
            ...(state[entry.field] ?? {}),
            onEdit: (text) => edit(entry.field, text),
            onReset: () => resetField(entry.field),
          })),
        );
      }

      // The Plugins page declares three contribution slots, and a plugin that
      // only fills the first still looks unconfigured where the user actually
      // lands:
      //
      //   plugins.item           a card beside the official bundles
      //   plugins.bundle.config  the form on THIS bundle's own detail page
      //   plugins.row.config     a form on one of the bundle's rows
      //
      // Clicking the installed bundle opens its page, and that page renders
      // `plugins.bundle.config` under `data-plugin-config` — keyed by the bundle
      // package name, and only when something registered under it. Filling only
      // `plugins.item` therefore leaves the page a user reaches looking empty.
      ctx.effect(
        () => configForms.whileServed([SETTINGS_NAMESPACE], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: BUNDLE_PACKAGE_NAME,
          locale: SETTINGS_LOCALE_NS,
          inject: () => ({ hooks: { hermesForm: store }, ...actions }),
        }, HermesSettingsCard))),
        'hermes-panel: settings on the bundle page',
      );

      // The same form as a card in the 官方 group, for reaching it without going
      // through the bundle.
      ctx.effect(
        () => configForms.whileServed([SETTINGS_NAMESPACE], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item',
          id: SETTINGS_NAMESPACE,
          order: 10,
          label: () => t('title'),
          locale: SETTINGS_LOCALE_NS,
          inject: () => ({ hooks: { hermesForm: store }, ...actions }),
        }, HermesSettingsCard))),
        'hermes-panel: settings page',
      );

      // Rows can carry their own form too. Its key is `bundle#rowId`, where the
      // row id is the one this bundle's patch declares (`hermes-panel`).
      ctx.effect(
        () => configForms.whileServed([SETTINGS_NAMESPACE], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: `${BUNDLE_PACKAGE_NAME}#${SETTINGS_NAMESPACE}`,
          locale: SETTINGS_LOCALE_NS,
          inject: () => ({ hooks: { hermesForm: store }, ...actions }),
        }, HermesSettingsCard))),
        'hermes-panel: settings on the row page',
      );

      ctx.effect(() => () => form.dispose(), 'hermes-panel: settings form');
    }

    //#endregion

    return {
      inject: ['slots'],
      apply(ctx) {
        // A <style> element is not valid inside this rendered markup, so the
        // stylesheet is injected as a document resource and removed on dispose.
        ctx.effect(() => {
          if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) {
            return () => {};
          }
          const tag = document.createElement('style');
          tag.dataset.plugin = BUNDLE_PACKAGE_NAME;
          tag.dataset.pluginCss = STYLE_TAG_ID;
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => tag.remove();
        }, 'hermes-panel: stylesheet');

        ctx.effect(() => store.startPolling(POLL_MS), 'hermes-panel: status poll');

        // The two reads a test has to be able to drive directly.
        //
        // The status poll and the record list are both async, and a test that
        // waited on a 2.5s timer would be slow and flaky; this is the same
        // handle the poll itself calls, exposed for `verify/client.mjs`. It is
        // not a public contract — nothing in the panel reads it.
        ctx.__hermesPanel = { panel: HermesPanel, refresh: store.refresh, loadRecords: store.loadRecords, toggleRecords: store.toggleRecords, openNewestRecord: store.openNewestRecord, toggleSession: store.toggleSession, getState: store.getState };

        // Nothing is registered in the left sidebar any more. The panel that used to
        // live there was a second copy of a surface that is now the right column's
        // tab: same status, same controls, same sections, and a `main` slot that made
        // it REPLACE the conversation the tab is meant to sit beside. One surface,
        // in the place it is useful.

        // The settings page is a SOFT dependency, deliberately not part of
        // `inject`: Cordis holds a plugin back until every injected service
        // exists, and the Hermes panel itself must keep working on a deployment
        // that composes no settings surface. A missing service skips the page
        // instead of costing the whole plugin — and the same reasoning applies
        // to the primitives, which live in the browser module table rather than
        // in this package.
        let primitives = null;
        try {
          primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        } catch {
          /* the module table has no primitives: the panel keeps its own markup and
             the settings page is not mounted */
        }

        // Adopt the shared components and icons. Anything the module table does
        // not carry keeps its stand-in, so a partial table degrades quietly
        // instead of taking the panel down.
        for (const name of Object.keys(FALLBACK_UI)) {
          if (typeof primitives?.[name] === 'function') ui[name] = primitives[name];
        }
        for (const [key, name] of Object.entries(ICON_NAMES)) {
          if (typeof primitives?.[name] === 'function') icons[key] = primitives[name];
        }
        const serviceOf = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined);
        // DSH's own directory picker, when this composition has one — WAITED FOR, not
        // read now.
        //
        // `ctx.get` at activation sees a service table that is still being built:
        // `uiWorkspace` comes from `dsh-client-ui-workspace`, which composes after this
        // plugin, so an eager read returns undefined and the picker silently falls back
        // to the plugin's own modal PowerShell dialog — the one that hangs. This is the
        // same mistake as `sidebarRightTabs`, which is why `ctx.inject` exists.
        if (typeof ctx.inject === 'function') {
          ctx.inject(['uiWorkspace'], (scope) => {
            uiWorkspaceService = scope.uiWorkspace ?? null;
          });
        } else {
          uiWorkspaceService = serviceOf('uiWorkspace') ?? null;
        }

        const configForms = serviceOf('configForms');
        const locale = serviceOf('locale');
        // The panel's own namespace. The settings page registers a second one
        // inside `mountSettingsPage`: the two surfaces have different
        // vocabularies, and the panel must keep its strings on a deployment that
        // composes no settings surface at all.
        if (locale !== undefined) {
          try {
            ctx.effect(() => locale.register(PANEL_LOCALE_NS, PANEL_COPY), 'hermes-panel: panel dictionaries');
            panelTranslate = locale.bind(PANEL_LOCALE_NS);
          } catch (error) {
            console.warn('[hermes-panel] panel dictionaries were not registered', error);
          }
        }
        if (primitives !== null && configForms !== undefined && locale !== undefined) {
          try {
            mountSettingsPage(ctx, primitives, configForms, locale);
          } catch (error) {
            // A settings page that cannot mount must not cost the panel: the
            // namespace stays settable through the profile patch either way, and
            // a thrown `apply` would take the sidebar seat down with it.
            console.warn('[hermes-panel] settings page unavailable:', error);
          }
        }

        // The exchange record as a right-sidebar tab, beside 工作区文件 and
        // 新建终端. Soft again: no right sidebar in this composition, no tab.
        try {
          mountRecordsTab(ctx);
        } catch (error) {
          console.warn('[hermes-panel] right-sidebar dashboard tab unavailable:', error);
        }
      },
    };
  },
});
