import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { findRubyName, guessRubyModuleName, rubyModuleName, toSnakeCase } from '../src/rosetta/ruby-visitor';

describe('toSnakeCase', () => {
  const cases: Array<[string, string]> = [
    // Plain camelCase
    ['foo', 'foo'],
    ['someMethod', 'some_method'],
    ['arnValue', 'arn_value'],
    // Single characters / digits
    ['x', 'x'],
    ['getX', 'get_x'],
    // Consecutive uppercase (acronyms) collapse correctly
    ['enforceSSL', 'enforce_ssl'],
    ['myVPCId', 'my_vpc_id'],
    ['parseJSON', 'parse_json'],
    ['toJSON', 'to_json'],
    ['ec2InstanceId', 'ec2_instance_id'],
    ['x509Certificate', 'x509_certificate'],
    ['fromHTTPSToJSON', 'from_https_to_json'],
    // Already snake_case is left alone
    ['already_snake', 'already_snake'],
    // Leading underscore is preserved
    ['_privateField', '_private_field'],
  ];
  for (const [input, expected] of cases) {
    test(`converts ${input} -> ${expected}`, () => {
      assert.equal(toSnakeCase(input), expected);
    });
  }

  test('leaves PascalCase (class-like) names untouched', () => {
    assert.equal(toSnakeCase('MyClass'), 'MyClass');
    assert.equal(toSnakeCase('Bucket'), 'Bucket');
  });

  for (const word of ['end', 'class', 'def', 'begin', 'send', 'next', 'retry']) {
    test(`escapes reserved word ${word} with a leading underscore`, () => {
      assert.equal(toSnakeCase(word), `_${word}`);
    });
  }
});

describe('rubyModuleName', () => {
  const cases: Array<[string, string]> = [
    // Simple names get PascalCased
    ['core', 'Core'],
    ['submodule', 'Submodule'],
    ['foo', 'Foo'],
    ['child', 'Child'],
    ['homonymousForwardReferences', 'HomonymousForwardReferences'],
    // Hyphenated package names become a single concatenated module
    ['jsii-calc', 'JsiiCalc'],
    // Without declared acronyms there is no acronym knowledge: plain PascalCase.
    // Acronym casing is library data (`targets.ruby.acronyms` in the assembly),
    // not something this visitor knows on its own.
    ['s3', 'S3'], // single letter + digit pascals to S3 with no list involved
    ['vpc', 'Vpc'],
    ['iam', 'Iam'],
    ['aws', 'Aws'],
  ];
  for (const [input, expected] of cases) {
    test(`formats ${input} -> ${expected}`, () => {
      assert.equal(rubyModuleName(input), expected);
    });
  }

  test('handles scoped package names (@scope/name)', () => {
    assert.equal(rubyModuleName('@aws-cdk/core', ['AWS', 'CDK']), 'AWSCDK::Core');
    assert.equal(rubyModuleName('@aws-cdk/core'), 'AwsCdk::Core');
  });

  test('declared acronyms are authoritative — the mechanism, with test-owned data', () => {
    // Any caller-declared acronym is honoured...
    assert.equal(rubyModuleName('myFoo', ['FOO']), 'MyFOO');
    assert.equal(rubyModuleName('vpc', ['VPC']), 'VPC');
    // ...and an undeclared one has no effect, because there is no built-in list.
    assert.equal(rubyModuleName('vpc', ['FOO']), 'Vpc');
    // Duplicated declarations are applied once, not twice.
    assert.equal(rubyModuleName('vpc', ['VPC', 'VPC']), 'VPC');
  });

  test('short acronyms do not over-match inside unrelated words', () => {
    assert.equal(rubyModuleName('certificate', ['CE']), 'Certificate');
    assert.equal(rubyModuleName('database', ['DB']), 'Database');
    assert.equal(rubyModuleName('ramp', ['RAM']), 'Ramp');
  });
});

describe('guessRubyModuleName', () => {
  // Unresolved references resolve against the profile — the same naming data
  // generation uses. The names below come from a fabricated library's profile,
  // not from code and not from any real vendor: what a particular library is
  // called in Ruby is that library's question, asked where its profile lives.
  const OVERLAY = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'profile.json');
  before(() => {
    process.env.JSII_RUBY_TARGET_CONFIG = OVERLAY;
  });
  after(() => {
    delete process.env.JSII_RUBY_TARGET_CONFIG;
  });

  const cases: Array<[string, string]> = [
    ['acme-lib', 'ACME'],
    ['acme-lib.acme_storage', 'ACME::Storage'],
    // The profile knows the real casing — a generic guess would say Db.
    ['acme-lib.acme_db', 'ACME::DB'],
    // A submodule with no vendor prefix at all.
    ['acme-lib.pipelines', 'ACME::Pipelines'],
    // Assemblies without an overlay entry derive generically, with
    // submodules nested via `::`.
    ['jsii-calc', 'JsiiCalc'],
    ['jsii-calc.submodule', 'JsiiCalc::Submodule'],
  ];
  for (const [input, expected] of cases) {
    test(`guesses ${input} -> ${expected}`, () => {
      assert.equal(guessRubyModuleName(input), expected);
    });
  }
});

describe('findRubyName', () => {
  // The path taken when rosetta HAS assembly metadata for a symbol. Published
  // assemblies generally carry no `targets.ruby` — that is exactly what the
  // profile supplies — so reading only the assembly's own targets drops the
  // root module and emits examples that raise NameError when pasted.
  const OVERLAY = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'profile.json');
  before(() => {
    process.env.JSII_RUBY_TARGET_CONFIG = OVERLAY;
  });
  after(() => {
    delete process.env.JSII_RUBY_TARGET_CONFIG;
  });

  /** A symbol as rosetta hands it over, for an assembly with no ruby target. */
  function symbolFor(fqn: string, submodules: string[] = []): any {
    return {
      fqn,
      symbolType: 'class',
      sourceAssembly: {
        assembly: {
          name: fqn.split('.')[0],
          submodules: Object.fromEntries(submodules.map((s) => [s, {}])),
        },
      },
    };
  }

  test('qualifies a submodule type with the overlay root module', () => {
    assert.equal(
      findRubyName(symbolFor('acme-lib.acme_storage.Bucket', ['acme-lib.acme_storage'])),
      'ACME::Storage::Bucket',
    );
  });

  test('uses the overlay acronym casing, not a generic derivation', () => {
    // Acronym restoration applies to the type name too: the generator emits
    // `class ACME::Identity::RoleID`, so an example naming `RoleId` would
    // reference a constant that does not exist.
    assert.equal(
      findRubyName(symbolFor('acme-lib.acme_identity.RoleId', ['acme-lib.acme_identity'])),
      'ACME::Identity::RoleID',
    );
  });

  test('qualifies a root type too', () => {
    assert.equal(findRubyName(symbolFor('acme-lib.Stack')), 'ACME::Stack');
  });

  test("uses the assembly's own ruby target when the overlay has no entry", () => {
    const sym = symbolFor('my-lib.Thing');
    sym.sourceAssembly.assembly.targets = { ruby: { module: 'MyLib' } };
    assert.equal(findRubyName(sym), 'MyLib::Thing');
  });

  test('an assembly with neither overlay nor target derives generically', () => {
    assert.equal(findRubyName(symbolFor('jsii-calc.Calculator')), 'JsiiCalc::Calculator');
  });
});
