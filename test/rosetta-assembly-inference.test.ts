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
 * they name. Real libraries' conventional aliases frequently do not — an alias
 * is whatever the docs author habitually types — and those references came out
 * with no root module at all (`Flow::DeliveryStream`), which raises NameError
 * when pasted.
 *
 * The type name is the way in: the assembly indexes every type it declares, so
 * an unresolvable alias can still be answered by asking where `DeliveryStream`
 * lives. Driven here against a library that does not exist, because the
 * mechanism is the target's and the naming is not.
 */
function toRuby(source: string): string {
  return translateTypeScript({ contents: source, fileName: 'test.ts' }, new RubyVisitor()).translation;
}

describe('references whose alias names no submodule', () => {
  const PROFILE = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'profile.json');

  before(() => {
    process.env.JSII_RUBY_TARGET_CONFIG = PROFILE;
    registerAssemblyTypes({
      name: 'acme-lib',
      submodules: {
        'acme-lib.acme_streamflow': {},
        'acme-lib.acme_workflows': {},
        'acme-lib.acme_workflows_tasks': {},
        'acme-lib.acme_searchsvc': {},
        'acme-lib.acme_db': {},
        'acme-lib.acme_storage': {},
        'acme-lib.acme_identity': {},
        'acme-lib.pipelines': {},
      },
      types: {
        'acme-lib.Duration': { kind: 'class' },
        'acme-lib.acme_streamflow.DeliveryStream': { kind: 'class' },
        'acme-lib.acme_streamflow.Compression': { kind: 'enum' },
        'acme-lib.acme_workflows.StateMachine': { kind: 'class' },
        'acme-lib.acme_workflows_tasks.RunJob': { kind: 'class' },
        // Declared by two submodules: only the alias can say which is meant.
        'acme-lib.acme_searchsvc.EngineVersion': { kind: 'class' },
        'acme-lib.acme_db.EngineVersion': { kind: 'class' },
        // Declared by two submodules that neither alias below resembles.
        'acme-lib.acme_storage.Schedule': { kind: 'class' },
        'acme-lib.acme_identity.Schedule': { kind: 'class' },
        // A root-level type whose name a submodule also uses.
        'acme-lib.Tags': { kind: 'class' },
        'acme-lib.pipelines.Tags': { kind: 'class' },
      },
    } as any);
  });
  after(() => {
    delete process.env.JSII_RUBY_TARGET_CONFIG;
    resetTypeOracle();
  });

  test('an alias unlike its submodule is resolved by the type name', () => {
    // `flow` is `acme_streamflow`: no amount of alias munging gets there, but
    // the assembly declares exactly one `DeliveryStream`.
    assert.match(
      toRuby("new flow.DeliveryStream(this, 'S');"),
      /ACME::StreamFlow::DeliveryStream\.new/,
    );
  });

  test('an abbreviated alias is resolved the same way', () => {
    assert.match(
      toRuby("new wf.StateMachine(this, 'M');"),
      /ACME::Workflows::StateMachine\.new/,
    );
  });

  test('a multi-word submodule is reached through its short alias', () => {
    assert.match(toRuby("new tasks.RunJob(this, 'J');"), /ACME::WorkflowsTasks::RunJob\.new/);
  });

  test('a root-level type is qualified through an unknown alias', () => {
    assert.match(toRuby('const d = lib.Duration.seconds(30);'), /ACME::Duration\.seconds/);
  });

  test('an alias resembling the assembly picks the root-level type', () => {
    // `acme` names the library itself, so `acme.Tags` means the root `Tags`
    // and not `pipelines.Tags`. The assembly name is what says so — the same
    // resemblance test the submodules get.
    const ruby = toRuby("acme.Tags.of(stack).add('k', 'v');");
    assert.match(ruby, /ACME::Tags\.of/);
    assert.ok(!/Pipelines::Tags/.test(ruby), `resolved to the submodule type:\n${ruby}`);
  });

  test('the alias picks between submodules that declare the same type name', () => {
    // Both acme_searchsvc and acme_db declare EngineVersion; the alias
    // resembles only one of them.
    const ruby = toRuby('const v = searchsvc.EngineVersion.V1;');
    assert.match(ruby, /ACME::SearchSvc::EngineVersion/);
    assert.ok(!/DB::EngineVersion/.test(ruby), `resolved to the wrong submodule:\n${ruby}`);
  });

  test('an inferred module qualifies the member as well as its owner', () => {
    // Static readonly members read as constants (Jsii::StaticConstants), the
    // same as enum members, so the only thing module resolution has to get
    // right is the prefix.
    assert.match(
      toRuby('const v = searchsvc.EngineVersion.V1;'),
      /ACME::SearchSvc::EngineVersion::V1/,
    );
  });

  test('an enum reached through an inferred module keeps its constant', () => {
    assert.match(toRuby('const c = flow.Compression.GZIP;'), /ACME::StreamFlow::Compression::GZIP/);
  });

  test('a bare type name with no import is qualified', () => {
    // Selective imports live in fixtures the published package does not ship,
    // so the reference arrives with neither alias nor import.
    assert.match(toRuby("new DeliveryStream(this, 'S');"), /ACME::StreamFlow::DeliveryStream/);
  });

  test("an ambiguous bare name is narrowed by the snippet's own imports", () => {
    // The example imports one module and uses it, then names a type bare
    // because the import that would bind it lives in a fixture the package
    // does not ship. Both declarations are candidates; only one is in a module
    // this snippet is working in.
    const ruby = toRuby(
      [
        "import * as searchsvc from 'acme-lib/acme-searchsvc';",
        'const version = EngineVersion.V1;',
      ].join('\n'),
    );
    assert.match(ruby, /ACME::SearchSvc::EngineVersion::V1/);
  });

  test('imports do not narrow when more than one of them declares the name', () => {
    const ruby = toRuby(
      [
        "import * as searchsvc from 'acme-lib/acme-searchsvc';",
        "import * as db from 'acme-lib/acme-db';",
        'const version = EngineVersion.V1;',
      ].join('\n'),
    );
    assert.ok(!/ACME::/.test(ruby), `guessed between two imported modules:\n${ruby}`);
  });

  test('an ambiguous type name the alias cannot narrow is left alone', () => {
    // Guessing between acme_storage and acme_identity would be a coin toss,
    // and a wrong module is worse than an unqualified one.
    const ruby = toRuby('const s = sched.Schedule.rate(d);');
    assert.ok(!/ACME::/.test(ruby), `guessed a module for an ambiguous name:\n${ruby}`);
  });

  test('a type name the assembly does not declare is left alone', () => {
    const ruby = toRuby('new widgets.Thing();');
    assert.match(ruby, /Widgets::Thing/);
    assert.ok(!/ACME::/.test(ruby), `invented a module:\n${ruby}`);
  });

  test('a locally declared class is not replaced by a library type', () => {
    // A snippet defining its own `Duration` means its own; rewriting the
    // reference points it at a different class than the one two lines up.
    const ruby = toRuby(['class Duration {', '}', 'const d = new Duration();'].join('\n'));
    assert.ok(!/ACME::Duration/.test(ruby), `rewrote a locally declared class:\n${ruby}`);
  });

  test('a local variable is not mistaken for a module alias', () => {
    const ruby = toRuby(
      ['const searchsvc = getThing();', 'const v = searchsvc.EngineVersion;'].join('\n'),
    );
    assert.ok(!/ACME::/.test(ruby), `qualified a local variable's member:\n${ruby}`);
  });

  test('an explicit import still wins over the type-name inference', () => {
    // The import says which module is meant; inference must not override it
    // with a same-named type from somewhere else.
    const ruby = toRuby(
      ["import * as db from 'acme-lib/acme-db';", 'const v = db.EngineVersion.V1;'].join('\n'),
    );
    assert.match(ruby, /ACME::DB::EngineVersion/);
  });
});
