import { Range, parse } from 'semver';
import { inspect } from 'util';

/**
 * Ruby version-scheme mapping, owned by this plugin.
 *
 * Per the jsii target-plugin contract, version-scheme conversion is entirely
 * the plugin's concern: jsii-pacmak never calls these — the generator invokes
 * them when stamping the gemspec and dependency constraints. Extracted from
 * the Ruby fork of jsii-pacmak's version-utils.
 */

const RUBY_RELEASE_LABELS: Record<string, string> = {
  alpha: 'alpha',
  beta: 'beta',
  rc: 'rc',
  post: 'post',
  dev: 'dev',
  pre: 'pre',
};

/**
 * Converts a SemVer range expression to a Ruby gemspec compatible version
 * constraint expression.
 */
export function toRubyVersionRange(semverRange: string): string {
  const range = new Range(semverRange);
  if (range.set.length > 1) {
    throw new Error(
      `RubyGems does not support OR (||) requirements natively in a single dependency. Unsupported/unrepresentable constraint: ${semverRange}`,
    );
  }
  return range.set[0]
    .map((comp) => {
      const versionId = toRubyReleaseVersion(
        comp.semver.raw?.replace(/-0$/, '') ?? '0.0.0',
      );
      switch (comp.operator) {
        case '':
          return comp.value === '' ? "'>= 0.0.0'" : `'= ${versionId}'`;
        case '=':
          return `'= ${versionId}'`;
        default:
          return `'${comp.operator} ${versionId}'`;
      }
    })
    .join(', ');
}

/**
 * Converts an assembly version from the NPM convention to RubyGems'. Versions
 * without a prerelease identifier are returned unmodified.
 */
export function toRubyReleaseVersion(assemblyVersion: string): string {
  const version = parse(assemblyVersion);
  if (version == null) {
    throw new Error(
      `Unable to parse the provided assembly version: "${assemblyVersion}"`,
    );
  }
  if (version.prerelease.length === 0) {
    return assemblyVersion;
  }

  const baseRuby = `${version.major}.${version.minor}.${version.patch}`;

  // Fallback for purely numeric prerelease (e.g. 0.0.0-1234)
  if (
    version.prerelease.every(
      (p) => typeof p === 'number' || !Number.isNaN(Number(p)),
    )
  ) {
    return `${baseRuby}.pre.${version.prerelease.join('.')}`;
  }

  const validationErrors: string[] = [];
  version.prerelease.forEach((elem, idx, arr) => {
    const next: string | number | undefined = arr[idx + 1];
    if (typeof elem === 'string') {
      if (!Object.keys(RUBY_RELEASE_LABELS).includes(elem)) {
        validationErrors.push(
          `Label ${elem} is not one of ${Object.keys(RUBY_RELEASE_LABELS).join(',')}`,
        );
      }
      if (
        next === undefined ||
        !Number.isSafeInteger(next) ||
        (next as number) <= 0
      ) {
        validationErrors.push(
          `Label ${elem} must be followed by a positive integer`,
        );
      }
    }
  });

  const postIdx = version.prerelease.findIndex((v) => v.toString() === 'post');
  const devIdx = version.prerelease.findIndex((v) =>
    ['dev', 'pre'].includes(v.toString()),
  );
  const preReleaseIdx = version.prerelease.findIndex((v) =>
    ['alpha', 'beta', 'rc'].includes(v.toString()),
  );

  const unconsumed = version.prerelease.filter((_, idx) => {
    if (preReleaseIdx > -1 && (idx === preReleaseIdx || idx === preReleaseIdx + 1)) {
      return false;
    }
    if (postIdx > -1 && (idx === postIdx || idx === postIdx + 1)) {
      return false;
    }
    if (devIdx > -1 && (idx === devIdx || idx === devIdx + 1)) {
      return false;
    }
    return true;
  });

  if (unconsumed.some((v) => typeof v === 'string')) {
    validationErrors.push(
      `Contains multiple or unmappable prerelease labels: ${inspect(version.prerelease)}`,
    );
  }

  if (validationErrors.length > 0) {
    throw new Error(
      `Unable to map prerelease identifier (in: ${assemblyVersion}) components to ruby: ${inspect(
        version.prerelease,
      )}. The format should be 'X.Y.Z-[label.sequence][.post.sequence][.(dev|pre).sequence]', where sequence is a positive integer and label is one of ${inspect(
        Object.keys(RUBY_RELEASE_LABELS),
      )}. Validation errors encountered: ${validationErrors.join(', ')}`,
    );
  }

  const prereleaseVersion = [
    preReleaseIdx > -1
      ? `${RUBY_RELEASE_LABELS[version.prerelease[preReleaseIdx]]}.${
          version.prerelease[preReleaseIdx + 1] ?? 0
        }`
      : undefined,
    postIdx > -1 ? `post.${version.prerelease[postIdx + 1] ?? 0}` : undefined,
    devIdx > -1
      ? `${version.prerelease[devIdx]}.${version.prerelease[devIdx + 1] ?? 0}`
      : undefined,
  ]
    .filter((v) => v)
    .join('.');

  if (prereleaseVersion) {
    return `${baseRuby}.${prereleaseVersion}`;
  }

  throw new Error(
    `Unable to map prerelease identifier (in: ${assemblyVersion}) components to ruby. The format should be 'X.Y.Z-[label.sequence][.post.sequence][.(dev|pre).sequence]'.`,
  );
}
