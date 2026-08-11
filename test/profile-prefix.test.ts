import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { translateTypeScript } from 'jsii-rosetta/lib/translate';

import { RubyVisitor } from '../src/rosetta/ruby-visitor';
import { resetTypeOracle } from '../src/type-oracle';

/**
 * The submodule prefix is the profile's to declare, not the target's to know.
 *
 * Alias resolution strips a vendor prefix from a submodule name so an import
 * alias can be matched against it — `iam` against `aws_iam`. That prefix was
 * hardcoded as `aws_`, which is knowledge about one library sitting inside a
 * target that is supposed to take whatever profile it is handed.
 *
 * Deliberately no assembly is registered here: with one, the type-name
 * fallback resolves these references anyway and the prefix rule is never
 * exercised — a green test that proves nothing. Alias resolution is the only
 * route left open, so these fail if and only if the prefix is not the
 * profile's.
 */
function toRuby(source: string): string {
  return translateTypeScript({ contents: source, fileName: 'test.ts' }, new RubyVisitor()).translation;
}

describe('the submodule prefix comes from the profile', () => {
  const PROFILE = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'profile.json');

  before(() => {
    process.env.JSII_RUBY_TARGET_CONFIG = PROFILE;
    resetTypeOracle();
  });
  after(() => {
    delete process.env.JSII_RUBY_TARGET_CONFIG;
    resetTypeOracle();
  });

  test('an alias matching the prefix-stripped submodule resolves', () => {
    // `storage` is `acme_storage` less the profile's prefix — the same
    // relationship `s3` has to `aws_s3`, which is all the rule ever meant.
    assert.match(toRuby("new storage.Bucket(this, 'B');"), /ACME::Storage::Bucket/);
  });

  test('the full submodule name still resolves', () => {
    assert.match(toRuby("new acme_storage.Bucket(this, 'B');"), /ACME::Storage::Bucket/);
  });

  test('acronyms from the profile apply to the type name', () => {
    assert.match(toRuby("new identity.RoleId(this, 'R');"), /ACME::Identity::RoleID/);
  });

  test('a multi-word submodule resolves through its trailing word', () => {
    assert.match(
      toRuby("new tasks.RunJob(this, 'J');"),
      /ACME::WorkflowsTasks::RunJob/,
    );
  });

  test('an alias naming no submodule is left alone', () => {
    const ruby = toRuby('new widgets.Thing();');
    assert.ok(!/ACME::/.test(ruby), `invented a module:\n${ruby}`);
  });
});
