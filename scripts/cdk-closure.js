#!/usr/bin/env node
/**
 * Prints the jsii dependency closure of an assembly in generation order
 * (dependencies before dependents), one npm package name per line, the root
 * package last.
 *
 *   node scripts/cdk-closure.js <path-to-root-package> [<node_modules-dir>]
 *
 * Used by the build pipeline to run one pacmak invocation per package —
 * pacmak's own --recurse topological sort trips over devDependency cycles in
 * *published* packages (the @aws-cdk/asset-* packages ship devDependencies on
 * aws-cdk-lib), so the pipeline orders by actual jsii assembly dependencies
 * instead.
 */
const path = require('path');

const spec = require('@jsii/spec');

const FEATURES = ['intersection-types', 'class-covariant-overrides'];

const rootDir = process.argv[2];
if (!rootDir) {
  console.error('usage: cdk-closure.js <path-to-root-package> [<node_modules-dir>]');
  process.exit(2);
}
const nodeModules = process.argv[3] ?? path.join(path.dirname(path.resolve(rootDir)));

const ordered = [];
const seen = new Set();

function visit(dir, name) {
  if (seen.has(name)) {
    return;
  }
  seen.add(name);
  const assembly = spec.loadAssemblyFromPath(dir, true, FEATURES);
  for (const dep of Object.keys(assembly.dependencies ?? {})) {
    visit(path.join(nodeModules, dep), dep);
  }
  ordered.push(name);
}

const rootAssembly = spec.loadAssemblyFromPath(rootDir, true, FEATURES);
visit(rootDir, rootAssembly.name);

for (const name of ordered) {
  console.log(name);
}
