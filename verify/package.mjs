/**
 * Packaging and metadata audit.
 *
 * Everything a DSH plugin market looks at before a listing goes live: the fields
 * npm and DSH read, the artifacts the manifest promises, the icon DSH measures,
 * the locale files it resolves, the changelog it links, and the junk that must
 * not ship. None of it is exercised by running the plugin, which is exactly why
 * it drifts — a stale `description` or a leftover backup file is invisible from
 * the inside.
 *
 * Usage: node verify/package.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(PACKAGE_DIR, name), 'utf8');
const manifest = JSON.parse(read('package.json'));

// DSH reads this file with JSON.parse too, and a UTF-8 BOM makes that throw
// (`Unexpected token '\uFEFF'`), which DSH reports as an uninstallable plugin. A
// text editor on this machine wrote one once; every field below still parsed, so
// nothing here noticed until the profile rejected the bundle. npm strips the BOM
// before parsing, so `npm publish` would not have caught it either.
{
  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  for (const file of ['package.json', 'locale/en.json', 'locale/zh.json']) {
    const path = join(PACKAGE_DIR, file);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path);
    check(`${file} starts with its first byte, not a BOM`, !raw.subarray(0, 3).equals(BOM), raw.subarray(0, 3).toString('hex'));
  }
}

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

// ---- the fields both npm and DSH read --------------------------------------

for (const field of ['name', 'version', 'description', 'license', 'author', 'main', 'exports', 'files', 'engines', 'peerDependencies', 'repository', 'homepage', 'bugs']) {
  const value = manifest[field];
  const present = value !== undefined && value !== null && (typeof value !== 'string' || value.trim() !== '');
  check(`the manifest declares ${field}`, present, typeof value === 'string' ? value.slice(0, 60) : typeof value);
}

check('the package name is publishable', /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/.test(manifest.name ?? ''), manifest.name);
check('the package does not use the development scope', !String(manifest.name).startsWith('@local/'), manifest.name);
check('the version is plain semver', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? ''), manifest.version);
check('publishing is public', manifest.publishConfig?.access === 'public', JSON.stringify(manifest.publishConfig));
check(
  'the description says what the plugin actually does',
  String(manifest.description).length > 80 && /bridge|workspace/i.test(String(manifest.description)),
  String(manifest.description).slice(0, 70),
);
{
  // The peer range, checked by BEHAVIOUR rather than by spelling.
  //
  // The previous version of this check asserted `/>=0.2.0-rc.2 <1.0.0/` against the
  // string — which is precisely the range that was wrong. node-semver only lets a
  // prerelease satisfy a range when some comparator shares its exact
  // major.minor.patch AND carries a prerelease tag, so `>=0.2.0-rc.2 <1.0.0` accepts
  // `0.2.0-rc.6` and silently excludes `0.3.0-rc.1`. A user on the next prerelease
  // build of the harness would hit ERESOLVE and have to work around it by hand.
  //
  // semver is not a dependency of this package, so it is used when it can be
  // resolved and skipped when it cannot (a bare checkout).
  let satisfies = null;
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    for (const candidate of [
      'semver',
      '@deepseek-ai/dsh/node_modules/semver',
      '../node_modules/@deepseek-ai/dsh/node_modules/semver',
    ]) {
      try {
        satisfies = require(candidate).satisfies;
        break;
      } catch {
        /* try the next location */
      }
    }
  } catch {
    /* no resolver, no semver */
  }

  const range = String(manifest.peerDependencies?.['@deepseek-ai/dsh'] ?? '');
  if (satisfies === null) {
    // Structural fallback: the range must carry one prerelease branch per 0.x minor
    // it spans, which is the only shape node-semver accepts.
    const branches = range.split('||').map((part) => part.trim());
    const covered = branches
      .map((branch) => />=(\d+)\.(\d+)\.(\d+)-/.exec(branch))
      .filter(Boolean)
      .map((match) => `${match[1]}.${match[2]}`);
    check(
      'the peer range carries a prerelease branch (semver unavailable, structural check)',
      covered.length >= 2,
      `${covered.join(', ')} — ${range.slice(0, 60)}`,
    );
  } else {
    const mustAccept = ['0.2.0-rc.2', '0.2.0-rc.6', '0.2.0', '0.3.0-rc.1', '0.5.0-rc.1', '0.9.0-rc.1', '0.9.0'];
    const mustReject = ['0.2.0-rc.1', '1.0.0-rc.1', '1.0.0'];
    const refused = mustAccept.filter((v) => !satisfies(v, range));
    const allowed = mustReject.filter((v) => satisfies(v, range));
    check(
      'the peer range accepts every 0.x release and prerelease after 0.2.0-rc.2',
      refused.length === 0,
      refused.length === 0 ? `${mustAccept.length} accepted` : `excluded: ${refused.join(', ')}`,
    );
    check(
      'and still refuses the release before it, and every 1.x',
      allowed.length === 0,
      allowed.length === 0 ? `${mustReject.length} refused` : `wrongly accepted: ${allowed.join(', ')}`,
    );
  }
}
check(
  'the repository points at the public mirror',
  String(manifest.repository?.url ?? '').includes(`github.com/${manifest.author}/dsh-hermes-panel`)
    && manifest.repository?.directory === undefined,
  `${manifest.repository?.url} #${manifest.repository?.directory ?? 'no directory'}`,
);

