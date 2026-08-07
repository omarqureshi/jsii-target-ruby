import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { toRubyReleaseVersion, toRubyVersionRange } from '../src/version-utils';

// Same table as jsii-pacmak's version-utils tests, restricted to the Ruby
// column — the other columns live upstream with their targets.
const rangeExamples: Record<string, string> = {
  // Regular versions, "classic" ranges
  '1.2.3': "'= 1.2.3'",
  '~1.2.3': "'>= 1.2.3', '< 1.3.0'",
  '^1.2.3': "'>= 1.2.3', '< 2.0.0'",

  // Pre-1.0 versions, "classic" ranges
  '0.1.2': "'= 0.1.2'",
  '~0.1.2': "'>= 0.1.2', '< 0.2.0'",
  '^0.1.2': "'>= 0.1.2', '< 0.2.0'",

  // Less usual ranges
  '>0.1.2': "'> 0.1.2'",
  '>=0.1.2': "'>= 0.1.2'",
  '<0.1.2': "'< 0.1.2'",
  '<=0.1.2': "'<= 0.1.2'",

  // Somewhat unusual ranges
  '*': "'>= 0.0.0'",
  '1.2.*': "'>= 1.2.0', '< 1.3.0'",
  '1.*': "'>= 1.0.0', '< 2.0.0'",
};

describe('toRubyVersionRange', () => {
  for (const [semver, ruby] of Object.entries(rangeExamples)) {
    test(`${semver} translates to ${ruby}`, () => {
      assert.equal(toRubyVersionRange(semver), ruby);
    });
  }

  test('handles OR conditions (multiple sets)', () => {
    assert.throws(
      () => toRubyVersionRange('>=1.0.0 <2.0.0 || >=3.0.0 <4.0.0'),
      /RubyGems does not support OR \(\|\|\) requirements natively/,
    );
  });
});

describe('toRubyReleaseVersion', () => {
  const examples: Record<string, string | RegExp> = {
    '1.2.3': '1.2.3',
    '1.2.3-pre':
      /Unable to map prerelease identifier \(in: 1\.2\.3-pre\) components to ruby: \[ 'pre' \]/,
    '1.2.3-dev.123.0+abc123.foo.bar': '1.2.3.dev.123',
    '1.2.3-alpha.1337': '1.2.3.alpha.1337',
    '1.2.3-beta.42': '1.2.3.beta.42',
    '1.2.3-rc.9': '1.2.3.rc.9',
    '1.2.3-rc.123.post.456.dev.789': '1.2.3.rc.123.post.456.dev.789',
    '1.2.3-rc.alpha':
      /Unable to map prerelease identifier \(in: 1.2.3-rc.alpha\) components to ruby: \[ 'rc', 'alpha' \]/,
    '1.2.3-rc.0': /Label rc must be followed by a positive integer/,
  };

  for (const [version, expected] of Object.entries(examples)) {
    test(`"${version}" translation`, () => {
      if (typeof expected === 'string') {
        assert.equal(toRubyReleaseVersion(version), expected);
      } else {
        assert.throws(() => toRubyReleaseVersion(version), expected);
      }
    });
  }

  test('rejects multiple prerelease labels of the same or different categories', () => {
    assert.throws(
      () => toRubyReleaseVersion('1.2.3-alpha.1.rc.2'),
      /Contains multiple or unmappable prerelease labels/,
    );
    assert.throws(
      () => toRubyReleaseVersion('1.2.3-alpha.1.alpha.2'),
      /Contains multiple or unmappable prerelease labels/,
    );
  });
});
