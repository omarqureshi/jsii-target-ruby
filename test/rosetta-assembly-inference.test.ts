import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { translateTypeScript } from 'jsii-rosetta/lib/translate';

import { RubyVisitor } from '../src/rosetta/ruby-visitor';
import { registerAssemblyTypes, resetTypeOracle } from '../src/type-oracle';

/**
 * Resolving a reference through the assembly's own type names.
 *
 * Qualifying by import alias only reaches aliases that look like the submodule
 * they name (`iam` -> `aws_iam`). CDK's conventional aliases frequently do not:
 * `firehose` is `aws_kinesisfirehose`, `sfn` is `aws_stepfunctions`, `tasks` is
 * `aws_stepfunctions_tasks`. Those references came out with no root module at
 * all (`Firehose::DeliveryStream`), and — because the module was unknown — the
 * assembly could not be asked whether a SCREAMING_SNAKE member was an enum
 * constant or a class method either, so they took `::` on a method as well.
 *
 * The type name is the way in: the assembly indexes every type it declares, so
 * an unresolvable alias can still be answered by asking where `DeliveryStream`
 * lives.
 */
function toRuby(source: string): string {
  return translateTypeScript({ contents: source, fileName: 'test.ts' }, new RubyVisitor()).translation;
}

describe('references whose alias names no submodule', () => {
  const OVERLAY = path.resolve(__dirname, '..', '..', 'config', 'cdk-targets.json');

  before(() => {
    process.env.JSII_RUBY_TARGET_CONFIG = OVERLAY;
    registerAssemblyTypes({
      name: 'aws-cdk-lib',
      submodules: {
        'aws-cdk-lib.aws_kinesisfirehose': {},
        'aws-cdk-lib.aws_stepfunctions': {},
        'aws-cdk-lib.aws_stepfunctions_tasks': {},
        'aws-cdk-lib.aws_opensearchservice': {},
        'aws-cdk-lib.aws_rds': {},
        'aws-cdk-lib.aws_applicationautoscaling': {},
        'aws-cdk-lib.aws_events': {},
        'aws-cdk-lib.assertions': {},
      },
      types: {
        'aws-cdk-lib.Duration': { kind: 'class' },
        'aws-cdk-lib.aws_kinesisfirehose.DeliveryStream': { kind: 'class' },
        'aws-cdk-lib.aws_kinesisfirehose.Compression': { kind: 'enum' },
        'aws-cdk-lib.aws_stepfunctions.StateMachine': { kind: 'class' },
        'aws-cdk-lib.aws_stepfunctions_tasks.EmrCreateCluster': { kind: 'class' },
        // Named by two submodules: only the alias can say which is meant.
        'aws-cdk-lib.aws_opensearchservice.EngineVersion': { kind: 'class' },
        'aws-cdk-lib.aws_rds.EngineVersion': { kind: 'class' },
        // Named by two submodules that neither alias below resembles.
        'aws-cdk-lib.aws_applicationautoscaling.Schedule': { kind: 'class' },
        'aws-cdk-lib.aws_events.Schedule': { kind: 'class' },
        // A root-level type whose name a submodule also uses.
        'aws-cdk-lib.Tags': { kind: 'class' },
        'aws-cdk-lib.assertions.Tags': { kind: 'class' },
      },
    } as any);
  });
  after(() => {
    delete process.env.JSII_RUBY_TARGET_CONFIG;
    resetTypeOracle();
  });

  test('an alias unlike its submodule is resolved by the type name', () => {
    // `firehose` is `aws_kinesisfirehose`: no amount of alias munging gets
    // there, but the assembly declares exactly one `DeliveryStream`.
    const ruby = toRuby("new firehose.DeliveryStream(this, 'S');");
    assert.match(ruby, /AWSCDK::KinesisFirehose::DeliveryStream\.new/);
  });

  test('an abbreviated alias is resolved the same way', () => {
    assert.match(
      toRuby("new sfn.StateMachine(this, 'M');"),
      /AWSCDK::StepFunctions::StateMachine\.new/,
    );
  });

  test('a multi-word submodule is reached through its short alias', () => {
    // EMRCreateCluster, not EmrCreateCluster: the path comes from the same
    // acronym-aware mapper the generator names the class with, so the
    // reference cannot drift from the definition.
    assert.match(
      toRuby("new tasks.EmrCreateCluster(this, 'C');"),
      /AWSCDK::StepFunctionsTasks::EMRCreateCluster\.new/,
    );
  });

  test('a root-level type is qualified through an unknown alias', () => {
    assert.match(toRuby('const d = cdk.Duration.seconds(30);'), /AWSCDK::Duration\.seconds/);
  });

  test('an alias resembling the assembly picks the root-level type', () => {
    // `cdk` is the conventional alias for aws-cdk-lib itself, so `cdk.Tags`
    // means the root `Tags` and not `assertions.Tags`. The assembly name is
    // what says so — the same resemblance test the submodules get.
    const ruby = toRuby("cdk.Tags.of(stack).add('k', 'v');");
    assert.match(ruby, /AWSCDK::Tags\.of/);
    assert.ok(!/Assertions::Tags/.test(ruby), `resolved to the submodule type:\n${ruby}`);
  });

  test('the alias picks between submodules that declare the same type name', () => {
    // Both aws_opensearchservice and aws_rds declare EngineVersion; the alias
    // resembles only one of them.
    const ruby = toRuby('const v = opensearch.EngineVersion.OPENSEARCH_1_0;');
    assert.match(ruby, /AWSCDK::OpenSearchService::EngineVersion/);
    assert.ok(!/RDS::EngineVersion/.test(ruby), `resolved to the wrong submodule:\n${ruby}`);
  });

  test('an inferred module still separates a class method from its owner', () => {
    // The whole point of resolving the module: `EngineVersion` is a class with
    // static readonly members, generated as `def self.OPENSEARCH_1_0`, so
    // `EngineVersion::OPENSEARCH_1_0` raises NameError.
    const ruby = toRuby('const v = opensearch.EngineVersion.OPENSEARCH_1_0;');
    assert.match(ruby, /EngineVersion\.OPENSEARCH_1_0/);
    assert.ok(!/EngineVersion::OPENSEARCH_1_0/.test(ruby), `rendered as a constant:\n${ruby}`);
  });

  test('an enum reached through an inferred module keeps its constant', () => {
    const ruby = toRuby('const c = firehose.Compression.GZIP;');
    assert.match(ruby, /AWSCDK::KinesisFirehose::Compression::GZIP/);
  });

  test('a bare type name with no import is qualified', () => {
    // Selective imports live in fixtures the published package does not ship,
    // so the reference arrives with neither alias nor import.
    assert.match(toRuby("new DeliveryStream(this, 'S');"), /AWSCDK::KinesisFirehose::DeliveryStream/);
  });

  test("an ambiguous bare name is narrowed by the snippet's own imports", () => {
    // The published example imports opensearch and uses it, then names
    // `EngineVersion` bare because the import that would bind it lives in a
    // rosetta fixture the package does not ship. Both declarations of the name
    // are candidates, but only one is in a module this snippet is working in.
    const ruby = toRuby(
      [
        "import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';",
        'const version = EngineVersion.OPENSEARCH_1_3;',
      ].join('\n'),
    );
    assert.match(ruby, /AWSCDK::OpenSearchService::EngineVersion\.OPENSEARCH_1_3/);
  });

  test('imports do not narrow when more than one of them declares the name', () => {
    const ruby = toRuby(
      [
        "import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';",
        "import * as rds from 'aws-cdk-lib/aws-rds';",
        'const version = EngineVersion.MYSQL;',
      ].join('\n'),
    );
    assert.ok(!/AWSCDK::/.test(ruby), `guessed between two imported modules:\n${ruby}`);
  });

  test('an ambiguous type name the alias cannot narrow is left alone', () => {
    // Guessing between aws_applicationautoscaling and aws_events would be a
    // coin toss, and a wrong module is worse than an unqualified one.
    const ruby = toRuby('const s = appscaling.Schedule.rate(d);');
    assert.ok(!/AWSCDK::/.test(ruby), `guessed a module for an ambiguous name:\n${ruby}`);
  });

  test('a type name the assembly does not declare is left alone', () => {
    const ruby = toRuby('new widgets.Thing();');
    assert.match(ruby, /Widgets::Thing/);
    assert.ok(!/AWSCDK::/.test(ruby), `invented a module:\n${ruby}`);
  });

  test('a locally declared class is not replaced by a library type', () => {
    // A snippet that defines its own `Duration` means its own; rewriting the
    // reference to AWSCDK::Duration points it at a different class than the
    // one the snippet declares two lines up.
    const ruby = toRuby(['class Duration {', '}', 'const d = new Duration();'].join('\n'));
    assert.ok(!/AWSCDK::Duration/.test(ruby), `rewrote a locally declared class:\n${ruby}`);
  });

  test('a local variable is not mistaken for a module alias', () => {
    const ruby = toRuby(
      ['const opensearch = getThing();', 'const v = opensearch.EngineVersion;'].join('\n'),
    );
    assert.ok(!/AWSCDK::/.test(ruby), `qualified a local variable's member:\n${ruby}`);
  });

  test('an explicit import still wins over the type-name inference', () => {
    // The import says which module is meant; inference must not override it
    // with a same-named type from somewhere else.
    const ruby = toRuby(
      [
        "import * as rds from 'aws-cdk-lib/aws-rds';",
        'const v = rds.EngineVersion.MYSQL;',
      ].join('\n'),
    );
    assert.match(ruby, /AWSCDK::RDS::EngineVersion/);
  });
});
