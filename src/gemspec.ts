/**
 * Gem packaging: gem naming and gemspec emission for generated packages.
 */
import * as path from 'path';

import * as spec from '@jsii/spec';
import * as fs from 'fs-extra';
import * as reflect from 'jsii-reflect';

import { rubySq } from './helpers';
import { toRubyReleaseVersion, toRubyVersionRange } from './version-utils';

/**
 * The gem a (dependency) assembly publishes as: `targets.ruby.gem` when
 * declared, otherwise derived from the npm name (`@scope/pkg` -> `scope-pkg`).
 */
export function rubyGemName(assembly: {
  name: string;
  targets?: spec.AssemblyTargets;
}): string {
  return (
    (assembly.targets?.ruby?.gem as string | undefined) ??
    assembly.name.replace(/@/g, '').replace(/\//g, '-')
  );
}

/**
 * Version of a dependency as installed relative to a package root, or
 * `undefined` when unresolvable (dependency absent, or its exports map does
 * not expose package.json). Used for exact dependency pinning
 * (JSII_RUBY_PIN_DEPENDENCIES=exact).
 */
export function resolveInstalledVersion(depName: string, packageRoot: string | undefined): string | undefined {
  if (packageRoot === undefined) {
    return undefined;
  }
  try {
    const pkgJson = require.resolve(`${depName}/package.json`, { paths: [packageRoot] });
    return JSON.parse(fs.readFileSync(pkgJson, 'utf-8')).version;
  } catch {
    return undefined;
  }
}

/**
 * Write `<gem-name>.gemspec` into `outdir` for the given assembly.
 */
export async function generateGemspec(
  assembly: reflect.Assembly,
  packageRoot: string | undefined,
  outdir: string,
): Promise<void> {
  const assemblySpec = assembly.spec;
  const gemName = rubyGemName(assemblySpec);
  const gemspecPath = path.join(outdir, `${gemName}.gemspec`);
  await fs.mkdir(outdir, { recursive: true });

  // author, license, description and homepage are all required fields of
  // a jsii assembly, so they can be emitted unconditionally; guards below
  // are belt-and-braces for hand-crafted assemblies.
  const gemspecContent = [
    `Gem::Specification.new do |s|`,
    `  s.name        = '${rubySq(gemName)}'`,
    `  s.version     = '${rubySq(toRubyReleaseVersion(assembly.version))}'`,
    `  s.summary     = 'Ruby bindings for ${rubySq(assembly.name)}'`,
  ];
  if (assemblySpec.description) {
    gemspecContent.push(
      `  s.description = '${rubySq(assemblySpec.description)}'`,
    );
  }
  gemspecContent.push(
    `  s.authors     = ['${rubySq(assemblySpec.author?.name ?? 'JSII Generator')}']`,
  );
  if (assemblySpec.license) {
    gemspecContent.push(
      `  s.license     = '${rubySq(assemblySpec.license)}'`,
    );
  }
  if (assemblySpec.homepage) {
    gemspecContent.push(
      `  s.homepage    = '${rubySq(assemblySpec.homepage)}'`,
    );
  }
  gemspecContent.push(
    `  s.files       = Dir["lib/**/*"] + Dir["sig/**/*"]`,
    `  s.required_ruby_version = '>= 3.3.0'`,
    // The runtime pairing is the PLUGIN's contract, not pacmak's: this
    // range must accept the jsii-ruby-runtime gem this plugin version was
    // developed against (runtime/jsii-ruby-runtime.gemspec, in lockstep
    // with the plugin's own version). Deriving it from pacmak's VERSION
    // breaks on dev builds of the toolchain, where VERSION is 0.0.0.
    `  s.add_dependency 'jsii-ruby-runtime', '~> 0.1'`,
    `  s.add_dependency 'base64', '~> 0.2'`,
  );

  if (assemblySpec.dependencies) {
    // JSII_RUBY_PIN_DEPENDENCIES=exact pins each dependency gem to the
    // version actually installed next to the generated package, instead of
    // translating the npm semver range. Distribution policy for feeds that
    // publish the whole closure atomically: consumers resolve exactly the
    // set that was generated and tested together, never a newer dependency
    // this gem has not seen. Falls back to the translated range when the
    // dependency is not resolvable from the package root.
    const pinExact = process.env.JSII_RUBY_PIN_DEPENDENCIES === 'exact';
    for (const [depName, version] of Object.entries(
      assemblySpec.dependencies,
    )) {
      const depInfo = assemblySpec.dependencyClosure?.[depName];
      // Fall back to the same derivation this gem's own name uses. Skipping
      // dependencies without explicit `targets.ruby.gem` produced a gem whose
      // generated sources `require` packages the gemspec never declared —
      // installable, then LoadError on first require.
      const depGem = rubyGemName({ name: depName, targets: depInfo?.targets });
      if (depGem) {
        const pinned = pinExact
          ? resolveInstalledVersion(depName, packageRoot)
          : undefined;
        const requirement =
          pinned !== undefined
            ? `'= ${rubySq(toRubyReleaseVersion(pinned))}'`
            : toRubyVersionRange(version);
        gemspecContent.push(`  s.add_dependency '${rubySq(depGem)}', ${requirement}`);
      }
    }
  }

  gemspecContent.push(`end`);

  await fs.writeFile(gemspecPath, `${gemspecContent.join('\n')}\n`, 'utf-8');
}
