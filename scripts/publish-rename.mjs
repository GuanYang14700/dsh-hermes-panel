/**
 * Rename this plugin from its development identity to a publishable one.
 *
 * `@local/*` is not a scope anyone can publish to, but the name is also the
 * plugin's identity inside a *running* DSH composition, so changing it while
 * the harness is live needs a restart of the process doing the changing. That
 * is why this is a script you run deliberately rather than something applied
 * on your behalf: dry-run first, read the plan, then `--apply`, then
 * `dsh plugin --profile <p> install` and restart.
 *
 * Four places carry the name, and this rewrites all four:
 *   1. plugins/hermes-panel/package.json            -> name
 *   2. plugins/hermes-panel/cordis.patch.yml        -> the bundle row's name
 *   3. home/profiles/<profile>/package.json         -> dependency key + dsh.profile.bundles
 *   4. plugins/hermes-panel/client.js               -> BUNDLE_PACKAGE_NAME, which is also
 *      the client module id and the `plugins.bundle.config` / `plugins.row.config` slot keys
 *
 * Then the profile needs the package linked under its new name before DSH can
 * resolve the bundle — see the note this prints at the end.
 *
 * Usage:
 *   node scripts/publish-rename.mjs --name @scope/dsh-hermes-panel
 *   node scripts/publish-rename.mjs --name @scope/dsh-hermes-panel --apply
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, '..');

/** npm's own name grammar, minus the length check this tool does separately. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/**
 * Read `--flag value` and boolean flags.
 * @returns the parsed arguments.
 */
function parseArgs() {
  const argv = process.argv.slice(2);
  const result = { name: undefined, profile: 'web', apply: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') result.apply = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--name') result.name = argv[++index];
    else if (arg.startsWith('--name=')) result.name = arg.slice(7);
    else if (arg === '--profile') result.profile = argv[++index];
    else if (arg.startsWith('--profile=')) result.profile = arg.slice(10);
    else throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
  }
  return result;
}

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

/** Read and parse a JSON file. */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Pretty-print JSON the way the repository writes it. */
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const USAGE = `Rename the Hermes panel to a publishable package name.

Usage:
  node scripts/publish-rename.mjs --name @scope/dsh-hermes-panel [--profile web] [--apply]

Without --apply nothing is written; the plan is printed instead.`;

const args = parseArgs();
if (args.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (args.name === undefined) {
  process.stderr.write(`${USAGE}\n\nerror: --name is required\n`);
  process.exit(2);
}
if (args.name.length > 214 || !PACKAGE_NAME.test(args.name)) {
  process.stderr.write(`error: ${JSON.stringify(args.name)} is not a package name npm accepts\n`);
  process.exit(2);
}
if (args.name.startsWith('@local/')) {
  process.stderr.write('error: that is still the @local scope, which cannot be published\n');
  process.exit(2);
}

const manifestPath = join(PACKAGE_DIR, 'package.json');
const patchPath = join(PACKAGE_DIR, 'cordis.patch.yml');
const manifest = readJson(manifestPath);
const previous = manifest.name;
if (args.name === previous) {
  process.stdout.write(`nothing to do: already named ${args.name}\n`);
  process.exit(0);
}

const profilesRoot = findUp(PACKAGE_DIR, join('home', 'profiles'));
if (profilesRoot === undefined) {
  process.stderr.write('error: cannot find home/profiles from this package; run from the harness repository\n');
  process.exit(2);
}
const profilePath = join(profilesRoot, args.profile, 'package.json');
if (!existsSync(profilePath)) {
  process.stderr.write(`error: no profile manifest at ${profilePath}\n`);
  process.exit(2);
}
const profile = readJson(profilePath);
const dependency = profile.dependencies?.[previous];
if (typeof dependency !== 'string') {
  process.stderr.write(`error: ${profilePath} does not depend on ${previous}\n`);
  process.exit(2);
}
const bundles = profile.dsh?.profile?.bundles;
if (!Array.isArray(bundles) || !bundles.includes(previous)) {
  process.stderr.write(`error: ${profilePath} lists ${previous} in dsh.profile.bundles?\n`);
  process.exit(2);
}

const patchText = readFileSync(patchPath, 'utf8');
const patchLine = `      name: '${previous}'`;
if (!patchText.includes(patchLine)) {
  process.stderr.write(`error: ${patchPath} does not contain the expected row ${JSON.stringify(patchLine)}\n`);
  process.exit(2);
}

// The client half, which the first version of this script left alone on the
// assumption that verify/client.mjs would catch a drift. It could not: that
// check compared a hard-coded `@local/...` against a hard-coded `@local/...`.
// The consequences were not cosmetic. The client module id and the
// `plugins.bundle.config` / `plugins.row.config` slot keys all carry this name,
// and the Plugins page resolves those keys against the *installed* package name
// — so after a rename the bundle's own page rendered no configuration and the
// sidebar's settings card was gone, with every check still green.
const clientPath = join(PACKAGE_DIR, 'client.js');
const clientText = readFileSync(clientPath, 'utf8');
const clientLine = `const BUNDLE_PACKAGE_NAME = '${previous}';`;
if (!clientText.includes(clientLine)) {
  process.stderr.write(`error: ${clientPath} does not declare ${JSON.stringify(clientLine)}\n`);
  process.exit(2);
}

process.stdout.write(`rename ${previous} -> ${args.name}\n\n`);
process.stdout.write(`  ${manifestPath}\n    name: ${previous} -> ${args.name}\n`);
process.stdout.write(`  ${patchPath}\n    ${patchLine.trim()} -> name: '${args.name}'\n`);
process.stdout.write(`  ${clientPath}\n    ${clientLine.trim()} -> BUNDLE_PACKAGE_NAME = '${args.name}'\n`);
process.stdout.write(`  ${profilePath}\n    dependencies["${previous}"] -> dependencies["${args.name}"] (${dependency})\n`);
process.stdout.write(`    dsh.profile.bundles: ${previous} -> ${args.name}\n`);

if (!args.apply) {
  process.stdout.write('\ndry run: nothing written. Re-run with --apply to write.\n');
  process.exit(0);
}

manifest.name = args.name;
writeJson(manifestPath, manifest);

writeFileSync(patchPath, patchText.replace(patchLine, `      name: '${args.name}'`), 'utf8');

writeFileSync(clientPath, clientText.replace(clientLine, `const BUNDLE_PACKAGE_NAME = '${args.name}';`), 'utf8');

delete profile.dependencies[previous];
profile.dependencies[args.name] = dependency;
profile.dsh.profile.bundles = bundles.map((entry) => (entry === previous ? args.name : entry));
writeJson(profilePath, profile);

process.stdout.write('\nwritten. Next:\n');
process.stdout.write(`  dsh plugin --profile ${args.profile} install\n`);
process.stdout.write(`  dsh --profile ${args.profile} --dump-config\n`);
process.stdout.write('then restart DSH.\n');
process.stdout.write('\n');
process.stdout.write('If `dsh plugin install` aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY\n');
process.stdout.write('it wanted to purge and reinstall the whole profile. That is not required for a\n');
process.stdout.write('`link:` dependency: the new name only needs a directory link beside the old one.\n');
process.stdout.write(`  e.g. a junction at profiles/${args.profile}/node_modules/${args.name}\n`);
process.stdout.write(`       -> ${PACKAGE_DIR}\n`);
