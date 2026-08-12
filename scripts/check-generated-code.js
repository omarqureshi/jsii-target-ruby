#!/usr/bin/env node
// Pins every byte this target generates.
//
//   check-generated-code.js <generated-lib-dir>      compare against the snapshot
//   UPDATE_SNAPSHOT=1 check-generated-code.js <dir>   rewrite the snapshot
//
// The other tests each assert something specific: that a name is right, that a
// static reads as a constant, that a variadic struct is coerced. None of them
// notice a refactor quietly changing the other three hundred files — and that
// is the failure worth catching, because generated code is public API the
// moment it ships.
//
// jsii itself has exactly this for its in-tree languages
// (jsii-pacmak/test/generated-code, ~24k lines of snapshot for Ruby when Ruby
// lived in-tree). A plugin cannot use it: the harness is keyed on pacmak's
// TargetName enum and pacmak publishes only lib/, so an external target has to
// bring its own. That duplication is itself an argument for the plugin RFC.
'use strict';

const fs = require('fs');
const path = require('path');

const SNAPSHOT = path.resolve(__dirname, '..', 'test', '__snapshots__', 'generated-code.snap');

/**
 * Content that changes for reasons this snapshot is not about.
 *
 * The fixture assemblies' own version numbers appear throughout — gemspecs,
 * dependency pins, require paths — and move whenever the toolchain checkout
 * updates, which would bury a real generator change under a hundred version
 * lines.
 *
 * Only those exact versions are replaced, discovered from the gemspecs rather
 * than by matching anything that looks like a version. Blanket-normalising
 * every semver would also erase `required_ruby_version = '>= 3.3.0'`, and a
 * change to the Ruby a generated gem demands is precisely the sort of thing
 * this snapshot exists to notice.
 */
function fixtureVersions(dir) {
  const found = new Set();
  for (const { file } of collect(dir)) {
    if (!file.endsWith('.gemspec')) continue;
    const m = /^\s*s\.version\s*=\s*'([^']+)'/m.exec(fs.readFileSync(file, 'utf-8'));
    if (m) found.add(m[1]);
  }
  return [...found].sort((a, b) => b.length - a.length); // longest first
}

function normalize(text, versions) {
  let out = text.replace(/\r\n/g, '\n');
  for (const v of versions) {
    out = out.split(v).join('<version>');
  }
  return out;
}

function collect(dir) {
  const files = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(rb|rbs|gemspec)$/.test(entry.name)) files.push(full);
    }
  })(dir);

  // Sorted by relative path so the snapshot does not depend on directory order.
  return files
    .map((file) => ({ rel: path.relative(dir, file).split(path.sep).join('/'), file }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

function render(dir) {
  const entries = collect(dir);
  const versions = fixtureVersions(dir);
  const parts = [
    `# ${entries.length} generated files`,
    '# Rewrite with: UPDATE_SNAPSHOT=1 node scripts/check-generated-code.js <dir>',
    '',
  ];
  for (const { rel, file } of entries) {
    parts.push(`=== ${rel}`, normalize(fs.readFileSync(file, 'utf-8'), versions).replace(/\n+$/, ''), '');
  }
  return parts.join('\n');
}

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error(`usage: check-generated-code.js <generated-lib-dir>\n  (no directory at ${dir})`);
  process.exit(2);
}

const actual = render(dir);

if (process.env.UPDATE_SNAPSHOT === '1') {
  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, actual);
  console.log(`wrote ${path.relative(process.cwd(), SNAPSHOT)} (${actual.split('\n').length} lines)`);
  process.exit(0);
}

if (!fs.existsSync(SNAPSHOT)) {
  console.error(`::error::no snapshot at ${SNAPSHOT}; create it with UPDATE_SNAPSHOT=1`);
  process.exit(1);
}

const expected = fs.readFileSync(SNAPSHOT, 'utf-8');
if (actual === expected) {
  console.log(`generated code matches the snapshot (${collect(dir).length} files)`);
  process.exit(0);
}

// Report which files differ and show the first divergence, rather than dumping
// sixteen thousand lines: the useful question is "what changed", and a reviewer
// who wants the whole diff has it in git after UPDATE_SNAPSHOT=1.
const split = (text) => {
  const out = new Map();
  let name = null;
  const buf = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('=== ')) {
      if (name) out.set(name, buf.join('\n'));
      name = line.slice(4);
      buf.length = 0;
    } else if (name) buf.push(line);
  }
  if (name) out.set(name, buf.join('\n'));
  return out;
};

const before = split(expected);
const after = split(actual);
const names = [...new Set([...before.keys(), ...after.keys()])].sort();
const changed = names.filter((n) => before.get(n) !== after.get(n));

console.error(`::error::generated code differs from the snapshot in ${changed.length} file(s)`);
for (const name of changed.slice(0, 20)) {
  const was = before.has(name) ? (after.has(name) ? 'changed' : 'removed') : 'added';
  console.error(`  ${was.padEnd(8)} ${name}`);
}
if (changed.length > 20) console.error(`  ... and ${changed.length - 20} more`);

const first = changed[0];
if (first && before.has(first) && after.has(first)) {
  const b = before.get(first).split('\n');
  const a = after.get(first).split('\n');
  const at = b.findIndex((line, i) => line !== a[i]);
  console.error(`\nfirst difference, ${first} line ${at + 1}:`);
  console.error(`  -${b[at] ?? '(end of file)'}`);
  console.error(`  +${a[at] ?? '(end of file)'}`);
}
console.error('\nIf these changes are intended, rerun with UPDATE_SNAPSHOT=1 and commit the snapshot.');
process.exit(1);
