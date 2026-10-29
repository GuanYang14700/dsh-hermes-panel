/**
 * The stylesheet is a JavaScript string, and a missing `}` in it is invisible.
 *
 * `node --check` sees valid JavaScript. The browser sees a rule that never closes and
 * swallows every rule after it, which shows up as 「字体没生效」 or 「字体大小坏了」 three
 * screens away from the line that caused it. That has now happened twice in one session,
 * so it gets a check rather than a promise to be careful.
 *
 * The check reads only what is inside the quotes. The stylesheet is an array of string
 * literals with JavaScript comments between them; a comment is prose, and prose may quote
 * a brace or contain an apostrophe that breaks a naive split. Neither is CSS, and an
 * earlier version of this file counted both — which made it report failures that were not
 * there, and miss the one that was.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(PACKAGE_DIR, 'client.js'), 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
};

// ---- the stylesheet, as the browser sees it ---------------------------------
const start = source.indexOf("'.hp-root{");
check('the stylesheet is where this check expects it', start !== -1, 'no `.hp-root{` rule found');
const end = source.indexOf("].join('');", start);
check('the stylesheet is terminated', end !== -1, 'no `].join(\'\');` after the first rule');

const block = source.slice(start, end);
/** Every string literal in the block, in order: the CSS, and nothing else. */
const pieces = [...block.matchAll(/'([^']*)'/g)].map((match) => match[1]);
const css = pieces.join('');

// ---- a rule that opens inside another ----------------------------------------
//
// A rule may be wrapped across several quoted pieces — long property lists are, on
// purpose — so a piece that opens without closing means nothing by itself. A SECOND
// opener before the first one closed is always a mistake: everything between the two
// becomes part of the outer rule's value. The layout still looks right, because the
// rules still have their braces; nothing in them applies.
const nested = [];
let depth = 0;
let opener = '';
for (const piece of pieces) {
  for (const character of piece) {
    if (character === '{') {
      if (depth > 0) nested.push(`${opener}  ←  ${piece.trim().slice(0, 50)}`);
      else opener = piece.trim().slice(0, 60);
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
    }
  }
}
check('no rule opens inside another', nested.length === 0, nested.join(' | '));

// ---- and every rule closes ---------------------------------------------------
const opens = (css.match(/\{/g) ?? []).length;
const closes = (css.match(/\}/g) ?? []).length;
check('every CSS rule is closed', opens === closes, `${opens} open vs ${closes} close`);
check('and no rule is left open at the end', depth === 0, `depth ends at ${depth}`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
