/**
 * Regression for the DSH bridge's **server half**.
 *
 * `dsh_events.py` (the renderer) has had a selftest from the start. The 300-odd
 * lines beside it never did — the tool schemas, the argv, the truncation, the
 * failure hints and the version gate were covered only by `verify/bridge.mjs`,
 * which tests the *plugin's* config writing rather than the server.
 *
 * That is the half most likely to be got wrong quietly, because a mistake there
 * does not crash: it sends the task text through a shell, or loses the tail of a
 * long report, or stops recognising an error it used to translate.
 *
 * Usage: node verify/bridge-server.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(PACKAGE_DIR, 'bridge', 'dsh_mcp_server.py');
const BRIDGE_DIR = join(PACKAGE_DIR, 'bridge');

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
 * Find a Python 3 that can import the server module.
 *
 * Deliberately NOT the Hermes interpreter: the whole point of the tolerant
 * import is that this file can be checked without the `mcp` package installed,
 * so the first interpreter that runs at all is the right one.
 * @returns the command and leading arguments, or null.
 */
function findPython() {
  const candidates = [];
  if (typeof process.env.DSH_TEST_PYTHON === 'string' && process.env.DSH_TEST_PYTHON !== '') {
    candidates.push([process.env.DSH_TEST_PYTHON]);
  }
  for (const name of ['python3', 'python', 'py']) candidates.push([name]);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate[0], [...candidate.slice(1), '-c', 'import sys; print(sys.version_info[0])'], {
      encoding: 'utf8',
      timeout: 30000,
    });
    if (probe.status === 0 && String(probe.stdout).trim() === '3') return candidate;
  }
  return null;
}

/** Run one in-process assertion set and report the verdict. */
function runProbe(python, label, body) {
  const run = spawnSync(python[0], [...python.slice(1), '-c', body], {
    encoding: 'utf8',
    timeout: 60000,
    cwd: BRIDGE_DIR,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  check(label, run.status === 0, run.status === 0 ? '' : String(run.stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 220));
  return run;
}

check('the server ships beside the renderer', existsSync(SERVER), SERVER);

const python = findPython();
if (python === null) {
  console.log('SKIP  no Python 3 on PATH; the bridge server was not run');
  console.log('\nALL CHECKS PASSED (with a skip)');
  process.exit(0);
}

// ---- the selftest itself ---------------------------------------------------
const run = spawnSync(python[0], [...python.slice(1), SERVER, '--selftest'], {
  encoding: 'utf8',
  timeout: 60000,
  cwd: BRIDGE_DIR,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', DSH_MCP_ROOT: process.env.DSH_MCP_ROOT ?? '' },
});
check('the server selftest exits 0', run.status === 0, `exit ${run.status}`);
check('it reports success', String(run.stderr).includes('selftest OK'), String(run.stderr).trim().slice(0, 90));
if (run.status !== 0) {
  console.log('--- stderr ---');
  console.log(String(run.stderr).trim().slice(0, 1200));
}

const source = readFileSync(SERVER, 'utf8');

// A selftest whose body was quietly emptied would still print "selftest OK".
// These are the properties the bridge actually depends on, so they are asserted
// here as well as inside Python.
check(
  'it asserts the task reaches DSH as ONE argv element',
  source.includes('assert argv[-1] == task'),
  '',
);
check(
  'it asserts a resumed id is stripped and ordered correctly',
  source.includes('assert resumed[-3:] == ["--session-id", "session-abc", task]'),
  '',
);
check(
  'it asserts truncation keeps head and tail and says how much went',
  source.includes('中间省略 500 字符'),
  '',
);
check(
  'it asserts the failure hints are still matched',
  source.includes('_failure_hint(') && source.includes('凭证缺失'),
  '',
);
check(
  'it asserts the version is read once, not per run',
  source.includes('assert _dsh_version() is version'),
  '',
);
check(
  'it asserts the version reaches the report header',
  source.includes('dsh=9.9.9'),
  '',
);

// ---- the tolerant import, run for real -------------------------------------
// If this file ever grows a top-level `import mcp` again, everything above still
// passes while the module becomes unimportable without the SDK — so the import
// is exercised directly. The SDK is blocked with a meta-path finder rather than
// uninstalled, so the check means the same thing on a machine that has it.
const IMPORT_PROBE = [
  'import sys',
  'class Block:',
  '    """Refuse every `mcp` import, so this behaves like a machine without it."""',
  '    def find_spec(self, name, path=None, target=None):',
  '        if name == "mcp" or name.startswith("mcp."):',
  '            raise ImportError("blocked for the test")',
  '        return None',
  'sys.meta_path.insert(0, Block())',
  'import dsh_mcp_server as S',
  'assert S.mcp is None, "FastMCP should be unavailable here"',
  'assert S._tool()(lambda: 1)() == 1, "the pass-through decorator must work"',
  'argv = S._build_argv("node", "p", "hi", "")',
  'assert argv[-1] == "hi", argv',
  'print("imported")',
].join('\n');
runProbe(python, 'the module imports, and its helpers work, with no `mcp` package', IMPORT_PROBE);

// ---- the argv property, on the nastiest task text we can write -------------
// The bridge runs node directly instead of through `dsh.cmd` for exactly this:
// no shell may ever see this string again. The task is a Python RAF string so
// that neither JS, Python nor a shell has to escape the backslashes first.
const ARGV_PROBE = [
  'import dsh_mcp_server as S',
  // `r"""…"""` so the backslashes are literal to Python; `\\x` here is what
  // makes JS hand Python a single backslash.
  'task = r"""a "quoted" 100% D:\\x\\y 无敌 你好 && echo no $(id) `whoami`"""',
  'argv = S._build_argv("node", "p", task, "")',
  'assert type(argv) is list, type(argv)',
  'assert argv[-1] == task, repr(argv[-1])',
  'assert sum(1 for a in argv if a == task) == 1, "the task must appear once"',
  'assert all(isinstance(a, str) for a in argv), argv',
  'print("ok")',
].join('\n');
runProbe(python, 'quotes, backslashes, percent signs and CJK survive argv verbatim', ARGV_PROBE);

// ---- the version gate ------------------------------------------------------
// Only meaningful where a DSH install exists; the honest outcome elsewhere is
// "reported as unknown", which is also what the report must never do silently.
runProbe(
  python,
  'an absent DSH is reported as unknown, not as a crash',
  'import os, dsh_mcp_server as S\n'
  + 'assert S._dsh_version() is None or isinstance(S._dsh_version(), str)\n'
  + 'assert S._version_suffix().startswith("\\uff0cdsh=") or S._version_suffix() == ""\n'
  + 'print("ok")',
);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
