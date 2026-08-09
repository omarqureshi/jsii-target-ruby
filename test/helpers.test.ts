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
  acronymRegExpCacheSize,
  modulePrefixes,
  namespacePrefixes,
  rubyCallParams,
  rubyName,
  rubySignatureParams,
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
    const m = /^"([A-Za-z0-9+/=]+)"$/.exec(expr);
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

describe('rubyModuleName performance', () => {
  // Every type reference resolves through this function, and aws-cdk-lib
  // declares 53 acronyms — compiling a fresh RegExp per acronym per call put
  // ~53 RegExp compilations on the hottest path in generation.
  test('is fast enough for whole-closure generation', () => {
    const acronyms = [
      'ACM', 'ALB', 'API', 'APS', 'ARN', 'AWS', 'CDK', 'CE', 'CIDR', 'CUR',
      'DAX', 'DB', 'DLM', 'DMS', 'DNS', 'DSQL', 'EC2', 'ECR', 'ECS', 'EFS',
      'EKS', 'ELB', 'EMR', 'FIS', 'FMS', 'FSX', 'IAM', 'IP', 'IVS', 'KMS',
      'MSK', 'MWAA', 'NLB', 'OAM', 'PCS', 'QLDB', 'RAM', 'RDS', 'RUM', 'S3',
      'SAM', 'SES', 'SNS', 'SQS', 'SSL', 'SSM', 'TCP', 'TLS', 'UDP', 'URI',
      'URL', 'VPC', 'WAF',
    ];

    // Acronyms unique to this test, so the shared cache's other entries do
    // not skew the count. Only two of them appear in the names below.
    const unique = acronyms.map((a) => `ZZ${a}`);
    const present = ['ZZACM', 'ZZVPC'];
    const matching = [`zzacmThing`, `zzvpcEndpoint`, 'someLongServiceName'];
    const before = acronymRegExpCacheSize();

    const started = Date.now();
    for (let i = 0; i < 20_000; i++) {
      rubyModuleName(matching[i % matching.length], unique);
    }
    const elapsed = Date.now() - started;

    // Two invariants, neither of them a stopwatch. One compiled RegExp per
    // distinct acronym for the whole run rather than per call (which would be
    // 20,000 x 53), and none at all for the 51 acronyms the lowercase
    // pre-filter rules out before reaching the RegExp.
    assert.equal(
      acronymRegExpCacheSize() - before,
      present.length,
      'expected a compiled RegExp only for acronyms that actually occur',
    );

    // A loose backstop against a regression in kind. Pre-fix this took
    // ~420ms and now takes ~100ms; 1s leaves enough headroom that machine
    // noise cannot trip it, which the old 150ms budget did not.
    assert.ok(elapsed < 1_000, `20k conversions took ${elapsed}ms`);
  });

  test('caching does not change results', () => {
    assert.equal(rubyModuleName('awsS3Bucket', ['AWS', 'S3']), 'AWSS3Bucket');
    assert.equal(rubyModuleName('awsS3Bucket', []), 'AwsS3Bucket');
    assert.equal(rubyModuleName('awsS3Bucket', ['AWS']), 'AWSS3Bucket');
  });
});

describe('rubyJsonLiteral emits an encoded spec, not an inline decode', () => {
  test('is a bare base64 string literal', () => {
    // Emitting `JSON.parse(Base64.strict_decode64("..."))` put a decode and a
    // parse on EVERY type-checked argument of every call at runtime. The
    // runtime now decodes and caches (Jsii::Type.decode_type_ref), so the
    // call site only needs the encoded payload.
    const literal = rubyJsonLiteral({ primitive: 'string' });
    assert.match(literal, /^"[A-Za-z0-9+/=]+"$/, `unexpected literal: ${literal}`);
    assert.ok(!literal.includes('JSON.parse'), 'inline decode survived');

    const decoded = JSON.parse(Buffer.from(literal.slice(1, -1), 'base64').toString('utf-8'));
    assert.deepEqual(decoded, { primitive: 'string' });
  });
});

describe('parameter rendering', () => {
  const params = [
    { name: 'requiredThing' },
    { name: 'maybeThing', optional: true },
    { name: 'restThings', variadic: true },
  ];

  test('signature params: variadic splats, optional defaults to nil', () => {
    assert.equal(
      rubySignatureParams(params),
      'required_thing, maybe_thing = nil, *rest_things',
    );
  });

  test('call params: variadic splats, no defaults', () => {
    assert.equal(rubyCallParams(params), 'required_thing, maybe_thing, *rest_things');
  });

  test('reserved names are escaped in both forms', () => {
    assert.equal(rubySignatureParams([{ name: 'class' }]), '_class');
    assert.equal(rubyCallParams([{ name: 'class' }]), '_class');
  });
});

describe('module path prefixes', () => {
  test('modulePrefixes walks a path from outermost to innermost', () => {
    assert.deepEqual(modulePrefixes('A::B::C'), ['A', 'A::B', 'A::B::C']);
    assert.deepEqual(modulePrefixes('Solo'), ['Solo']);
    assert.deepEqual(modulePrefixes(''), []);
  });

  test('namespacePrefixes dedups across paths and orders shallowest first', () => {
    assert.deepEqual(
      namespacePrefixes(['A::B::C', 'A::D']),
      ['A', 'A::B', 'A::D', 'A::B::C'],
    );
  });

  test('namespacePrefixes preserves first-seen order within a depth', () => {
    assert.deepEqual(namespacePrefixes(['Z::Q', 'A::Q']), ['Z', 'A', 'Z::Q', 'A::Q']);
  });

  test('excluded prefixes are skipped without pruning deeper ones', () => {
    // A fragment that collides with a class name must not be re-declared as a
    // module, but its children still need declaring.
    assert.deepEqual(
      namespacePrefixes(['A::B::C'], new Set(['A::B'])),
      ['A', 'A::B::C'],
    );
  });
});
