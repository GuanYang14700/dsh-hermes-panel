/**
 * Renderer regression for the DSH bridge's event stream.
 *
 * `dsh_run` returns the session id on a fixed `会话 id: <id>` line, and that id
 * is the whole reason Hermes can review a result and then send a follow-up into
 * the SAME session — "send a task, review it, send another". It comes from the
 * `session` event that `dsh --json` writes first, because `--session-id` can
 * only resume: passing an id that does not exist fails outright, and the plain
 * stdout carries no id at all.
 *
 * The renderer lives in `bridge/dsh_events.py` with **no third-party imports**
 * precisely so it can be checked here, without the `mcp` package and without
 * starting a server: this runs its `--selftest`, which asserts the same things
 * from inside Python.
 *
 * Usage: node verify/bridge-render.mjs
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(PACKAGE_DIR, 'bridge', 'dsh_events.py');

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
 * Find an interpreter that can run the renderer's selftest.
 *
 * Tried in order: an explicit override, then whatever the PATH offers, then the
 * Hermes environment the plugin itself discovers. The selftest is stdlib-only,
 * so any Python 3 will do.
 * @returns the command and leading arguments, or null.
 */
function findPython() {
  const candidates = [];
  if (typeof process.env.DSH_TEST_PYTHON === 'string' && process.env.DSH_TEST_PYTHON !== '') {
    candidates.push([process.env.DSH_TEST_PYTHON]);
  }
  for (const name of ['python3', 'python', 'py']) candidates.push([name]);
  const hermesHome = process.env.HERMES_HOME;
  if (typeof hermesHome === 'string' && hermesHome !== '') {
    for (const name of ['Scripts/python.exe', 'python.exe']) {
      const candidate = join(dirname(hermesHome), name);
      if (existsSync(candidate)) candidates.push([candidate]);
    }
  }
  for (const candidate of candidates) {
    const probe = spawnSync(candidate[0], [...candidate.slice(1), '-c', 'import sys; print(sys.version_info[0])'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    if (probe.status === 0 && String(probe.stdout).trim() === '3') return candidate;
  }
  return null;
}

check('the renderer ships beside the bridge', existsSync(SCRIPT), SCRIPT);

const python = findPython();
if (python === null) {
  console.log('SKIP  no Python 3 on PATH and no HERMES_HOME; the renderer selftest was not run');
  console.log('\nALL CHECKS PASSED (with a skip)');
  process.exit(0);
}

const run = spawnSync(python[0], [...python.slice(1), SCRIPT, '--selftest'], {
  encoding: 'utf8',
  timeout: 60000,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});
check('the selftest exits 0', run.status === 0, `exit ${run.status}`);
check('it reports success', String(run.stdout).includes('selftest OK'), String(run.stdout).trim().slice(0, 80));
if (run.status !== 0) {
  console.log('--- stderr ---');
  console.log(String(run.stderr).trim().slice(0, 1200));
}

// The selftest is only useful if it actually asserts; a silently emptied body
// would still print "selftest OK". These are the properties it must cover, and
// they are the ones the bridge depends on.
const source = await import('node:fs').then((fs) => fs.readFileSync(SCRIPT, 'utf8'));
check('it asserts the session id is extracted', source.includes('rendered.session_id =='), '');
check('it asserts the final answer wins', source.includes('rendered.answer =='), '');
check('it asserts tool calls become trace lines', source.includes('rendered.trace =='), '');
check('it asserts plain stdout is NOT treated as a parsed stream', source.includes('plain.parsed is False'), '');
check('it asserts a missing final falls back to text blocks', source.includes('partial.finished is False'), '');
check('it asserts broken lines do not abort the parse', source.includes('noisy.answer =='), '');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
