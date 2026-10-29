/**
 * Smoke check: the Host half still loads and composes from its repository
 * location, WITHOUT spawning anything.
 *
 * `host.mjs` owns the full lifecycle test but needs exclusive use of the
 * dashboard port, and `concurrency.mjs` drives the lifecycle against a stub.
 * This is the safe one to run while the real Hermes is live: the subprocess
 * stub throws if the plugin so much as tries to spawn, so a pass proves
 * activation is side-effect free.
 *
 * It activates with an EMPTY config on purpose — the interesting regression is
 * that discovery works without being told where Hermes is.
 *
 * Usage: node verify/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { apply } from '../index.js';

const routes = new Map();
const disposers = [];
let spawned = 0;
let spawnError = null;

const ctx = {
  effect: (callback) => {
    const disposer = callback();
    if (typeof disposer === 'function') disposers.push(disposer);
    return disposer;
  },
  webServer: {
    register(route) {
      const key = `${route.kind}:${route.path}`;
      if (routes.has(key)) throw new Error(`duplicate route ${key}`);
      routes.set(key, route);
      return () => routes.delete(key);
    },
  },
  subprocess: {
    spawn() {
      spawned += 1;
      throw new Error('smoke check must not spawn a process');
    },
  },
};

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

let error = null;
try {
  apply(ctx, {});
} catch (cause) {
  error = cause;
}

check('index.js imports and apply() runs with an empty config', error === null, error ? `${error.name}: ${error.message}` : '');
check('registers exactly 17 routes', routes.size === 17, [...routes.keys()].join(', '));
check(
  'activation spawns nothing (no side effects before a user action)',
  spawned === 0,
  `${spawned} spawn(s)`,
);

// Both READMEs state the route count in their test tables. A number written in
// prose drifts the moment a route is added — this one was still claiming six
// when there were sixteen — so it is compared against the real count here,
// where the real count lives.
//
// A README that exists but no longer matches the pattern is a failure, not a
// skip: the check would otherwise go inert the moment someone rewords the
// sentence, which is the same silent-pass this whole script is meant to stop.
for (const [file, pattern] of [
  ['README.md', /registers (\d+) routes/],
  ['README.zh.md', /注册 \*\*(\d+) 条路由\*\*/],
]) {
  const path = new URL(`../${file}`, import.meta.url);
  let claimed = null;
  let readable = true;
  try {
    claimed = pattern.exec(readFileSync(path, 'utf8'))?.[1] ?? null;
  } catch {
    readable = false;
  }
  check(
    `${file} claims the real route count`,
    readable && claimed !== null && Number(claimed) === routes.size,
    !readable
      ? 'not readable — verify/package.mjs reports the missing file'
      : claimed === null
        ? 'no claim matched — the sentence was reworded, so this check is now inert'
        : `claims ${claimed}, actual ${routes.size}`,
  );
}

// The status route must answer even with no Hermes anywhere, and must report
// what discovery tried rather than throwing.
let payload = null;
let statusCode = 0;
try {
  const route = routes.get('exact:/hermes/api/status');
  let body = '';
  await route.handler(
    { method: 'GET', headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } },
    {
      writeHead(code) {
        statusCode = code;
      },
      end(text) {
        body = text;
      },
    },
  );
  payload = JSON.parse(body);
} catch (cause) {
  spawnError = cause;
}

check('the status route answers 200 without a Hermes install', statusCode === 200 && payload !== null, spawnError ? `${spawnError.name}: ${spawnError.message}` : `HTTP ${statusCode}`);
check('the payload carries a discovery report', typeof payload?.discovery?.found === 'boolean', JSON.stringify(payload?.discovery?.source ?? null));
check('a failed discovery explains itself', payload?.discovery?.found === true || (Array.isArray(payload?.discovery?.attempts) && payload.discovery.attempts.length > 0), (payload?.discovery?.attempts ?? []).join(' | ').slice(0, 160));
check('the status poll still spawned nothing', spawned === 0, `${spawned} spawn(s)`);

for (const dispose of disposers) dispose();

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
