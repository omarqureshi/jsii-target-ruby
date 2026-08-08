#!/usr/bin/env node
/**
 * Writes the *effective* assembly for a package: the published assembly with
 * the Ruby target-config overlay (JSII_RUBY_TARGET_CONFIG) merged in, gzipped
 * JSON on stdout-adjacent path.
 *
 *   node scripts/effective-assembly.js <package-dir> <out.jsii.gz>
 *
 * Published npm artifacts carry no targets.ruby — the overlay supplies it at
 * generation time, in-memory. Anything downstream that reads Ruby naming from
 * the assembly itself (the docs-gen index and module-landing generators)
 * needs this merged form, not the raw published one.
 */
const fs = require('fs');
const zlib = require('zlib');

const spec = require('@jsii/spec');

const { applyRubyTargetOverlay } = require('../lib/target-config');

const [packageDir, outFile] = process.argv.slice(2);
if (!packageDir || !outFile) {
  console.error('usage: effective-assembly.js <package-dir> <out.jsii.gz>');
  process.exit(2);
}
if (!process.env.JSII_RUBY_TARGET_CONFIG) {
  console.error('JSII_RUBY_TARGET_CONFIG is not set — the output would be the raw assembly');
  process.exit(2);
}

const assembly = spec.loadAssemblyFromPath(packageDir, true, ['intersection-types', 'class-covariant-overrides']);
applyRubyTargetOverlay(assembly);

const withRuby = Object.entries(assembly.submodules ?? {}).filter(([, s]) => s.targets?.ruby?.module).length;
if (withRuby === 0) {
  console.error('overlay produced no submodule ruby modules — refusing to write a naming-less assembly');
  process.exit(1);
}

fs.writeFileSync(outFile, zlib.gzipSync(JSON.stringify(assembly)));
console.log(`${outFile}: ${withRuby} submodules carry targets.ruby.module`);
