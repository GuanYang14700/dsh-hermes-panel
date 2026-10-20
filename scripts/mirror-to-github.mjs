#!/usr/bin/env node
/**
 * Mirror this package to its public repository.
 *
 * Why a mirror exists at all: this plugin is developed inside a private monorepo,
 * and both npm and the DSH plugin market hand a stranger a repository link. The
 * market goes further — its gate *enumerates* the repository named in the entry's
 * `url` for a `dsh.bundle` manifest, so a private URL is not a broken link, it is
 * an unverifiable submission.
 *
 * So the public repository is this directory, and this script is the whole of the
 * sync: it copies the package (minus the junk `.gitignore` already lists) into a
 * throwaway git repository, commits, and force-pushes `main`. The mirror is
 * generated, never hand-edited — a commit made there directly is lost on the next
 * run, which is the point.
 *
 *   node scripts/mirror-to-github.mjs                 # dry run: what would be pushed
 *   node scripts/mirror-to-github.mjs --apply         # commit and push
 *   node scripts/mirror-to-github.mjs --apply --repo <url>
 *
 * Pushing uses whatever git credential helper this machine already has (the same
 * one `gh` set up). Nothing here reads or writes a token.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_REPO = 'https://github.com/GuanYang14700/dsh-hermes-panel.git';

/**
 * Never mirrored: build junk, machine state, anything a test left behind — and
 * credentials. Backups and packed tarballs count as junk: `.gitignore` already
 * ignores them, and this walk does not read `.gitignore`. The last three matter more than they look: this script publishes
 * to a PUBLIC repository, so a `.npmrc` carrying a publish token that happened to
 * sit in the package directory would be pushed to the internet by a routine sync.
 */
const SKIP = new Set([
  '.git', 'node_modules', '.verify-tmp', '.npm-cache', '__pycache__',
  '.npmrc', '.env', '.env.local',
]);
const SKIP_SUFFIX = ['.pyc', '.jsonl', '.log', '.pem', '.key', '.token', '.bak', '.orig', '.rej', '.tgz', '.zip'];

const arg = (name, fallback = null) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};
const APPLY = process.argv.includes('--apply');
const REPO = arg('--repo', DEFAULT_REPO);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || SKIP_SUFFIX.some((suffix) => entry.name.endsWith(suffix))) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const files = walk(PACKAGE_DIR);
const bytes = files.reduce((total, file) => total + statSync(file).size, 0);
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
const message = arg('--message', `Mirror of plugins/hermes-panel @ ${stamp}`);

console.log(`package : ${PACKAGE_DIR}`);
console.log(`mirror  : ${REPO}`);
console.log(`files   : ${files.length} (${(bytes / 1024).toFixed(0)} kB)`);
if (!APPLY) {
  for (const file of files.slice(0, 40)) console.log(`  ${relative(PACKAGE_DIR, file)}`);
  if (files.length > 40) console.log(`  … and ${files.length - 40} more`);
  console.log('\nDry run. Re-run with --apply to commit and push.');
  process.exit(0);
}

const staging = mkdtempSync(join(tmpdir(), 'hermes-panel-mirror-'));
try {
  for (const file of files) {
    const target = join(staging, relative(PACKAGE_DIR, file));
    cpSync(file, target, { recursive: false, force: true, dereference: true });
  }
  git(staging, ['init', '-q', '-b', 'main']);
  git(staging, ['config', 'user.name', 'mirror-to-github']);
  git(staging, ['config', 'user.email', 'noreply@github.com']);
  git(staging, ['add', '-A']);
  git(staging, ['commit', '-q', '-m', message]);
  git(staging, ['remote', 'add', 'origin', REPO]);
  git(staging, ['push', '--quiet', '--force', 'origin', 'main']);
  console.log(`\npushed ${git(staging, ['rev-parse', '--short', 'HEAD'])} → ${REPO} (main)`);
} catch (error) {
  console.error(`\nmirror failed: ${error.stderr?.toString().trim() || error.message}`);
  process.exit(1);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
