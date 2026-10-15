# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0-rc.2] — 2026-10-16

**`1.1.0-rc.1` cannot be installed, and this release exists to fix that.** Two defects shipped in it,
both invisible from inside this repository and both found only by looking at the published artifact
with a shell in hand.

- **The package depended on itself.** `dependencies` carried
  `"@yang3333/dsh-hermes-panel": "file:yang3333-dsh-hermes-panel-1.1.0-rc.1.tgz"` — an entry written
  by a local `npm install` during development, pointing at a tarball that exists only on the machine
  that produced it. Anyone running `npm install @yang3333/dsh-hermes-panel` would have been sent
  looking for a file they do not have. `npm publish --dry-run` does not check this, and neither did
  any test here; the entry is gone, and `verify/package.mjs` now fails a manifest that depends on
  itself.

- **The peer range silently excluded every harness prerelease after 0.2.** The old range was
  `>=0.2.0-rc.2 <1.0.0`. node-semver admits a prerelease only when some comparator in the range
  shares its exact `major.minor.patch` *and* carries a prerelease tag, so that range accepts
  `0.2.0-rc.6` and excludes `0.3.0-rc.1`: a user on the next prerelease build of the harness would
  have hit `ERESOLVE` and had to work around it by hand. The range now carries one prerelease branch
  per `0.x` minor, which is the only shape that covers all of them while still refusing `1.0.0`.

  The check that was supposed to catch this asserted the range's *spelling* —
  `/>=0.2.0-rc.2\s+<1.0.0/` — which is to say it asserted the bug. It has been replaced by one that
  asks semver what the range actually accepts, and falls back to a structural check where semver is
  not resolvable.

## [1.1.0-rc.1] — 2026-10-15

**The first release that goes out.** Published to npm and entered in the DSH plugin market as a
pre-release on purpose: this package could not keep being tested on the machine it was written on,
and someone else installing it is the only test that finds the interesting bugs. Everything in this
section shipped in this build; the version number is the honest part.

Three of the things that had to happen first were not features, and are recorded because they were
invisible until the release was actually attempted:

- **A public mirror.** npm and the market both hand a stranger a repository link, and this package is
  developed inside a private monorepo — so `scripts/mirror-to-github.mjs` mirrors it to
  [`GuanYang14700/dsh-hermes-panel`](https://github.com/GuanYang14700/dsh-hermes-panel), which is what
  `repository`, `homepage` and `bugs` now name. `verify/package.mjs` fails a manifest that points
  anywhere else, because a link nobody can open is worse than no link.
- **A market line that cannot drift.** `market-entry.yml` holds the submitted entry, and
  `verify/package.mjs` asserts it is the *same claim* as the package description. The market reads
  that line as a claim about the code and checks it against the repository; a second, slowly
  diverging copy of it would have been the thing that bounced the submission.
- **The one-day rule.** The market's gate refuses a repository created less than a day before the
  pull request — measured, not guessed, and it exists to filter out repositories created minutes
  earlier. The mirror therefore started its clock before the entry was submitted.

The shared workspace becomes observable. Picking one used to change nothing on screen, and the
reason was structural: the directory holds only `AGENTS.md`, while the trace of an exchange lives in
**DSH's session log**. Nothing was broken and nothing was visible, which is the worst combination.

### Added

- **The shared workspace is registered as a real DSH Workspace.** `创建并指向` now calls
  `ctx.workspaceRegistry.create(path, '共享工作区（Hermes ↔ DSH）')` alongside the directory, the
  `AGENTS.md` and `terminal.cwd`. Registration is the switch that matters: DSH's sidebar groups
  Sessions by their canonical cwd, so every session recorded under that directory — including each
  `dsh --json` run Hermes drives over the bridge — appears beneath one node instead of nowhere. The
  call is idempotent (the registry reuses the record owning that canonical path) and is a **soft**
  lookup, so a deployment with no web layer keeps a working panel and reports why instead of
  failing. While `sharedWorkspace` is set and its directory exists, the panel registers it
  automatically — no second press.
- **The ⊕ entry showed DSH's generic cube instead of Hermes.** The guide row takes an artwork
  COMPONENT — DSH's neighbouring panels pass `PluginArtworkTerminal`, `GuideArtworkFiles`,
  `GuideArtworkBrowser` — and there is no Hermes drawing among them, so the row fell back to the
  cube. The plugin already ships the face (`icon.png`, from Hermes' dashboard favicon, the same
  picture as the browser tab); it is embedded as a data URL and handed to the guide entry as
  `icon`. Embedded rather than referenced: the bundle is loaded through `__ModuleLoader__`, so
  `import.meta.url` is not the plugin's address, and working out the served path would mean
  guessing at the `/plugins/??<spec>/` form. 6 KB of base64 cannot 404.

- **The sidebar mark stayed amber after the workspace changed.** The auto-registration was guarded
  by one boolean for the whole page, so the panel tried exactly once — and if that attempt happened
  while the setting pointed somewhere else, or simply failed, the mark never went green again, even
  after a new directory was chosen. It is keyed on the path now: a new choice gets a fresh attempt,
  and a retry still cannot become a request storm. The amber tooltip also says what to do
  (「还没加入 —— 按下面的「创建并指向」」) instead of only what is missing.

- **「选择目录…」 fills the setting and does nothing else.** It does not make Hermes or the bridge
  use the directory — 「创建并指向」 does that — but the panel answered with 「已选目录：X」 and three
  green marks, which reads like the job is done. It is not, and a user duly picked a folder, saw
  green, and found the record empty. The hint names the next step now.

- **The picker fix needed `ctx.inject`, and the first attempt did not use it.** Reading the service
  eagerly in `apply` returned `undefined` — `uiWorkspace` comes from `dsh-client-ui-workspace`, which
  composes after this plugin — so the picker silently fell back to the very dialog it was meant to
  stop using. **This is the same mistake as `sidebarRightTabs`, made twice.** `ctx.inject` waits for
  the service; a regression test pins it.

- **「选择目录…」 hung, and it was five minutes of a modal dialog nobody could see.** The button
  POSTed to the plugin's own route, which ran

  ```
  powershell -STA -Command "…FolderBrowserDialog…ShowDialog()…"
  ```

  with a **five minute** timeout — a modal WinForms window opened from a process with no window of
  its own. It can come up behind everything, and the panel sits on 「等待选择…」 for the whole timeout
  either way, which is indistinguishable from a freeze. DSH ships its own picker
  (`@deepseek-ai/dsh-client-ui-directory-picker-native`, whose entire job is to call
  `uiWorkspace.pickDirectory()`), and that service is already in this composition. The panel asks it
  first now; the plugin's route stays as a fallback for a composition without one, with the timeout
  cut to two minutes so it cannot be mistaken for a freeze.

- **「创建并指向」 never moved the bridge, so the shared workspace was only half shared.** It wrote
  Hermes' own `terminal.cwd` and stopped there. The bridge reads ITS directory from
  `mcp_servers.dsh.env.DSH_MCP_WORKSPACE`, which nothing moved — so a task asked for "in the
  workspace" ran in the directory the bridge was last configured with, the panel reported the two
  values as agreeing, and there was nothing on screen to explain the difference. Both halves are
  written together now, in ONE pass: the same file, so one backup, one `hermes config check`, one
  atomic replacement, and a failure rolls back both rather than half.
- **The config Hermes reads was being found through a file that is not always there.** `-p companion`
  makes Hermes set `HERMES_HOME` to `…/profiles/companion`, so the profile's `config.yaml` is the
  live one and the shell home's is never read. The plugin followed `home/active_profile` — and that
  marker had gone missing on a machine where it had been present an hour earlier, so the plugin fell
  back to the ROOT config and wrote into a file Hermes ignores while reporting the values it had just
  written. There is a second signal now: a running Hermes writes its state as it goes, so **the
  profile with the newest `state.db` is the one in use** — which survives the marker being absent and
  does not need Hermes to cooperate.

- **A translation key in the wrong dictionary renders as itself.** `t('directories.title')`
  printed the literal text `directories.title` in the panel, because the copy went into
  the settings-page dictionary while the section reads the panel one. **Every test stayed
  green** — the "every key the code asks for exists" check looks at the whole file, so a
  key defined anywhere counts as defined — and only opening a browser showed it.

  There is now a check for it: render the panel and assert that no leaf string looks like
  a key. That is the fourth class of invisible breakage this plugin has a guard for, and
  the third one this session that was found by looking rather than by testing.

- **The guided install is gone.** It cloned a Hermes checkout or took a local one and
  ran its `install.ps1` — a whole feature for a machine with no Hermes, and one this
  plugin cannot finish on the user behalf: the installer is interactive, writes into
  whichever Python environment it finds, and its default conda environment is literally
  named `Hermes`. So the plugin does not install Hermes any more and does not try to.

  What replaces it is what was already there: **two directory settings**, and the panel
  points at an installation the user made. The 「设置」 view gained a 「Hermes 目录」
  section with a folder picker for each, because a path typed into a box is the one
  setting that cannot be validated by reading it — and each row prints the evidence:
  the CLI found for the runtime, the profile count and state size for the volume.

  Removed with it: `installSource`, two routes, an install panel and its state, a
  capability flag, twenty-four copy lines and a verification script. The route count
  went from 19 to 17 and the settings from 7 to 6.

- **「字体大小坏了」 was one missing `}` three screens away.** `.hp-dash-head` is a rule
  wrapped across two quoted pieces, and the label rule for the new gateway text was
  inserted between them — leaving it open, so every rule after it became part of its
  value. Spacing, sizes and the three workspace marks all collapsed at once.

  **A JavaScript string cannot be checked by `node --check`, so it now has its own check:**
  `verify/styles.mjs` walks the stylesheet and fails when a rule opens inside another, or
  when the braces do not balance. That is the third invisible-breakage class this plugin
  has picked up a guard for, and the second time this session that a CSS edit looked fine
  to every test and only broke in a browser.

- **A dead panel now says why, and what to do.** 「没有找到可用的 Hermes 安装」 is a fact,
  not an instruction — and the Host already knew which directory it looked at and why that
  directory does not qualify. The empty state threw that away. It now names the directory it
  tried and the setting to fill. Third time this plugin made the same mistake: the amber
  workspace mark said "not listed" without saying how to list it, and the gateway dot kept its
  meaning in a tooltip nobody opens. **State plus the next step, every time.**

- **The guided install was unreachable.** `InstallPanel` rendered only in the full-width
  panel's empty branch — and the full-width panel is not what renders any more; the right
  column renders the sections. So the one flow for "there is no Hermes yet" could not be
  pressed from the only surface a user has, while the empty state told them to set an install
  source. It is a section now.

- **The data volume reports what is in it.** `dataDir` is the one setting a text box cannot
  validate — a right path and a wrong path read identically — so the section prints the
  evidence: which profiles, how much state, whether `official-web` came with it. Counted
  cheaply (profiles by listing, sizes from `state.db` only), because walking a Hermes home on
  every status refresh would block it.

- **7 KB of dead weight removed.** `AVATAR_URL` — 6.4 KB of base64, the left sidebar mark's
  picture — was still embedded after that panel was deleted, referenced only by two CSS rules
  nothing rendered. Seven dead rules went with it, and one scratch file.

- **Copy tightened.** 「用哪个 Python 跑 Hermes」 explained; 「运行时（Python 环境）」 labels.
  A settings page is read once, and the labels are what get scanned.

- **Both READMEs rewritten where they were wrong.** They still described auto-detection, the
  filesystem walk, and thirteen fields that no longer exist.

- **The sidebar showed 「共享工作区（Hermes ↔ DSH）」 twice.** The registration used a fixed title,
  so two DIFFERENT directories — one the plugin was pointed at earlier, one now — sat in the list
  under one identical name with no way to tell which was which. The title carries the directory now
  (`共享工作区 · 无敌小辣条`), and registering a new shared workspace **deletes the rows this plugin
  left behind** for other directories. Only its own: recognised by the title prefix, and only when
  the path is not the current one. Best-effort — a registry without `delete` must not fail a
  registration that already succeeded.

- **The record is the bridge's journal now, not the session store.** Listing every DSH session was
  the wrong answer to a real problem. Filtering to `cwd === sharedWorkspace` hid a genuine exchange
  (Hermes drives DSH from its OWN workspace); dropping the filter made the list fifty rows of
  everything anybody had ever run. Neither is the record.

  **The session store cannot tell the difference.** A driven session and a handwritten one have
  byte-identical headers — `{type, version, id, createdAt, cwd, isSeeded, delegationDepth}`. The
  bridge can: it reads the session id out of the event stream. So it appends one line per run to a
  journal (`DSH_MCP_JOURNAL`, written into `mcp_servers.dsh` by the plugin, defaulting to
  `~/.dsh/hermes-panel/drives.jsonl`), and the record reads that. Two things fall out of it that
  nothing else could give: the list is exactly the exchanges Hermes drove, and **the task text is**
  **available** — DSH receives it as a CLI argument, which is why every turn used to open with
  「（没读到任务正文）」.

- **The record rows, redesigned.** They were five inline spans fighting for one line: the timestamp,
  the title, the state word — which wrapped into a vertical 「已/结/束」 — and the cwd pushed to the far
  right, away from everything it belonged to. Nothing had a hierarchy, so a row saying WHAT WAS ASKED
  read like a row saying when it happened. A row is two lines now — the task in the reading size with
  the time small and quiet beside it, then the cwd in monospace (tinted when it is not the shared
  directory) and the state as a chip. It is wrapped in one element because the Button lays its
  children out in a row, which is what put the path on the task's line the first time.

- **A polish pass over what the move left behind.** `PANEL_ID` and `HermesIcon` were the sidebar
  seat's id and glyph, and nothing else referenced them; eleven copy keys went the same way
  (`workspace.hermesCwd`, `workspace.done`, `records.tabTitle`, `records.tabHint`, the unused
  `records.role.*` three, `update.checkingShort`, `update.button`, `frame.reload`, `state.unknown`).
  The DSH bridge's 「收起」 button is suppressed in the 「设置」 view, where the section IS the view
  and a disclosure control would do nothing. The READMEs were still describing the left-sidebar
  panel and the old `Hermes-DSH` tab; both now describe the three faces and the unfiltered record.

- **The left sidebar is gone; the right column is the whole surface.** The plugin registered two
  seats there — a `main` panel under key `hermes`, and a `sidebar.panellist` row labelled 「Hermes」
  that opened it. Both are removed. The panel was a second copy of a surface the right column now
  has, and the `main` slot made it REPLACE the conversation the tab exists to sit beside.

  **Nothing was dropped, only moved.** The tab carries three faces, switched by three glyphs in its
  strip with the active one marked:

  - **仪表盘** — the iframe of the native Hermes dashboard
  - **记录** — the Hermes ↔ DSH exchange
  - **设置** — the health report, the upgrade, the DSH bridge and the shared workspace, rendered by
    reusing `HermesPanel` in a sections-only shape

  One row of icons, no labels, everything with a tooltip — and no 「Hermes」 in the left sidebar.

- **「共享工作区」 was writing to a file Hermes does not read.** The whole feature is a no-op, and
  that is why it felt useless. Hermes **profile homes are not merged into the shell home**:
  `companion.bat` runs `hermes -p companion chat`, which makes `get_hermes_home()` resolve to
  `…/home/profiles/companion/`, so the live config is the profile's. The plugin read and wrote
  `runtime.home/config.yaml` — the shell home — in all four places it touched a config.
  So the panel reported `terminal.cwd` as unset on a machine where it is plainly set, and
  「创建并指向」 wrote the value into a file nothing reads. The bridge entry lived under the same
  rule, which is why a `mcp_servers.dsh` written to the root never loaded. `liveConfigPath()` now
  follows `home/active_profile` — how Hermes records which profile is running — and falls back to
  the root only when there is no such marker.
- **…and it was hidden behind the DSH bridge's disclosure.** The section rendered inside
  `if (state.bridgeOpen === true)`, and that flag starts false, so the one thing that answers
  "which directory do the two sides share" was invisible until you pressed a button named after
  something else. It has its own section now, visible whenever Hermes is installed — and it says
  **where Hermes actually works** when that is not the shared directory, because a red mark only
  says THAT they disagree.

- **The exchange record reported only ONE directory, and that hid real exchanges.** It filtered to
  `canonicalPath(cwd) === sharedWorkspace`. Hermes does not naturally work there — its `terminal.cwd`
  is its own profile workspace (`…profilescompanionworkspace`), and that is the cwd it passes
  when it drives DSH. So a task the user had just watched happen was recorded, complete, and
  **invisible one directory over**: the list came back with the other sessions and nothing to explain
  why the one they cared about was missing. The filter is gone. The record now lists what DSH ran,
  and **every row carries the cwd** — tinted when it is not the configured shared directory — so
  "which directory did that land in" is answerable from the screen instead of from a filesystem hunt.

- **The dashboard now lives in the right column too, beside the conversation.** The panel replaces the
  Conversation; the right column belongs to one — which is why nothing in the panel could ever reach
  it (see below). Turning that around is the whole idea: put Hermes where the reader already is, and
  the two can be watched side by side in one window, with no `main` panel to fight over.

  **The first attempt came up empty, and the cause was stacking order, not layout.**
  DSH's right-column panel carries `--dsh-dockkit-dock-layer: 10`; the host that
  carries the iframe sat at `z-index: 5`, so the column painted over it — the frame
  was on screen the whole time and invisible, which is exactly what an empty tab
  looks like. It now sits at 200: above the dock layer (10) and the float layer (60),
  far below anything modal.

  **Every control in both strips is a glyph now**, with its words in the tooltip and
  the accessible name. A column is narrow and the panel row was long; labels were what
  pushed it onto a second line. The panel keeps its full set (start/stop, restart,
  check, bridge, reload, open-in-tab); the column carries what acts visibly in a column
  — start/stop, restart, reload, open-in-tab — because the check report and the bridge
  section render into the MAIN panel, and a button there would do nothing you could see.

  **The frame came back blank, and the cause was a captured element.** `place` closed
  over the slot it measured —

  ```js
  const target = slot.current;          // one read, at effect setup
  const place = () => target.getBoundingClientRect();
  ```

  — and the dashboard and the record SWAP that slot in and out. The moment the record
  took over, React unmounted the div, `target` went detached, and `getBoundingClientRect()`
  returned zero for ever after. `place` hid the host — correctly, for a node that is not on
  screen — and the 500ms tick went on measuring the same dead node, so the frame never came
  back. Reported exactly as it behaves: 「点进去再点一下就是空白界面，能转换，但转换的是空白
  的界面」. `place` now reads `slot.current` on every call, runs once after every render rather
  than only on a tick, and moves the `ResizeObserver` onto whatever it is measuring.

  **Switching to the record lands on the exchange, not on a list of it.** The list answers "how
  many"; the reader who pressed the glyph came for "what did they say". The newest exchange opens
  with it, so the summary is one press away rather than two — and pressing the glyph again returns
  to the dashboard.

  **The ⊕ guide now has one Hermes row, and the record is inside it.** 「交流记录」 had a row of its
  own because it needed a way in; it is a **mode of the dashboard tab** now, reached by a glyph in
  the strip that swaps the frame for the exchange. The mode lives in the store, so it survives the
  tab being closed and reopened — and so a test can drive it the way the button does.

  **One of the two ⟳ had to go.** 「重启」 and 「刷新」 were both `IconRefreshOutlineMedium`, and they
  have to be: that IS the glyph for both. `IconLoadingOutline` is the same arc with the arrowhead
  filed off, which is worse, not better. When two controls have one symbol between them the answer
  is one control — restart stays, reload goes, and closing and reopening the tab refreshes the page
  anyway. Both strips are one ⟳ lighter for it.

  The ⊕ guide now reads **打开 Hermes** (the dashboard) and **交流记录** (the exchange, which used to
  hold that row on its own). A narrow strip above the frame carries a status dot and start / stop /
  restart / reload, because a column is not a full window.

  Two surfaces can now show the same iframe, so two things had to stop being owned by one of them:
  the frame itself was already a module-scope singleton, and the **reload counter moved into the
  store** (`frameNonce`), because a module-scope number would not re-render whichever surface was on
  screen when the other one bumped it. The attach-and-hide logic became `useDashboardFrame()`, used
  by both — the frame is never detached, so the page and any answer it is writing survive the switch.

- **The toolbar is one row, and four of its controls are gone or merged.** It had grown to eight
  same-weight buttons wrapping onto a second line.
  - **「体检」 and 「检查更新」 are now one 「检查」.** They read as two unrelated chores; they are one
    question — is this healthy, and is it current? — and the two reports answer it together, so one
    press fires both routes. (The two panels keep their own headers; only the way they are asked
    changed.)
  - **The button that opens the right column is gone, and this time the reason is proven.** It was
    added, removed, added again, and removed again. Driving the real browser and pressing it
    produced, from the live console:

    ```
    [hermes-panel] could not expand the right sidebar
    Error: sidebarRight: no session surface is mounted
        at SidebarRightController.require (...)
    ```

    The whole `sidebarRight` API is gated on `mounted = sessions.onScreen`, and opening this panel
    replaces the session view, so nothing is on screen inside it. `require()` throws, `screen()`
    returns `undefined` (so `commandTarget(null)` does too), `openTabFromTarget()` returns early,
    and **DSH's own `Ctrl+Alt+B` is no help either** — it resolves to `blocked` with
    `command.noSession` (「请先打开页面」). This is not an ordering bug to fix and not a DSH control
    to borrow: **the right column belongs to a Conversation, and this panel is not one.** DSH's own
    「打开右侧边栏」 button lives in `conversation.session.header.corner` and is right there, working,
    in that view. A control that can never act is worse than none.
  - **The `FALLBACK_UI.Button` now passes `title` and `aria-label` through.** Found by a test whose
    fake module table carries no primitives, so the panel took its own fallback path — and an
    icon-only control whose accessible name is dropped on that path is a button that says nothing.
  - **「重新检测」 moved to the empty state.** It is *not* useless — it is the only thing that
    re-runs discovery, since the 3s poll reads a cached result — but the only moment worth pressing
    it is right after discovery failed, so it belongs on the "no Hermes found" screen.
  - **「刷新界面」 is 「刷新」, and 「新标签打开」 is its ↗ icon** (`IconRightUpOutlineMedium`), with the
    words in the tooltip and the accessible name.
- **The shared-workspace section was five rows and a paragraph; it is now a path and three marks.**
  The directory, whether `AGENTS.md` is there, whether Hermes' `terminal.cwd` points at it, whether
  the sidebar lists it — the same four facts, on one line, each carrying its full sentence as a
  tooltip instead of claiming a row. The three-line explanation of why `AGENTS.md` needs no
  conversion lives in the README, where it already was, and the folder picker moved up to the header
  row. Two buttons became one.
- **The bridge's server half is tested now, and it reports the DSH version.** The renderer beside it
  has had a selftest from the start; the 300-odd lines of `dsh_mcp_server.py` never did — its schema,
  its argv, its truncation and its failure hints were covered only by tests of the *plugin's* config
  writing. That is the half most likely to break quietly, because a mistake there does not crash: it
  sends a task through a shell, or loses the tail of a long report, or stops recognising an error it
  used to translate. `verify/bridge-server.mjs` now runs a `--selftest` over exactly that, imports the
  module with the `mcp` SDK blocked (so the tolerant import stays tolerant), and checks the nastiest
  task text we can write survives as ONE argv element.
  The report's first line now carries the DSH version — `DSH 完成（退出码 0，profile=dsh-agent，
  dsh=0.2.0-rc.2，cwd=…）`. The `--json` event stream is DSH-**internal**: not a versioned interface,
  nothing promises its shape. The worst failure after an upgrade is therefore not a crash but a
  summary that quietly loses content, and the version in the header is what makes that visible.
- **The embedded dashboard survives a panel switch.** DSH renders only the ACTIVE `main` panel, so
  switching to a DSH conversation unmounts this one — and an iframe that unmounts is destroyed. The
  Hermes page reloaded on the way back: the conversation that had been on screen was gone from the
  view, and a turn still in flight was cut off mid-answer. The frame now lives in a fixed-position
  host on `document.body`, sized to the slot the panel renders, and switching away merely hides it.
  It is re-created only when the URL changes or "reload the page" is pressed.
- **…and the first attempt at that was wrong, in a way worth recording.** It kept the frame in a
  *detached* holder and re-inserted it on the way back. That does not work: **in Chromium, removing an
  element from the document destroys its browsing context**, so re-inserting it later reloads it
  exactly as unmounting did — the page was never kept at all. The frame must never leave the document;
  `display:none` is the only thing that may happen to it. The check for this counts the appends:
  `appendChild(frame)` must appear exactly once, because a second one means the frame is being moved.
- **The exchange reads as turns, not as a message dump.** The transcript printed every entry — each
  user message, each assistant message, each tool call and each tool result — as its own block of
  full text. Accurate, and unreadable. A turn is now one task: `Hermes → DSH` with what was asked,
  `DSH → Hermes` with the answer, and the tool calls counted into one line (`read · write · pwsh ×4`)
  instead of one block each. Tool *calls* arrive as assistant messages with `kind: 'tool-call'` and
  are filed as tools, not as answers — filing them as answers printed a JSON argument blob where the
  reply belongs.
- **Two translation keys that were never defined.** `common.listSeparator` (used to join the
  workspace result and the new tool summary) and the settings card's own `title` were both asked for
  and neither existed, so both rendered as the key itself. There is now a check that every key the
  code asks for exists; it was falsified against a deliberately missing key.
- **The right column is asked for, not read once.** The tab, its guide row and the panel's button
  were all registered from an eager `ctx.get('sidebarRightTabs')` at activation — and the service
  table is still being built when a plugin applies, while the right column composes *after* this one.
  The lookup therefore saw nothing and the whole block returned early: **no guide row, no button, no
  error, nothing in the log.** It now waits with `ctx.inject`, the way the layout's own packages ask
  for the same columns. This is the failure worth naming, because every test passed while it was
  broken: their stubs had the service ready up front. There is now a check whose stub deliberately
  withholds it until after activation, and it fails against the old code.
- **Several shared workspaces were added, and then removed.** `extraWorkspaces`, `/workspace/add`,
  `/workspace/remove`, the list UI and the selector were all built, and then taken back out. They were
  over-built: Hermes has exactly one `terminal.cwd` and the bridge takes a cwd per call, so a second
  *registered* workspace bought nothing except a grouping in the record list — at the cost of a
  settings field, two routes, a list, a selector and a `?path=` parameter. One directory is what is
  left. The thing worth remembering is what registration actually does: it tells DSH to group the
  sessions recorded under that cwd beneath one node in the sidebar. It has no effect whatsoever on how
  Hermes drives DSH; the bridge runs `dsh --json` with whatever cwd it is given.
- **The `Hermes-DSH` tab lists the conversations held in that one workspace.** Starting one stays
  DSH's own action on its own workspace node — delegating it is what keeps there from being a second,
  divergent session list.
- **The right-column entry is the pairing, and is named for it.** The tab and its guide row are now
  `Hermes-DSH`, with the exchange as one of the things it holds rather than the whole of it.
- **The record is gone from the panel.** It was rendered inside the workspace section, under the
  bridge, with a Hide toggle of its own next to the bridge's — more than one way to collapse the same
  column's worth of content. It now lives only in the right column, and the panel says so. The record
  also follows its tab: the poll refreshes the corpus only while a tab is mounted, and refreshes it
  silently, so the list stays current without a busy line flickering every few seconds.
- **A button in the panel opens that tab.** Without one the record was reachable only from the right
  column's own guide, which is no help while you are looking at the Hermes panel. It reaches the
  column the way the layout's own "toggle the right sidebar" command does — `commandTarget(null)`,
  which deliberately skips live DOM focus and falls back to the session on screen, so a left-sidebar
  panel can ask for it exactly as a keyboard shortcut does — then `openTabFromTarget`, which expands
  and focuses. Both halves are soft lookups: no right sidebar in the composition, no button.
- **The exchange record is also a tab in DSH's right column**, beside 工作区文件 and 新建终端. The
  panel replaces the DSH view while it is open, so watching what Hermes and DSH say to each other
  meant leaving the conversation you were watching it from; this column stays put while you switch
  between the two surfaces. The right sidebar's tabs are *providers*, not plain slot registrations —
  `sidebarRightTabs.register` with a `guide` entry is what makes the row appear at all — and the body
  and title are two more slot registrations keyed by that kind. Every part is a soft lookup, so a
  profile with no right column simply gets no tab. `verify/client.mjs` pins the provider shape, the
  guide row being localised, the two slot keys, and that the body renders before anything is
  configured.
- **The panel is built from the app's own components.** Every control was hand-rolled — a row of
  identical outlined buttons, status chips drawn with a coloured `span`, detail blocks padded by
  hand — which is why it read as a widget sitting inside DSH rather than part of it. The strip now
  uses the shared `Button` (with variants, sizes and the shared icon set), `StateDot` and `Tag` for
  status, `PathLabel` for paths, and the labels and values of both detail blocks align through a grid
  instead of spaces. They stay a **soft** dependency — the module table may not carry them — so each
  has a stand-in, and `verify/client.mjs` checks both paths: that a table *with* them has them
  adopted, and that no raw `<button>` creeps back in.
- **The update section no longer renders an empty header.** Its guard tested `job === null`, but the
  store keeps an *idle job object*, so the section showed a title, a Hide button, and nothing to hide
  on every single render. A phase question is now asked as one. This was found by rendering the panel
  to a text wireframe against the live status payload, because no browser was available to look at it.
- **The Hermes ↔ DSH record, in the panel.** `看交流记录` lists the sessions recorded in the shared
  workspace (time, folded title, live/finished), and opening one renders that exchange: Hermes' task,
  DSH's answer, its reasoning, the tool calls with their arguments, and the tool results — the failed
  ones marked. Two routes carry it (`/hermes/api/workspace/sessions` and `/workspace/session`), and
  neither is on the status poll, because listing the corpus is storage work rather than a liveness
  probe.
- **The transcript fold is the appended surface, not the raw log.** It keeps only events with
  `surfaceOp: 'append'`, so text a compaction already replaced never reappears; it renders
  `assistant/message` content blocks (reasoning, answer text, tool calls) as separate entries; it
  uses the log-only `tool/call` events as the index that gives each `tool/result` its tool name,
  since results carry only a `callId`; and it labels an injected `user/message` as context rather
  than as something Hermes typed. The predicate is inlined rather than imported: a `link:`-installed
  plugin cannot resolve `@deepseek-ai/*` (the ~300 harness packages sit one level below the `dsh`
  package and DSH runs without `--preserve-symlinks`), and a resolving import that fails costs the
  whole plugin, because startup is all-or-nothing.
- **`verify/workspace-records.mjs`**, and the route count in both READMEs (19).

### Added

- **It works on an installation that is not the author's.** Discovery used to recognise a Hermes
  home by `official-web/.env` alone — one *distribution's* marker, not Hermes' — so on a machine
  where Hermes was installed the ordinary way (`pip`/`pipx`/`uv`, data in a home with
  `config.yaml`) the panel reported 「没有找到可用的 Hermes 安装」 and every control was dead. A home
  is now recognised by `config.yaml` **or** `official-web/.env`, the CLI is resolved through the
  configured `hermesExe` → the distribution's `HERMES_EXE` → a `VENV` → **`hermes` on PATH**, and
  `%USERPROFILE%\.hermes` joined the guessed locations. A home with no CLI at all is still found,
  and says which setting to fill before anything can be started. `verify/upstream.mjs` pins all of
  it, including that nothing is spawned when it cannot be.
- **`capabilities` in the status payload.** 体检 / 查更新 / 升级 / 安装 are the `official-web`
  distribution's own PowerShell scripts, and it is the only place they exist — there is no
  `hermes-agent` subcommand to call instead. The Host now reports which of the four are present,
  each route that needs one answers `available: false` with a reason, and the panel stops offering
  an upgrade button it cannot honour.

### Fixed

- **The suite could not pass in CI, and said it did.** `verify/config.mjs` and `verify/client.mjs`
  compare the settings form against the Host schema, and that schema is Schemastery — which comes
  from the installed harness. The new workflow installed nothing, so both scripts went red on a
  bare checkout. They now report **SKIP** when no factory resolves, and CI installs the one
  devDependency so the checks run for real there.
- **A task string in the bridge's own selftest carried the author's directory name**
  (`D:\Desktop\…`), and several doc comments named `E:\Harness\Hermes\启动.bat`. Both ship in the
  tarball; both are generic now.
- **`创建并指向` reported nothing after picking a directory.** The route answers with a `path`, the
  panel read a `picked` string, so the result line rendered "no change" on success.

- **The suite was red on the machine it was written on, and green in CI.** `verify/install.mjs` and
  `verify/workspace-records.mjs` assert a machine with *no* Hermes, while `index.js` treats
  `HERMES_HOME` as an explicit discovery root — correctly, because a Hermes-driven DSH run sets it.
  Started from a Hermes-spawned shell, both scripts therefore found the developer's own installation
  and failed. The shared test helper drops that variable now (`isolateHostDiscovery()` in
  `verify/tmp.mjs`), so the suite is green from either shell.
- **`verify/bridge.mjs` asserted the retired `bridgeWorkspace` contract**, and the docstring above
  `bridgeWorkspacePath()` still promised it took precedence two lines above the comment saying it did
  not. The prose now describes what the code does, the refusal message no longer names a setting that
  cannot be set, and the four checks pin the inverse: a value for `bridgeWorkspace` is ignored, and the
  bridge's workspace is the shared workspace.
- **The English settings page had no label for `installTarget`.** `zh` carried `field.installTarget` /
  `hint.installTarget`, `en` did not, and the `zh` dictionary declared `title` twice — the second one
  won, silently overriding the settings-page title the comment above it argues for.
- **`verify/config.mjs` was red because both READMEs still claimed 7 settings fields**; the schema has 8
  (`installTarget` came back). The READMEs, `PUBLISHING.md` and this changelog now carry the measured
  numbers: 14 scripts, 552 checks.
- **The CI workflow could never run.** It sat at `plugins/hermes-panel/.github/workflows/ci.yml`, and
  GitHub reads `.github/workflows` only at a repository root — a nested one is never scheduled, however
  correct its contents. It lives at the root now (`.github/workflows/hermes-panel-ci.yml`, with
  `working-directory: plugins/hermes-panel`).
### Changed

- The package name is now `@guanyang14700/dsh-hermes-panel`; the "development name" limitation
  recorded under 1.0.0 no longer applies.

## [1.0.0] — 2026-10-14

First release prepared for publication.

### Added

- **Automatic Hermes discovery.** The plugin reads the installation's own
  `official-web/.env` for `HERMES_HOME`, `VENV`, `HERMES_EXE` and `DASHBOARD_PORT`, and
  searches the configured paths, `HERMES_HOME`, the user profile, and every ancestor of the
  package for a Hermes checkout. No path configuration is required.
- **A packaging and metadata audit, and the drift it found.** `verify/package.mjs` now checks what
  npm and DSH read before a listing goes live: the manifest fields, every `exports`/`files`/`main`
  target existing, the icon being a real PNG inside DSH's 256 KiB limit, both locale files parsing
  and describing the plugin's real scope, the changelog recording the published version, **every
  verification script being wired into a script**, and nothing stray inside a published directory.
  It found three things immediately: `verify/client.mjs.bak-publishrename` — a stale copy of a test
  and the old package name, sitting inside `verify/`, which `files` publishes — and
  `verify/stop-gateway.mjs`, a real regression test that no script ever ran, and README tables still
  claiming six routes and eight config fields. The stray-file check is scoped to the published set
  rather than the whole directory, and was verified by planting a `.bak` inside `verify/` and
  watching it fail.
- **The published descriptions now say what the plugin does.** `package.json`'s `description` and
  both `locale/*.json` blobs still described only discovery, the gateway and the dashboard; they now
  cover the health check, the upgrade and guided install, the MCP bridge and the shared workspace —
  which is the text the market card shows and the npm listing carries.
- **The panel is localized.** DSH's own client packages ship two languages and choose between them
  at runtime, so a Chinese-only panel was a departure from the platform rather than a style choice.
  Every user-visible string now lives in a `hermes-panel.panel` dictionary beside the settings page's
  own, registered with the locale service and falling back to Chinese when none is mounted — the same
  soft dependency the rest of the client half keeps. `verify/client.mjs` holds the two halves apart:
  nothing outside a dictionary may contain CJK, both languages must declare the same keys, and **no
  dictionary value may call `t`**. That last one is not hypothetical — the pass that moved the
  strings into the dictionary ran over the dictionary itself, turning every value into a call to
  itself, which only fails at render time.
- **A `Config` schema** (Schemastery) with every field `.volatile()`, so the Host serves a settings
  namespace for this plugin and validates whatever the profile patch or the settings page writes.
- **A settings page.** A served namespace is not a rendered one: DSH ships no generic renderer for
  a plugin's schema, and each settings page is contributed by the owning plugin's own client half
  through the `plugins.item` slot — which is also what places the card on the Plugins panel. The
  page appears there under the **Official** group as **Hermes 面板设置 / Hermes Panel settings**,
  named apart from the installed bundle card on purpose, and exposes all eight fields through the
  shared settings-form primitives with per-field override badges, reset, and save-time validation.
- **The rename now covers the client half, and the check that missed it no longer agrees with
  itself.** `publish-rename.mjs` rewrote the manifest, the bundle patch and the profile — but not
  `client.js`, whose `BUNDLE_PACKAGE_NAME` is the client module id *and* the key the Plugins page
  looks up for `plugins.bundle.config`. After a rename the bundle's config slot was registered under
  a name no installed package had, so the bundle's own page and the sidebar settings card went
  missing. `verify/client.mjs` could not see it because it compared a hard-coded `@local/...` against
  a hard-coded `@local/...`: it now reads the name from `package.json`, asserts the module id, the
  single-source constant and the slot keys against it, and refuses any `@local/` literal in either
  shipped half. The script also gained the client half and a note about the link step.
- **The verifier no longer assumes the system temp is writable.** `mkdtempSync` under
  `C:\WINDOWS\TEMP` and `%LOCALAPPDATA%\Temp` fails with `EPERM` under this sandbox even though file
  writes in the same directory succeed, which took the whole suite down with an exception rather
  than a failed check. `verify/tmp.mjs` tries the system temp first and falls back to the package's
  own `.verify-tmp`, which is not in the published `files`.
- **Settings are now read live, not from the activation snapshot.** Every field is `.volatile()`,
  so DSH serves these values from the row's settings namespace and expects them to be read at
  runtime — but the Host half normalized `config` into a plain object once, inside `apply`. A save
  persists to the profile patch, the settings page shows it, and the plugin kept answering from the
  config it was born with: a workspace the user had just picked still read back as unset. The values
  now come from `ctx.get('settings')` — a soft lookup, so a deployment that mounts no settings
  service keeps working from the applied config — behind a short-lived memo, because `describe()`
  projects every namespace and one status snapshot reads a dozen fields. `verify/config.mjs` pins
  all three cases: a live value overriding the applied config, a value saved *after* activation, and
  a missing namespace falling back rather than throwing.
- **Pick the shared workspace instead of typing it.** **选择目录…** opens the Host's own folder
  dialog (`powershell -STA`, because the common file dialogs need a single-threaded apartment) and
  writes the result back through the settings form's own `edit`/`save` actions, so it is validated
  exactly like a typed value. It has to run on the Host: browsers hide absolute paths from `<input
  type="file" webkitdirectory>`. Cancelling is not an error, and a machine with no usable desktop
  session gets a message pointing at the typed field.
- **The settings form now appears where the user actually lands.** The Plugins page declares three
  contribution slots, and this plugin was filling only `plugins.item` — a card in the **Official**
  group. The bundle's config section renders under `data-plugin-config` **only when something
  registered under `plugins.bundle.config` with that bundle's package name**
  (`configured: ledger.bundles.has(openPkg.name)`), so clicking the installed bundle opened a page
  with nothing on it. The form is now registered into all three — `plugins.item`,
  `plugins.bundle.config` (keyed by the bundle package name) and `plugins.row.config` (keyed
  `bundle#rowId`) — each rendering the same component. `verify/client.mjs` now fires every slot's
  injection the way its owner does; a registration the test never fires never lands, which is how
  this survived a passing suite.
- **A shared workspace, and the shared context that falls out of it.** `sharedWorkspace` names one
  directory both agents open in. **创建并指向** ensures it exists, writes `AGENTS.md` there when it
  is absent (an existing one is never overwritten), and points Hermes' `terminal.cwd` at it through
  the same backup-and-`config check` path as the bridge entry. No format conversion is involved:
  DSH's `dsh-agent-instructions` reads `AGENTS.md` and so do Hermes' `agent_init` / `prompt_builder`
  / `runtime_cwd`, so sharing context is a *directory* problem rather than a sync problem.
  `bridgeWorkspace` still wins when set, and the two halves are reported independently.
- **DSH driven like a subagent.** `dsh_run` now returns a `会话 id: session-…` line, and
  `dsh_resume` continues that exact session — so Hermes can send a task, review the answer, send a
  follow-up, and repeat. The id is only obtainable from the `--json` event stream (its first event),
  because `--session-id` can only resume an existing session and plain stdout carries no id at all;
  the bridge therefore always runs with `--json` and renders the stream — session id, answer, tool
  trace, and a count of the reasoning blocks. The renderer sits in `bridge/dsh_events.py` with no
  third-party imports so `verify/bridge-render.mjs` can check it with any Python.
- **A health check (`体检`).** The panel runs Hermes' own `official-web/doctor.ps1 -Json` and renders
  the nine-point report under the control strip. Deliberately outside the status poll — one run
  costs a PowerShell process and a Hermes CLI call (about 4 s measured) — and the child's
  `[Console]::OutputEncoding` is pinned to UTF-8 so non-ASCII details survive a real PowerShell host.
  This is the first slice of wrapping Hermes' own maintenance scripts instead of reimplementing them.
- **Gateway status read by sentence, not by keyword.** `hermes cron status` prints one of five
  fixed reports — healthy, ticker stalled, ticks failing, an external provider with no PID line, or
  not running — and the plugin now classifies all five. Anything matching none of them is reported
  as **unknown** with the raw tail attached, never as *stopped*: the previous check asked only "does
  it say the gateway is running?" and answered "stopped" when the answer was no, so any rewording of
  the CLI — or a stdout code page that mangled it — silently turned a live gateway into a stopped
  one. The markers contain no `✓`, `⚠` or em dash on purpose, and `PYTHONIOENCODING` is pinned to
  UTF-8. The panel separates the two unknowns: **无法识别** (a report it cannot read) from **未知**
  (a probe that failed).
- **The Hermes half of the DSH bridge.** `bridge/dsh_mcp_server.py` now ships with the plugin, and
  **DSH 桥** reports both halves and can write `mcp_servers.dsh` in Hermes' `config.yaml` — pointing
  at this package's copy rather than at whatever path another checkout left behind. The edit is
  **line-based**, not a YAML round trip: that file holds the runtime's plaintext provider keys and
  its comments, and re-emitting it would drop both. A backup is taken first and `hermes config check`
  must accept the result or the backup is restored.
- **MCP version diagnosis.** DSH disables every MCP row in a profile whose resolved
  `@deepseek-ai/dsh-mcp-client` mismatches the runtime, and only says so in the log. The panel reads
  each profile's own `node_modules` (not the copy bundled inside the `dsh` package, which reports a
  healthy version while the rows are disabled) and prints the exact `dsh plugin` command that fixes
  it. `bridgeWorkspace` and `bridgeProfile` configure the entry.
- **Guided install.** `install.ps1` lives inside a Hermes checkout, so a machine with none has no
  script to run — this plugin cannot ship an installer and needs a source. `installSource` supplies
  one (a git URL to clone, or an existing local checkout) and has no default, because
  `official-web/` is per-deployment. With a plan configured, the "no Hermes found" state offers
  **克隆并安装** behind a confirming press and runs clone → `install.ps1` → re-discovery in the
  background, streaming the installer's output (which matters: a fresh clone makes the installer
  pop Notepad for the API keys, and the job waits for it).
- **Version check and upgrade.** **检查更新** runs Hermes' own `check-update.ps1` (report only) and
  offers **升级到 X.Y.Z** behind a second confirming press. Applying runs `update.ps1 -Apply` as a
  **background job** whose output the panel streams — that output is where the script prints its
  rollback command after a failure. Hermes is stopped first (pip installs into the environment the
  dashboard and gateway execute from, and those files are locked while they run) and deliberately
  not restarted afterwards. The job's 30-minute cap is a last resort rather than a normal path:
  killing pip mid-install is how a virtual environment gets broken.
- **Route authorization.** Every `/hermes/api/*` route now requires a loopback peer, a
  same-origin `Origin` (matching `Host`), and a non-cross-site `Sec-Fetch-Site`. Previously a
  method check was the only guard, so any visited web page could `POST /hermes/api/stop` and kill
  the user's Hermes gateway.
- **Serialization of lifecycle commands.** Concurrent `start`/`stop`/`restart` callers now share
  the in-flight run instead of spawning a second dashboard and gateway.
- **Localized display metadata** (`locale/en.json`, `locale/zh.json`). The panel is now titled
  "Hermes 面板" / "Hermes Panel" in the plugin manager instead of showing the package name.
- **`LICENSE` (MIT), `CHANGELOG.md`, `PUBLISHING.md`, an English `README.md`**, and the previous
  Chinese README preserved as `README.zh.md`.
- **Regression tests** `verify/host-csrf.mjs` (authorization) and `verify/config.mjs` (schema and
  secret hygiene), plus a CI workflow.

### Changed

- `cordis.patch.yml` carries **no config**. It previously pinned this author's `hermes.exe` and
  `HERMES_HOME`, so a fresh install mounted a row pointing at paths that do not exist.
- The panel reports a dedicated **not installed** state, with the list of paths that were tried,
  instead of a generic error.
- The panel's status poll idles while the browser tab is hidden.
- The dashboard iframe no longer requests `microphone` and `camera`; the dashboard needs only the
  clipboard.
- The `.env` reader keeps only four whitelisted keys, so the runtime's API key can never reach
  plugin state, the log ring, or an HTTP response.
- Package metadata: `private` removed, `license`, `repository`, `homepage`, `bugs`, `keywords`,
  `engines`, `peerDependencies` and `publishConfig` added; the dead top-level `meta` field
  (DSH never reads it — display metadata comes from `locale/` and `icon`) removed.

### Fixed

- **A `stop` request no longer touches the configured port when no Hermes installation was
  found.** The port would have been the blind default, so a stop could have terminated an
  unrelated process listening on it.
- **Child output offsets were shared between the dashboard and gateway handles**, so the second
  child resumed reading at the first child's offset and its early output was silently dropped.
  Offsets are now tracked per handle.
- Discovery failures no longer leave the panel in a state where **Start** appears to do nothing.

### Known limitations

- Process control is Windows-only (`netstat -ano` + `taskkill /T /F`). On other platforms a
  dashboard this panel did not start cannot be stopped by it.
- Gateway liveness is parsed from `hermes cron status` text. Structured output, if the CLI grows
  one, should replace it.
- A session whose log contains an event type this build does not know (a newer DSH wrote it) cannot
  be read back, so its record shows the read failure instead of a partial conversation. The same
  applies to a deployment whose other DSH process uses a different `$DSH_HOME`: the session is not
  in this corpus at all.
