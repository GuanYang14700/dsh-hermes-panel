# Publishing this plugin

This documents how to take the current tree to a package published on npm and listed in the DSH
plugin market. The rename has been applied; what remains is publishing and the checks only a human
can run.

## Status overview

| Requirement | State |
|---|---|
| No machine-specific paths | done — a runtime directory and a data directory, both settings, both defaulted under the DSH home |
| Editable settings (`Config` + `.volatile()`) | done — and read **live**, since volatile values are served at runtime |
| A settings page users can actually reach | done — registered into all three Plugins-page slots, so it is reachable from the bundle's own page as well as the Official group |
| Route authorization (CSRF) | done |
| Localization | done — the panel and the settings page each ship `zh`/`en` dictionaries; `verify/client.mjs` refuses a string that lives outside one |
| Icon | done — `icon.png`, manifest-relative, inside DSH's 256 KiB limit |
| `LICENSE`, `README`, `CHANGELOG` | done |
| Tests + CI | done — `npm test` (15 scripts, 544 checks, green from a plain shell **and** from a Hermes-spawned one, and on a bare checkout, where the schema checks and the DSH-root ones report **SKIP** instead of failing — 510 pass / 8 skip / 0 fail there), `.github/workflows/ci.yml` at the **repository root**, with the one devDependency installed |
| Usable on a machine that is not this author's | done — discovery accepts an upstream home (`config.yaml`) and a `hermes` on PATH, not just `official-web/`; the three distribution-only controls are capability-gated and name what is missing. `verify/upstream.mjs` is the regression |
| Packaging and metadata audit | done — `verify/package.mjs` |
| `private` removed | done |
| Publishable package name | **done** — `@yang3333/dsh-hermes-panel`, matching `cordis.patch.yml`. The market lists it under the GitHub identity (`GuanYang14700/…`); an npm scope and a GitHub account need not be the same string |
| A repository a stranger can open | **done** — public mirror `GuanYang14700/dsh-hermes-panel`, synced by `scripts/mirror-to-github.mjs`; `repository`/`homepage`/`bugs` point at it |
| A market line that matches the package | **done** — `market-entry.yml`, asserted against `package.json`'s description by `verify/package.mjs` |
| `engines.dsh` / peer declaration | done — `>=0.2.0-rc.2 <1.0.0`, verified against 0.2.0-rc.2 |

## 1. Renaming the package (already applied)

The name is `@yang3333/dsh-hermes-panel`. This is the step that has already been taken, and it
is recorded because of how it can go wrong. `scripts/publish-rename.mjs` does the whole thing, and
dry-runs by default:

```sh
node scripts/publish-rename.mjs --name @yourscope/dsh-hermes-panel          # show the plan
node scripts/publish-rename.mjs --name @yourscope/dsh-hermes-panel --apply  # write it
```

It rewrites four things:

1. `plugins/hermes-panel/package.json` → `name`;
2. `plugins/hermes-panel/cordis.patch.yml` → the bundle row's `name`;
3. `home/profiles/<profile>/package.json` → the `dependencies` key and the
   `dsh.profile.bundles` entry, keeping the `link:` specifier;
4. `plugins/hermes-panel/client.js` → `BUNDLE_PACKAGE_NAME`.

**Item 4 is not decoration, and an earlier revision of this file claimed it was unnecessary** — "client.js
registers under the package name, so its id is checked against package.json". It was not checked:
`verify/client.mjs` compared a hard-coded `@local/...` against a hard-coded `@local/...`, which can
only ever agree with itself. So after the rename the client registered its module id and its
`plugins.bundle.config` / `plugins.row.config` keys under a name no installed package had — the
bundle's own page rendered nothing and the panel's settings card was gone, **with the suite green
throughout**. Both halves are fixed: the script rewrites the constant, and the check now reads the
name from `package.json` and refuses any `@local/` literal in either shipped half.

### After the rename

The bundle cannot resolve until the profile has the package linked under its new name:

```sh
dsh plugin --profile web install        # recreates node_modules/@yourscope/dsh-hermes-panel
dsh --profile web --dump-config         # compose WITHOUT starting the server; must not warn
```

Restart DSH afterwards. `--dump-config` is the checkpoint: if it composes cleanly, the running
harness will boot.

