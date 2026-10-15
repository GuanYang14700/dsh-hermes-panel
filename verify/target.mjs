/**
 * Resolve the Hermes installation the end-to-end scripts drive.
 *
 * Deliberately independent of the plugin's own `discoverHermes`: a test that
 * reused the code under test could not detect a discovery regression. The rules
 * are the same, though — `HERMES_HOME`, then a `Hermes`/`hermes` directory
 * beside any ancestor of the package (plus its `home/` subdirectory), each
 * confirmed by the presence of `official-web/.env`.
 *
 * Hard-coding this author's paths used to make `npm run test:e2e` fail on every
 * other machine. Set `HERMES_HOME` to override.
 *
 * @module verify/target
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Keys worth reading out of `official-web/.env`. */
const KEYS = new Set(['HERMES_HOME', 'VENV', 'HERMES_EXE', 'DASHBOARD_PORT']);

/**
 * Read the whitelisted keys of a Hermes `.env`.
 * @param envPath - path to the `.env`.
 * @returns the parsed values, or undefined when unreadable.
 */
function readEnv(envPath) {
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    return undefined;
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null || !KEYS.has(match[1])) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

/**
 * Every directory worth asking.
 * @returns candidate Hermes home directories.
 */
function candidates() {
  const seen = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim() !== '' && !seen.includes(value)) seen.push(value);
  };
  push(process.env.HERMES_HOME);
  const profile = process.env.USERPROFILE ?? process.env.HOME;
  if (typeof profile === 'string' && profile !== '') {
    push(join(profile, 'Hermes'));
    push(join(profile, 'hermes'));
  }
  let dir = PACKAGE_DIR;
  for (let level = 0; level < 6; level += 1) {
    for (const root of [join(dir, 'Hermes'), join(dir, 'hermes')]) {
      push(root);
      push(join(root, 'home'));
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return seen;
}

/**
 * Resolve the installation, or exit with an explanation.
 * @returns the executable, home, and dashboard port.
 */
export function requireTarget() {
  const attempts = [];
  for (const home of candidates()) {
    const envPath = join(home, 'official-web', '.env');
    if (!existsSync(envPath)) continue;
    const env = readEnv(envPath) ?? {};
    const exe = env.HERMES_EXE
      ?? (env.VENV === undefined ? undefined : join(env.VENV, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'hermes.exe' : 'hermes'));
    if (exe === undefined) {
      attempts.push(`${home}: .env has no HERMES_EXE or VENV`);
      continue;
    }
    if (!existsSync(exe)) {
      attempts.push(`${exe}: not found`);
      continue;
    }
    const port = Number(env.DASHBOARD_PORT);
    return {
      home: env.HERMES_HOME ?? home,
      exe,
      port: Number.isInteger(port) && port > 0 ? port : 9150,
      source: envPath,
    };
  }
  const message = [
    'these end-to-end scripts need a real Hermes installation.',
    'Set HERMES_HOME, or run them from a checkout that sits beside one.',
    ...attempts.map((line) => `  tried ${line}`),
  ].join('\n');
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
