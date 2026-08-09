import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { guessRubyModuleName, rubyModuleName, toSnakeCase } from '../src/rosetta/ruby-visitor';

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
  // Unresolved references resolve against the target-config overlay — the
  // same naming data generation uses. The CDK names below come from
  // config/cdk-targets.json, not from code.
  const OVERLAY = path.resolve(__dirname, '..', '..', 'config', 'cdk-targets.json');
  before(() => {
    process.env.JSII_RUBY_TARGET_CONFIG = OVERLAY;
  });
  after(() => {
    delete process.env.JSII_RUBY_TARGET_CONFIG;
  });

  const cases: Array<[string, string]> = [
    ['aws-cdk-lib', 'AWSCDK'],
    ['aws-cdk-lib.aws_s3', 'AWSCDK::S3'],
    // The overlay knows the real casing — the old hardcoded guess said Ec2.
    ['aws-cdk-lib.aws_ec2', 'AWSCDK::EC2'],
    ['aws-cdk-lib.pipelines', 'AWSCDK::Pipelines'],
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