> **`dsh plugin install` may refuse, and a directory link is the fallback.** On this machine it
> aborted with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`: it wanted to purge and reinstall the
> whole profile's `node_modules`, which is neither necessary nor safe for a `link:` dependency. When
> that happens, the only thing missing is a directory link — a junction on Windows — at
> `node_modules/@yourscope/dsh-hermes-panel` pointing at this package. Delete the old name's link
> with `Directory.Delete(path, false)` (never a recursive delete, which follows the link and takes
> the target with it). On a machine where `install` succeeds normally, let it own the link.

## 2. Publish to npm

**Two things come before the publish itself**: the public mirror has to be pushed (§5), because the
manifest's `repository`/`homepage`/`bugs` name it, and `npm test` has to be green — it is the same
suite CI runs.

```sh
cd plugins/hermes-panel
npm pack --dry-run                                   # the file list, one last look
npm publish --tag latest --access public             # first release: `latest`, or nothing installs
```

The first publish of a version that is *not* finished yet goes out under `latest` on purpose. A
prerelease tagged `next` cannot be installed by `dsh plugin add` (that resolves `latest`), which
would leave the market card offering a command that fails — so `1.1.0-rc.1` is a pre-release in its
*name*, and an installable release in its dist-tag. The next stable version takes `latest` back.

`publishConfig.access` is already `public`. Before the first publish, confirm:

- `npm pack --dry-run` lists 36 files (232 kB packed, 754 kB unpacked): `index.js`, `client.js`, `cordis.patch.yml`, `icon.png`,
  `bridge/`, `locale/*.json`, `scripts/`, `verify/`, `README.md`, `README.zh.md`, `CHANGELOG.md`,
  `PUBLISHING.md` and `LICENSE` — and nothing else;
- `npm test` passes — fifteen scripts, 544 checks. `verify/package.mjs` is the one that guards this
  list: it walks the published set and fails on a stray backup file, an `exports` target that does
  not exist, a locale file that does not parse, or a verification script that is wired into no
  script at all;
- the icon is still under 256 KiB (DSH refuses larger icons) and still a regular file inside the
  package directory — also asserted by `verify/package.mjs`.

> Under a sandboxed DSH, `npm pack` may fail writing its own cache log. Point it somewhere writable:
> `npm_config_cache=./.npm-cache npm pack --dry-run`.

## 3. List it in the market

The market takes no submissions of its own. It reads `data/plugins/*.yml` from
[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin),
regenerates the two READMEs and publishes `plugins.json`; the directory sites and the in-client
`dshmarket` follow from that. A PR adding **one file** is the whole submission.

`market-entry.yml` in this repository holds that file. It is copied verbatim:

```sh
# in a fork of awesome-dsh-plugin/awesome-dsh-plugin
cp market-entry.yml data/plugins/GuanYang14700__dsh-hermes-panel.yml
# then commit it on a branch and open the PR — one file, and no other entry touched
```

`url` points at the **public mirror**, not at this monorepo: the gate enumerates the repository the
entry names for a `dsh.bundle` manifest, so a private URL is not a broken link, it is an
unverifiable submission.

What the gate checks, all of it automated, all of it before a maintainer reads the entry:

| Rule (from upstream `scripts/check-submission.mjs`) | How this package satisfies it |
|---|---|
| the repository in `url` declares `dsh.bundle` | `package.json` declares `dsh.bundle`, with `cordis.patch.yml` beside it |
| that repository is **at least one day old** | the mirror's clock starts the day it is created, so the entry goes up a day later — the gate exists to filter repositories created minutes before the PR, and waiting is the whole cost |
| it exists, is public, and is not archived | `GuanYang14700/dsh-hermes-panel` |
| it is not the harness listing itself | it is a plugin |
| the description is accurate — numbers and API names included | `market-entry.yml` is asserted equal to `package.json`'s description by `verify/package.mjs`, and both describe what the code does |

Expect the catalog to publish a **capability disclosure** produced by scanning the artifact
(`shell`, `env`, `fs-read`, …) and to flag combinations. This plugin should report at least `shell`
(it runs `netstat`, `taskkill` and the Hermes CLI) and `env` (it passes `HERMES_HOME` to children) —
the README's [Security](#security) section says the same thing in prose, which is what the badge is
checked against.

## 4. Release checklist

- [ ] `npm test` passes — including `verify/package.mjs`, which is the packaging audit.
- [ ] `dsh --profile web --dump-config` composes without a warning about this plugin.
- [ ] **A browser pass, which no script can stand in for:** the sidebar entry is present, the panel
      renders in the current language, the bundle's own page shows the configuration form, the
      Official group shows the settings card, and **选择目录…** opens a native folder dialog. Every
      one of these has been wrong at some point in this package's history while the suite was green.
- [ ] The panel shows the right discovery source, and Start/Stop work (dashboard **and** gateway).
- [ ] `README.md` install command matches the published name.
- [ ] Version bumped in `package.json` and `CHANGELOG.md`; market update detection compares npm
      versions, so every change users should receive needs a publish.
- [ ] The scan-reported capabilities match what the README discloses.
- [ ] The shared workspace is pointed somewhere real, and `AGENTS.md` says something true (see the
      README's Languages and shared-workspace sections).

## 5. Keeping the public mirror in sync

The mirror is generated, never edited: a commit made there directly is lost on the next sync.

```sh
node scripts/mirror-to-github.mjs            # dry run — the file list and the byte count
node scripts/mirror-to-github.mjs --apply    # commit and force-push `main`
```

It copies this directory (minus the junk `.gitignore` already lists) into a throwaway git repository
and force-pushes `main`, which is why the mirror never conflicts. It uses whatever git credential
helper the machine already has; nothing in the script reads or writes a token.

Sync before every npm publish and before every market submission, not after: both link to the
mirror, and a link that lands on a weeks-old tree is the kind of detail a reader notices.
