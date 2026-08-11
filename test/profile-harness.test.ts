import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';

import { profileHarness } from '../src/testing';

/**
 * The harness a profile owner tests through.
 *
 * A profile — the naming a library gets in Ruby — is data this target knows
 * nothing about, and its correctness is a question about that library: does
 * `aws_s3` render as `AWSCDK::S3`, does the alias `firehose` reach
 * `aws_kinesisfirehose`, has a new submodule appeared with nobody naming it?
 * Those belong with the profile, in whatever repository publishes it. What the
 * target owes them is a way to ask, without reimplementing generation.
 *
 * This mirrors what rosetta does for us one level up: it publishes its corpus
 * behind `lib/testing` so an external language can check itself against it.
 *
 * Exercised here against a fabricated library, because the target must not
 * need a real one to prove the harness works.
 */
const PROFILE = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'profile.json');

/** A package directory holding just enough assembly for the harness to read. */
function assemblyDir(types: Record<string, unknown>, submodules: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-harness-'));
  fs.writeFileSync(
    path.join(dir, '.jsii'),
    JSON.stringify({
      name: 'acme-lib',
      version: '1.0.0',
      schema: 'jsii/0.10.0',
      submodules: Object.fromEntries(submodules.map((s) => [s, {}])),
      types,
    }),
  );
  return dir;
}

describe('profile harness', () => {
  const created: Array<{ dispose(): void }> = [];
  after(() => created.forEach((h) => h.dispose()));

  function harness(opts: Parameters<typeof profileHarness>[0]) {
    const h = profileHarness(opts);
    created.push(h);
    return h;
  }

  test('answers what Ruby module a jsii fqn is generated as', () => {
    const h = harness({ profile: PROFILE });
    assert.equal(h.modulePathFor('acme-lib'), 'ACME');
    assert.equal(h.modulePathFor('acme-lib.acme_storage'), 'ACME::Storage');
    assert.equal(h.modulePathFor('acme-lib.acme_db'), 'ACME::DB');
  });

  test('derives a name for an assembly the profile says nothing about', () => {
    // Not an error: an unnamed library still generates, just generically.
    const h = harness({ profile: PROFILE });
    assert.equal(h.modulePathFor('other-lib'), 'OtherLib');
  });

  test('renders a snippet the way the docs pipeline would', () => {
    const h = harness({ profile: PROFILE });
    assert.match(h.render("new storage.Bucket(this, 'B');"), /ACME::Storage::Bucket\.new/);
  });

  test('resolves through an assembly when given one', () => {
    // `flow` resembles no submodule, so only the assembly can place the type.
    const h = harness({
      profile: PROFILE,
      assemblies: [
        assemblyDir({ 'acme-lib.acme_streamflow.DeliveryStream': { kind: 'class' } }, [
          'acme-lib.acme_streamflow',
        ]),
      ],
    });
    assert.match(
      h.render("new flow.DeliveryStream(this, 'S');"),
      /ACME::StreamFlow::DeliveryStream/,
    );
  });

  test('reports submodules the profile has not named', () => {
    // The drift check: a library release adds a submodule, and until someone
    // names it, it renders as a derived guess that becomes public API.
    const h = harness({
      profile: PROFILE,
      assemblies: [
        assemblyDir({}, ['acme-lib.acme_storage', 'acme-lib.acme_brandnew']),
      ],
    });
    assert.deepEqual(h.unnamedSubmodules(), ['acme-lib.acme_brandnew']);
  });

  test('reports nothing when every submodule is named', () => {
    const h = harness({
      profile: PROFILE,
      assemblies: [assemblyDir({}, ['acme-lib.acme_storage', 'acme-lib.acme_db'])],
    });
    assert.deepEqual(h.unnamedSubmodules(), []);
  });

  test('leaves the environment as it found it', () => {
    // The overlay is read from the environment, so a harness that did not put
    // it back would silently change how every later test in the process
    // renders.
    const before = process.env.JSII_RUBY_TARGET_CONFIG;
    const h = profileHarness({ profile: PROFILE });
    assert.equal(process.env.JSII_RUBY_TARGET_CONFIG, PROFILE);
    h.dispose();
    assert.equal(process.env.JSII_RUBY_TARGET_CONFIG, before);
  });
});
