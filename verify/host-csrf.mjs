/**
 * Authorization regression for the `/hermes/api/*` routes.
 *
 * `webServer.register` routes are not behind DSH's auth guard and the route
 * interface has no auth option, so the plugin owns the check. Without it, any
 * page the user visited could `POST /hermes/api/stop` — a simple, preflight-free
 * request — and kill their Hermes gateway.
 *
 * The discriminator used below: a request that passes authorization but carries
 * a non-POST method reaches the method check and answers 405, while a request
 * that fails authorization answers 403 before it. So 405 means "allowed",
 * without ever spawning anything.
 *
 * Entirely hermetic: it builds a throwaway Hermes home under the OS temp
 * directory, so it touches neither the real installation nor its `.env`.
 *
 * Usage: node verify/host-csrf.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';
import { makeTempDir } from './tmp.mjs';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

// ---- a throwaway Hermes installation ---------------------------------------

const root = makeTempDir('hermes-panel-csrf-');
const home = join(root, 'home');
mkdirSync(join(home, 'official-web'), { recursive: true });
const exe = join(root, 'hermes.exe');
writeFileSync(exe, '');
writeFileSync(
  join(home, 'official-web', '.env'),
  [
    '# throwaway fixture',
    `HERMES_HOME=${home}`,
    `HERMES_EXE=${exe}`,
    'DASHBOARD_PORT=9150',
    '',
  ].join('\n'),
);

// ---- plugin under test -----------------------------------------------------

const routes = new Map();
const disposers = [];
let spawns = 0;

const ctx = {
  effect(callback) {
    const disposer = callback();
    if (typeof disposer === 'function') disposers.push(disposer);
    return disposer;
  },
  webServer: {
    register(route) {
      routes.set(`${route.kind}:${route.path}`, route);
      return () => routes.delete(`${route.kind}:${route.path}`);
    },
  },
  subprocess: {
    spawn() {
      spawns += 1;
      throw new Error('a rejected request must not spawn anything');
    },
  },
};

apply(ctx, { dataDir: home });

/**
 * Drive one route.
 * @param path - route pathname.
 * @param options - method, headers, remote address.
 * @returns the status code and parsed body.
 */
async function request(path, { method = 'GET', origin, secFetchSite, host = '127.0.0.1:3080', remoteAddress = '127.0.0.1' } = {}) {
  const route = routes.get(`exact:${path}`);
  if (route === undefined) throw new Error(`route ${path} is not registered`);
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite;
  const req = { method, headers, socket: { remoteAddress } };
  let body = '';
  const res = {
    statusCode: 0,
    writeHead(code) {
      this.statusCode = code;
    },
    end(text) {
      body = text;
    },
  };
  await route.handler(req, res);
  return { status: res.statusCode, body };
}

// ---- what must be refused --------------------------------------------------

const crossOrigin = await request('/hermes/api/start', {
  method: 'POST',
  origin: 'https://evil.example',
});
check('cross-site Origin is refused', crossOrigin.status === 403, `HTTP ${crossOrigin.status}`);

const crossOriginPut = await request('/hermes/api/start', {
  method: 'PUT',
  origin: 'https://evil.example',
});
check('cross-site Origin is refused before the method check', crossOriginPut.status === 403, `HTTP ${crossOriginPut.status}`);

const crossSite = await request('/hermes/api/stop', {
  method: 'POST',
  secFetchSite: 'cross-site',
});
check('Sec-Fetch-Site: cross-site is refused', crossSite.status === 403, `HTTP ${crossSite.status}`);

const sameSite = await request('/hermes/api/stop', {
  method: 'POST',
  secFetchSite: 'same-site',
});
check('Sec-Fetch-Site: same-site is refused', sameSite.status === 403, `HTTP ${sameSite.status}`);

const remote = await request('/hermes/api/status', { remoteAddress: '192.168.1.24' });
check('a non-loopback peer is refused', remote.status === 403, `HTTP ${remote.status}`);

const mappedLoopback = await request('/hermes/api/start', {
  method: 'PUT',
  remoteAddress: '::ffff:127.0.0.1',
});
check('an IPv4-mapped loopback peer is accepted', mappedLoopback.status === 405, `HTTP ${mappedLoopback.status}`);

check('no rejected request spawned a process', spawns === 0, `${spawns} spawn(s)`);

// The guard is only as good as its coverage, so every registered route is asked
// once — including one added later that forgot to carry a case of its own.
const unguarded = [];
for (const key of routes.keys()) {
  const path = key.slice(key.indexOf(':') + 1);
  const result = await request(path, { method: 'PUT', origin: 'https://evil.example' });
  if (result.status !== 403) unguarded.push(`${path}=${result.status}`);
}
check('every registered route refuses a cross-site request', unguarded.length === 0, unguarded.join(', ') || `${routes.size} route(s)`);

// ---- what must be allowed --------------------------------------------------

const plain = await request('/hermes/api/status');
check('same-origin GET status is served', plain.status === 200, `HTTP ${plain.status}`);

const sameOriginPut = await request('/hermes/api/start', {
  method: 'PUT',
  origin: 'http://127.0.0.1:3080',
});
check('a same-origin request reaches the handler', sameOriginPut.status === 405, `HTTP ${sameOriginPut.status}`);

const noOrigin = await request('/hermes/api/restart', { method: 'PUT' });
check('a non-browser client without Origin is served', noOrigin.status === 405, `HTTP ${noOrigin.status}`);

const mismatch = await request('/hermes/api/status', { origin: 'http://127.0.0.1:9999' });
check('a mismatched Origin port is refused', mismatch.status === 403, `HTTP ${mismatch.status}`);

for (const dispose of disposers) dispose();
rmSync(root, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
if (failures === 0) {
  console.log(`(package root: ${PACKAGE_DIR})`);
}
process.exit(failures === 0 ? 0 : 1);
