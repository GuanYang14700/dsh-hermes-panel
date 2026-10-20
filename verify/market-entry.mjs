// Build and validate the single YAML file submitted to the DSH plugin market.
//
// Run:  node verify/market-entry.mjs [path/to/market-entry.yml]
//
// Prints the exact entry file body to stdout (comments and unlisted fields
// stripped — the market accepts only url / name / category / description), and
// diagnostics to stderr. Exits non-zero with the reason when the file would not
// survive the market's own checks.
//
// The market's contributing.md is explicit that a description value containing
// ": " must be quoted or YAML reads it as a nested key, so that is checked here
// rather than discovered by CI on the pull request.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const entryPath = resolve(process.argv[2] ?? resolve(here, '..', 'market-entry.yml'))

const EXPECTED_URL = 'https://github.com/GuanYang14700/dsh-hermes-panel'
const KEEP = new Set(['url', 'name', 'category', 'description'])
const REQUIRED = ['url:', 'name:', 'category:', 'description:', 'en:']

function fail(msg) {
  process.stderr.write(`FAILED: ${msg}\n`)
  process.exit(1)
}

let raw
try {
  raw = readFileSync(entryPath, 'utf8').replace(/^\uFEFF/, '')
} catch (e) {
  fail(`cannot read ${entryPath}: ${e.message}`)
}

// --- keep only the fields the market accepts, drop comments and the rest ----
const kept = []
let keeping = false
for (const line of raw.split(/\r?\n/)) {
  if (/^\s*(#|$)/.test(line)) continue
  const top = /^([A-Za-z_][\w-]*):/.exec(line)
  if (top) keeping = KEEP.has(top[1])
  if (keeping) kept.push(line)
}
const text = kept.join('\n') + '\n'

for (const needle of REQUIRED) {
  if (!text.includes(needle)) fail(`entry is missing a required field: ${needle}`)
}

// --- the market's own rules, checked before CI sees them -------------------
const scalars = {}
for (const line of text.split(/\r?\n/)) {
  const m = /^([a-z]+):\s*(.*)$/.exec(line)
  if (m && KEEP.has(m[1])) scalars[m[1]] = m[2].trim()
}

const unquote = (v) => (/^'.*'$/.test(v) || /^".*"$/.test(v) ? v.slice(1, -1) : v)

if (unquote(scalars.url) !== EXPECTED_URL) {
  fail(`url must be exactly ${EXPECTED_URL} (got ${scalars.url})`)
}
if (scalars.name !== 'GuanYang14700/dsh-hermes-panel') {
  fail(`name must be GuanYang14700/dsh-hermes-panel (got ${scalars.name})`)
}

const CATEGORIES = ['agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory',
  'tools', 'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git',
  'notify', 'dev', 'security', 'remote', 'market', 'fun']
if (!CATEGORIES.includes(scalars.category)) {
  fail(`category ${scalars.category} is not one of: ${CATEGORIES.join(' ')}`)
}

// A description value containing ": " must be quoted, or YAML parses it as a
// nested key. The first code point decides: a quoting character or not.
for (const line of text.split(/\r?\n/)) {
  const m = /^\s+(en|zh):\s*(.*)$/.exec(line)
  if (!m) continue
  const [, key, value] = m
  if (value === '') fail(`description.${key} is empty`)
  const first = value.codePointAt(0)
  const quoted = first === 0x27 || first === 0x22 // ' or "
  if (value.includes(': ') && !quoted) {
    fail(`description.${key} contains ": " but is not quoted; YAML would read it as a nested key`)
  }
  if (value.trimEnd() !== value || value.endsWith('\\')) {
    fail(`description.${key} ends unexpectedly; check for a stray backslash or trailing space`)
  }
}

// A best-effort YAML parse, if a parser happens to be installed. Not required:
// the checks above are the ones that actually decide.
let parsed = null
for (const mod of ['yaml', 'js-yaml']) {
  try {
    const y = await import(mod)
    parsed = (y.default ?? y).parse(text)
    break
  } catch { /* not installed; fine */ }
}
if (parsed) {
  const d = parsed.description
  if (!d || typeof d.en !== 'string' || !d.en.trim()) fail('description.en does not parse as a non-empty string')
  if (d.zh !== undefined && (typeof d.zh !== 'string' || !d.zh.trim())) fail('description.zh does not parse as a non-empty string')
  process.stderr.write(`yaml parse: ok (${parsed.description.en.length} en chars, ${(parsed.description.zh ?? '').length} zh chars)\n`)
} else {
  process.stderr.write('yaml parse: skipped (no yaml parser installed)\n')
}

process.stderr.write(`entry ok: ${entryPath}\n`)
process.stdout.write(text)
