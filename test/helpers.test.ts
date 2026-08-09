import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  assemblyAcronyms,
  dedupByRubyName,
  dedupCrossCategory,
  escapeRegExp,
  isDeprecated,
  rubyConstName,
  rubyJsonLiteral,
  rubyModuleName,
  rubyName,
  rubySq,
  toScreamingSnakeCase,
} from '../src/helpers';

// The generator-level behavior of rubyModuleName/rubyName/dedupCrossCategory
// (default acronyms, delegate wiring) is covered by ruby-names.test.ts; these
// tests pin the pure functions directly.

describe('toScreamingSnakeCase', () => {
  test('camelCase -> SCREAMING_SNAKE', () => {
    assert.equal(toScreamingSnakeCase('kmsManaged'), 'KMS_MANAGED');
    assert.equal(toScreamingSnakeCase('someValue'), 'SOME_VALUE');
  });

  test('non-constant characters collapse to underscores', () => {
    assert.equal(toScreamingSnakeCase('foo-bar.baz'), 'FOO_BAR_BAZ');
  });
});

describe('rubyConstName', () => {
  test('enum members become constants', () => {
    assert.equal(rubyConstName('kmsManaged'), 'KMS_MANAGED');
  });

  test('digit-leading members get the V_ prefix', () => {
    assert.equal(rubyConstName('123'), 'V_123');
  });
});

describe('rubySq', () => {
  test('escapes backslashes and single quotes, nothing else', () => {
    assert.equal(rubySq("it's a \\ path"), "it\\'s a \\\\ path");
    assert.equal(rubySq('plain #{not interpolated} "text"'), 'plain #{not interpolated} "text"');
  });
});

describe('escapeRegExp', () => {
  test('escapes every RegExp metacharacter', () => {
    const meta = '.*+?^${}()|[]\\';
    const escaped = escapeRegExp(meta);
    assert.ok(new RegExp(escaped).test(meta));
    assert.equal(new RegExp(`^${escaped}$`).test(meta), true);
  });
});

describe('rubyJsonLiteral', () => {
  function roundTrip(value: unknown): unknown {
    const expr = rubyJsonLiteral(value);
    const m = /^JSON\.parse\(Base64\.strict_decode64\("([A-Za-z0-9+/=]+)"\)\)$/.exec(expr);
    assert.ok(m, `unexpected literal shape: ${expr}`);
    return JSON.parse(Buffer.from(m![1], 'base64').toString('utf-8'));
  }

  test('round-trips hostile strings (backslashes, quotes, interpolation)', () => {
    const value = { fqn: 'a\\b', note: `quote " and '`, interp: '#{boom}' };
    assert.deepEqual(roundTrip(value), value);
  });

  test('nullish input falls back to the any-typed reference', () => {
    assert.deepEqual(roundTrip(undefined), { primitive: 'any' });
  });
});

describe('isDeprecated', () => {
  test('accepts both reflect (boolean) and spec (string reason) shapes', () => {
    assert.equal(isDeprecated({ docs: { deprecated: true } }), true);
    assert.equal(isDeprecated({ docs: { deprecated: 'use other' } }), true);
    assert.equal(isDeprecated({ docs: { deprecated: undefined } }), false);
    assert.equal(isDeprecated({}), false);
  });
});

describe('rubyName (pure form)', () => {
  test('snake_cases and escapes the three reserved classes', () => {
    assert.equal(rubyName('fooBar'), 'foo_bar');
    assert.equal(rubyName('class'), '_class');
    assert.equal(rubyName('jsiiRef'), '_jsii_ref');
    assert.equal(rubyName('2fa'), '_2fa');
  });
});

describe('rubyModuleName (pure form)', () => {
  test('no default acronyms: casing is exactly what the caller supplies', () => {
    // The generator delegate defaults to the assembly's list; the pure
    // function must not invent one.
    assert.equal(rubyModuleName('vpcEndpoint'), 'VpcEndpoint');
    assert.equal(rubyModuleName('vpcEndpoint', ['VPC']), 'VPCEndpoint');
  });
});

describe('assemblyAcronyms', () => {
  test('filters blanks and non-strings; tolerates absent config', () => {
    assert.deepEqual(
      assemblyAcronyms({ targets: { ruby: { acronyms: ['', 'VPC', 42, 'S3'] } } } as any),
      ['VPC', 'S3'],
    );
    assert.deepEqual(assemblyAcronyms(undefined), []);
    assert.deepEqual(assemblyAcronyms({}), []);
  });
});

describe('dedupByRubyName', () => {
  const byName = (m: { name: string }) => rubyName(m.name);

  test('passes through non-colliding members in order', () => {
    const members = [{ name: 'a' }, { name: 'b' }];
    assert.deepEqual(dedupByRubyName(members, byName, 'test.T'), members);
  });

  test('deprecation picks the single winner', () => {
    const keep = { name: 'foo_bar' };
    const drop = { name: 'fooBar', docs: { deprecated: 'x' } };
    assert.deepEqual(dedupByRubyName([drop, keep], byName, 'test.T'), [keep]);
  });

  test('throws when all colliding members are deprecated', () => {
    assert.throws(
      () =>
        dedupByRubyName(
          [
            { name: 'fooBar', docs: { deprecated: 'x' } },
            { name: 'foo_bar', docs: { deprecated: 'y' } },
          ],
          byName,
          'test.T',
        ),
      /cannot pick a winner/,
    );
  });

  test('throws when multiple non-deprecated members collide', () => {
    assert.throws(
      () => dedupByRubyName([{ name: 'fooBar' }, { name: 'foo_bar' }], byName, 'test.T'),
      /Multiple non-deprecated members/,
    );
  });
});

describe('dedupCrossCategory (pure form)', () => {
  const byName = (m: { name: string }) => rubyName(m.name);

  test('statics and instance members never collide across categories', () => {
    const props = [{ name: 'value', static: true }];
    const methods = [{ name: 'value' }];
    assert.deepEqual(dedupCrossCategory(props, methods, byName, byName, 'test.T'), {
      props,
      methods,
    });
  });
});

describe('isDeprecated — own docs, not the parent type\'s', () => {
  // jsii-reflect's Docs#deprecated is inherited: every member of a deprecated
  // type reports true. isDeprecated drives the collision passes, so with the
  // inherited value a name collision INSIDE a deprecated type makes every
  // candidate look deprecated and generation aborts with "cannot pick a
  // winner" instead of choosing one.
  test('prefers the member\'s own spec docs over the inherited reflect view', () => {
    const member = {
      name: 'foo',
      spec: { docs: { summary: 'not deprecated itself' } },
      docs: { deprecated: true }, // reflect's inherited view
    };
    assert.equal(isDeprecated(member as any), false);
  });

  test('still reports a member deprecated in its own right', () => {
    assert.equal(
      isDeprecated({ name: 'foo', spec: { docs: { deprecated: 'use bar' } } } as any),
      true,
    );
  });

  test('falls back to the reflect view when there are no spec docs', () => {
    // Enum members have no `.spec`, so the reflect Docs instance is all there is.
    assert.equal(isDeprecated({ name: 'foo', docs: { deprecated: true } } as any), true);
  });
});
