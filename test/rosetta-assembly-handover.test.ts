import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { registerRosettaLanguage } from '../src/rosetta/register';
import { resetTypeOracle, rubyPathForTypeName } from '../src/type-oracle';

/**
 * Receiving the assemblies from rosetta rather than from the environment.
 *
 * Rosetta translates in worker threads that never run the generator, so the
 * assembly a snippet is documenting had to reach the visitor another way. That
 * used to be `JSII_RUBY_ORACLE_ASSEMBLIES`, a side channel this plugin invented
 * for itself; rosetta now hands registered languages their assembly locations
 * (`VisitorFactory.prepare`), which is the same information through a contract
 * instead of an environment variable.
 */
describe('assemblies handed over by rosetta', () => {
  const OVERLAY = path.resolve(__dirname, '..', '..', 'config', 'cdk-targets.json');
  let assemblyDir: string;

  before(() => {
    process.env.JSII_RUBY_TARGET_CONFIG = OVERLAY;
    // A package directory as rosetta would name it: a `.jsii` at its root.
    assemblyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-'));
    fs.writeFileSync(
      path.join(assemblyDir, '.jsii'),
      JSON.stringify({
        name: 'aws-cdk-lib',
        version: '2.0.0',
        schema: 'jsii/0.10.0',
        submodules: { 'aws-cdk-lib.aws_kinesisfirehose': {} },
        types: {
          'aws-cdk-lib.aws_kinesisfirehose.DeliveryStream': { kind: 'class' },
        },
      }),
    );
    resetTypeOracle();
  });
  after(() => {
    delete process.env.JSII_RUBY_TARGET_CONFIG;
    resetTypeOracle();
  });

  /** The factory this plugin registers with rosetta. */
  function registeredFactory(): any {
    registerRosettaLanguage();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const registry = require('jsii-rosetta/lib/languages/index');
    return registry.visitorFactoryFor('ruby');
  }

  test('the plugin offers rosetta somewhere to hand them over', () => {
    assert.equal(
      typeof registeredFactory().prepare,
      'function',
      'the registered language has no prepare hook, so rosetta cannot tell it anything',
    );
  });

  test('a handed-over assembly is indexed', () => {
    // Nothing known before; the type resolves once rosetta hands the location
    // over — which is what a worker thread does before translating.
    assert.equal(rubyPathForTypeName('DeliveryStream'), undefined);
    registeredFactory().prepare({ assemblyLocations: [assemblyDir] });
    assert.equal(rubyPathForTypeName('DeliveryStream'), 'AWSCDK::KinesisFirehose::DeliveryStream');
  });

  test('being told twice is harmless', () => {
    // A worker handles many batches, so prepare is called repeatedly.
    const factory = registeredFactory();
    factory.prepare({ assemblyLocations: [assemblyDir] });
    factory.prepare({ assemblyLocations: [assemblyDir] });
    assert.equal(rubyPathForTypeName('DeliveryStream'), 'AWSCDK::KinesisFirehose::DeliveryStream');
  });

  test('an unreadable location does not fail the translation', () => {
    // An assembly we cannot read costs the rendering we would have produced
    // anyway; failing the whole extract over it would be worse.
    assert.doesNotThrow(() =>
      registeredFactory().prepare({ assemblyLocations: [path.join(assemblyDir, 'nope')] }),
    );
  });

  test('no assemblies at all is fine', () => {
    assert.doesNotThrow(() => registeredFactory().prepare({ assemblyLocations: [] }));
  });
});
