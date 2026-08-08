#!/usr/bin/env node
/**
 * Naming-sync check: compares aws-cdk-lib's current submodule list against
 * the overlay (config/cdk-targets.json).
 *
 * Every aws-cdk-lib release can add submodules (new AWS services), and each
 * new one is a *naming decision* — usually "is this an acronym / how does the
 * product brand it?". Without an overlay entry, a new submodule silently
 * renders with derived PascalCase (aws_xyz -> Xyz), which becomes permanent
 * public API for consumers. This script makes that decision deliberate:
 *
 *   node scripts/check-cdk-naming.js <path-to-aws-cdk-lib-package>
 *
 * Exit 1 if any top-level submodule lacks an overlay entry (CI fails until a
 * human records the name). Entries for submodules that no longer exist are
 * reported as warnings (safe to prune). Nested submodules derive from their
 * parent's explicit name and are not required to have entries.
 */
const fs = require('fs');
const path = require('path');

const spec = require('@jsii/spec');

const packageDir = process.argv[2];
if (!packageDir) {
  console.error('usage: check-cdk-naming.js <path-to-aws-cdk-lib-package>');
  process.exit(2);
}

const overlayFile = process.env.JSII_RUBY_TARGET_CONFIG ?? path.join(__dirname, '..', 'config', 'cdk-targets.json');
const overlay = JSON.parse(fs.readFileSync(overlayFile, 'utf-8'));
const entries = overlay['aws-cdk-lib']?.submodules ?? {};

const assembly = spec.loadAssemblyFromPath(packageDir, true, ['intersection-types', 'class-covariant-overrides']);
if (assembly.name !== 'aws-cdk-lib') {
  console.error(`expected aws-cdk-lib, got ${assembly.name}`);
  process.exit(2);
}

const submodules = Object.keys(assembly.submodules ?? {});
const topLevel = submodules.filter((s) => s.split('.').length === 2);

const missing = topLevel.filter((s) => !(s in entries));
const gone = Object.keys(entries).filter((s) => !submodules.includes(s));

console.log(
  `aws-cdk-lib ${assembly.version}: ${submodules.length} submodules ` +
    `(${topLevel.length} top-level), ${Object.keys(entries).length} overlay entries`,
);

for (const s of gone) {
  console.log(`  WARN gone (prune from overlay): ${s} -> ${entries[s].module}`);
}

if (missing.length > 0) {
  console.log('');
  for (const s of missing) {
    console.log(`  NEW submodule needs a naming decision: ${s}`);
  }
  console.log(
    `\n${missing.length} new submodule(s). Add entries to ${path.relative(process.cwd(), overlayFile)} ` +
      '(see _decisions.submodules for the conventions) and re-run.',
  );
  process.exit(1);
}

console.log('naming is in sync.');