{
  // The market line is what a stranger reads before any README, and the market
  // reads it as a claim about the code — a maintainer checks it against the
  // repository. So it has to be the SAME claim as the package description, not a
  // second one that drifts.
  const entry = read('market-entry.yml');
  const field = (name) => (entry.match(new RegExp(`^${name}:\\s*(.*)$`, 'm')) ?? [])[1]?.trim() ?? '';
  const unquote = (value) => value.replace(/^['"]|['"]$/g, '');
  const categories = [
    'agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory', 'tools', 'wsl',
    'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git', 'notify', 'dev',
    'security', 'remote', 'market', 'fun',
  ];
  const en = unquote((entry.match(/^ {2}en:[ \t]*(.*)$/m) ?? [])[1] ?? '');
  const zh = unquote((entry.match(/^ {2}zh:[ \t]*(.*)$/m) ?? [])[1] ?? '');
  check('the market entry points at the public mirror', unquote(field('url')) === `https://github.com/${manifest.author}/dsh-hermes-panel`, field('url'));
  check('the market entry names the published package', unquote(field('name')) === `${manifest.author}/dsh-hermes-panel`, field('name'));
  check('the market entry uses a category the market defines', categories.includes(unquote(field('category'))), field('category'));
  check('the market line is the package description, not a second version of it', en === manifest.description, en.slice(0, 70));
  check('the market line has a Chinese half', zh.length > 20 && /[\u4e00-\u9fff]/.test(zh), `${zh.length} chars`);
  check('the market line carries no marketing', !/\b(best|amazing|powerful|ultimate|seamless|revolutionary|blazing)\b/i.test(`${en} ${zh}`), 'no superlatives');
}

// ---- the DSH manifest ------------------------------------------------------

check('dsh.manifestVersion is 1', manifest.dsh?.manifestVersion === 1, String(manifest.dsh?.manifestVersion));
check('the bundle patch is declared and exists', existsSync(join(PACKAGE_DIR, String(manifest.dsh?.bundle?.patch ?? '').replace('./', ''))), String(manifest.dsh?.bundle?.patch));
check('the client half targets the web platform', manifest.dsh?.client?.platform === 'web', String(manifest.dsh?.client?.platform));
check(
  'the client declares the modules it needs',
  Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.length >= 4,
  (manifest.dsh?.client?.inject ?? []).join(', '),
);

// ---- what the manifest promises must exist ---------------------------------

for (const [name, target] of Object.entries(manifest.exports ?? {})) {
  const file = String(target).replace('./', '');
  if (file.includes('*')) continue;
  check(`exports["${name}"] points at a real file`, existsSync(join(PACKAGE_DIR, file)), file);
}
for (const entry of manifest.files ?? []) {
  if (entry.includes('*')) continue;
  check(`files lists something that exists: ${entry}`, existsSync(join(PACKAGE_DIR, entry)), entry);
}
check('the manifest entry point exists', existsSync(join(PACKAGE_DIR, manifest.main ?? '')), String(manifest.main));

// The runtime cannot work without these, whatever `files` happens to say.
for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.png']) {
  check(`the published set covers ${required}`, (manifest.files ?? []).includes(required), (manifest.files ?? []).join(', '));
}
check('the published set covers the locale files', (manifest.files ?? []).some((entry) => entry.startsWith('locale')), '');

// A glob cannot be `existsSync`'d, so the loop above skips it — which would leave
// the bridge scripts, the thing the whole plugin drives DSH with, unverified in the
// published set. `bridge/*.py` is a deliberate narrowing (a bare `bridge` shipped
// Python's `__pycache__` in the tarball), so the files it stands for are checked by
// name instead.
{
  const scripts = readdirSync(join(PACKAGE_DIR, 'bridge')).filter((name) => name.endsWith('.py'));
  check('the bridge ships its python', scripts.length >= 2, scripts.join(', '));
  check(
    'the published set covers the bridge scripts',
    (manifest.files ?? []).includes('bridge/*.py'),
    (manifest.files ?? []).join(', '),
  );
  for (const script of scripts) {
    check(`the bridge script exists: ${script}`, existsSync(join(PACKAGE_DIR, 'bridge', script)), script);
  }
  check(
    'and the published set does not drag in compiled bytecode',
    !(manifest.files ?? []).some((entry) => entry.includes('__pycache__')),
    (manifest.files ?? []).join(', '),
  );
}

// ---- the icon DSH measures -------------------------------------------------

{
  const iconPath = join(PACKAGE_DIR, String(manifest.icon ?? 'icon.png').replace('./', ''));
  check('the icon exists', existsSync(iconPath), String(manifest.icon));
  if (existsSync(iconPath)) {
    const bytes = readFileSync(iconPath);
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    check('the icon is a real PNG', isPng, isPng ? `${bytes.length} bytes` : 'wrong magic bytes');
    check('the icon is inside the 256 KiB limit', bytes.length <= 262144, `${bytes.length} bytes`);
    check('the icon is not a stub', bytes.length > 512, `${bytes.length} bytes`);
  }
}

// ---- locale ----------------------------------------------------------------

{
  const files = readdirSync(join(PACKAGE_DIR, 'locale')).filter((name) => name.endsWith('.json'));
  check('both shipped languages have a locale file', files.includes('en.json') && files.includes('zh.json'), files.join(', '));
  for (const file of files) {
    let parsed = null;
    try {
      parsed = JSON.parse(read(join('locale', file)));
    } catch (error) {
      check(`locale/${file} parses`, false, error.message);
      continue;
    }
    check(`locale/${file} declares a title`, typeof parsed?.meta?.title === 'string' && parsed.meta.title !== '', JSON.stringify(parsed?.meta?.title));
    check(
      `locale/${file} describes the plugin's real scope`,
      typeof parsed?.meta?.description === 'string' && /bridge|通道|工作区|workspace/i.test(parsed.meta.description),
      String(parsed?.meta?.description).slice(0, 60),
    );
  }
}

// ---- documentation ---------------------------------------------------------

for (const doc of ['README.md', 'README.zh.md', 'CHANGELOG.md', 'PUBLISHING.md', 'LICENSE']) {
  check(`${doc} ships`, existsSync(join(PACKAGE_DIR, doc)) && (manifest.files ?? []).includes(doc), doc);
}

{
  const changelog = read('CHANGELOG.md');
  check('the changelog records this version', changelog.includes(`## [${manifest.version}]`), `looking for ## [${manifest.version}]`);
  check('the changelog follows Keep a Changelog', changelog.includes('keepachangelog.com'), '');

  const license = read('LICENSE');
  check('the license file names the declared licence', license.includes(manifest.license), manifest.license);
  check(
    'the copyright holder matches the manifest author',
    license.includes(manifest.author) && manifest.repository.url.includes(manifest.author),
    manifest.author,
  );
}

// ---- the test suite cannot silently lose a file ----------------------------

{
  // A check that exists but is wired into no script never runs. `verify/tmp.mjs`
  // and `verify/target.mjs` are helpers rather than entry points, and say so.
  const helpers = new Set(['tmp.mjs', 'target.mjs']);
  const scripts = Object.values(manifest.scripts ?? {}).join(' ');
  const orphaned = readdirSync(join(PACKAGE_DIR, 'verify'))
    .filter((name) => name.endsWith('.mjs') && !helpers.has(name))
    .filter((name) => !scripts.includes(`verify/${name}`) && !scripts.includes(`verify\\${name}`));
  check('every verification script is wired into a script', orphaned.length === 0, orphaned.join(', ') || 'all wired');
  for (const helper of helpers) {
    check(`the helper verify/${helper} says it is one`, /helper|\bdrives\b|independent of the plugin/i.test(read(join('verify', helper)).slice(0, 800)), '');
  }
}

// ---- nothing stray ships ---------------------------------------------------

{
  // Scoped to what `files` actually publishes, not to the whole directory. A
  // scratch file beside the manifest is not a packaging defect — `npm pack`
  // never sees it — but one inside a published directory is, and that is the one
  // that happened: `verify/client.mjs.bak-publishrename` sat inside `verify/`,
  // which `files` ships, carrying a stale copy of a test and the old package
  // name.
  const junk = [];
  const JUNK = /\.(bak|orig|rej)$|\.bak-/;
  const scan = (full, label) => {
    if (!existsSync(full)) return;
    if (statSync(full).isFile()) {
      if (JUNK.test(full)) junk.push(label);
      return;
    }
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const child = join(full, entry.name);
      if (entry.isDirectory()) scan(child, `${label}/${entry.name}`);
      else if (JUNK.test(entry.name)) junk.push(`${label}/${entry.name}`);
    }
  };
  for (const entry of manifest.files ?? []) {
    const base = entry.includes('*') ? entry.slice(0, entry.indexOf('*')).replace(/\/+$/, '') : entry;
    scan(join(PACKAGE_DIR, base), base);
  }
  check('nothing stray would be published', junk.length === 0, junk.join(', ') || 'clean');
}

// ---- the suite is described where a reader will look -----------------------

{
  const readme = read('README.md');
  check(
    'the README points at the verification suite',
    readme.includes('verify/') || readme.includes('npm test'),
    '',
  );
  check('the README documents the published name', readme.includes(manifest.name) || readme.includes('dsh-hermes-panel'), manifest.name);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
if (failures === 0) console.log(`(package: ${manifest.name}@${manifest.version})`);
process.exit(failures === 0 ? 0 : 1);
