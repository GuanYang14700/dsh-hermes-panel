/**
 * Shared verification helper: a writable temporary directory.
 *
 * Not an entry point, so it is not listed in `npm test` — `verify/package.mjs`
 * asserts that every script which is *not* a declared helper is wired into one.
 *
 * `os.tmpdir()` is not a safe assumption. Under a sandboxed DSH the system temp
 * directory can refuse directory *creation* — on Windows the failure is
 * `EPERM: operation not permitted, mkdtemp` — while ordinary file writes in the
 * same directory still succeed, so the problem only shows up the moment a script
 * asks for a scratch directory. `%LOCALAPPDATA%\Temp` and a drive root are
 * refused the same way; this package's own directory is not, because the scripts
 * run from it.
 *
 * So: try the system temp first, and fall back inside the package. Everything is
 * removed by the script that made it, and `.verify-tmp` is not in the published
 * `files` list.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Codes that mean "this location will not host a new directory". */
const UNWRITABLE = new Set(['EPERM', 'EACCES', 'EROFS', 'ENOENT']);

/**
 * Create a temporary directory, preferring the system temp and falling back to
 * the package's own tree.
 * @param prefix - directory name prefix.
 * @returns the created directory.
 */
/**
 * Drop the host environment that would otherwise leak into a "no Hermes here" fixture.
 *
 * `index.js` treats `HERMES_HOME` as an explicit discovery root — correctly, because a
 * Hermes-driven DSH run sets it — so a suite started from a Hermes-spawned shell finds the
 * *developer's* installation where the fixture promised an empty machine. The guided-install
 * and workspace-record scripts then go red on exactly the machine that has Hermes installed,
 * which is the machine this suite is developed on. CI happens to be clean, which is how it
 * survived this long. Call this from any script whose fixture assumes no Hermes.
 */
export function isolateHostDiscovery() {
  delete process.env.HERMES_HOME;
}

export function makeTempDir(prefix) {
  try {
    return mkdtempSync(join(tmpdir(), prefix));
  } catch (error) {
    if (!UNWRITABLE.has(error?.code)) throw error;
    const root = join(PACKAGE_DIR, '.verify-tmp');
    mkdirSync(root, { recursive: true });
    return mkdtempSync(join(root, prefix));
  }
}
