import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { translateTypeScript } from 'jsii-rosetta/lib/translate';

import { RubyVisitor } from '../src/rosetta/ruby-visitor';
import { registerAssemblyTypes, resetTypeOracle } from '../src/type-oracle';

/**
 * Rendering defects found by the max-effort review. These matter now that
 * example translation is wired into the generator: whatever the visitor emits
 * ends up in the published API docs, so unparseable or wrong-by-construction
 * Ruby is user-visible.
 */
function toRuby(source: string): string {
  return translateTypeScript({ contents: source, fileName: 'test.ts' }, new RubyVisitor()).translation;
}

describe('multi-line strings', () => {
  test('a multi-line string used as a call argument stays parseable', () => {
    // A heredoc opened inline mid-expression leaves the remainder of the
    // call on the heredoc's first content line, which does not parse.
    const ruby = toRuby('foo("line one\\nline two", 42);');
    assert.ok(
      isParseableRuby(ruby),
      `emitted Ruby does not parse:\n${ruby}`,
    );
  });

  test('a multi-line string containing the terminator is still parseable', () => {
    const ruby = toRuby('const s = "before\\n  HERE\\nafter";');
    assert.ok(isParseableRuby(ruby), `emitted Ruby does not parse:\n${ruby}`);
  });
});

describe('static readonly fields', () => {
  test('declaration and read agree on the constant name', () => {
    const ruby = toRuby(
      ['class C {', '  static readonly myValue = 5;', '}', 'const x = C.myValue;'].join('\n'),
    );
    // A static readonly reads as a constant in both spellings: the snippet's
    // own class declares a real Ruby constant, and a library type reaches one
    // through Jsii::StaticConstants. Either way the read is `C::MY_VALUE`, so
    // the declaration has to define that constant — a mismatch leaves every
    // read referencing something that was never defined.
    const read = /\bC::([A-Z][A-Za-z0-9_]*)/.exec(ruby)?.[1];
    assert.ok(read, `no static read found in:\n${ruby}`);
    assert.match(
      ruby,
      new RegExp(`^\\s*${read} = `, 'm'),
      `read C::${read} has no matching declaration in:\n${ruby}`,
    );
    assert.ok(isParseableRuby(ruby), `emitted Ruby does not parse:\n${ruby}`);
  });

  test('a mutable static stays a method, since a constant cannot be reassigned', () => {
    const ruby = toRuby(['class C {', '  static mutable = 5;', '}'].join('\n'));
    assert.match(ruby, /def self\.mutable/);
    assert.ok(isParseableRuby(ruby), `emitted Ruby does not parse:\n${ruby}`);
  });
});

describe('nullish coalescing', () => {
  test('?? does not collapse to || (which also swallows false)', () => {
    const ruby = toRuby('const x = a ?? b;');
    assert.ok(
      !/\ba \|\| b\b/.test(ruby),
      `?? rendered as ||, which differs for false/empty values:\n${ruby}`,
    );
  });
});

describe('declared class names', () => {
  test('a declaration and its references use the same name', () => {
    const ruby = toRuby(['class myAPI {', '}', 'const c = new myAPI();'].join('\n'));
    const declared = /class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(ruby)?.[1];
    const referenced = /(\w+)\.new/.exec(ruby)?.[1];
    assert.equal(declared, referenced, `declaration/reference disagree in:\n${ruby}`);
  });
});

/** Shells out to `ruby -c` for a real parse check. */
function isParseableRuby(source: string): boolean {
  const { spawnSync } = require('node:child_process');
  const res = spawnSync('ruby', ['-c'], { input: source, encoding: 'utf-8' });
  return res.status === 0;
}

describe('struct property reads', () => {
  test('renders the hash-index form, which Jsii::Struct answers', () => {
    // Two shapes reach a struct-typed read in a translated example: a hash
    // literal the reader wrote, and a hydrated Jsii::Struct returned by the
    // library. `s[:member]` is the form that works for both — Jsii::Struct#[]
    // exists for exactly this reason (compliance/spec/unit/type_spec.rb,
    // 'Jsii::Struct hash-style reads').
    const ruby = toRuby(
      [
        'interface MyProps { readonly bucketName: string; }',
        'declare const props: MyProps;',
        'console.log(props.bucketName);',
      ].join('\n'),
    );
    assert.match(ruby, /props\[:bucket_name\]/, `expected hash-index read in:\n${ruby}`);
  });
});

describe('import aliases qualify type references', () => {
  // Most published examples are marked "generated from non-compiling source":
  // rosetta cannot resolve their symbols, so type references fall back to
  // rendering the local import alias. `storage.Bucket` became
  // `Storage::Bucket`, which raises NameError when pasted — the root module is
  // not optional in Ruby. The alias is the only thing tying the reference to
  // its assembly, so the import statement has to be remembered.
  const OVERLAY = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'profile.json');

  before(() => {
    process.env.JSII_RUBY_TARGET_CONFIG = OVERLAY;
    registerAssemblyTypes({
      name: 'acme-lib',
      submodules: { 'acme-lib.acme_storage': {}, 'acme-lib.acme_identity': {} },
      types: {
        'acme-lib.acme_storage.BucketEncryption': { kind: 'enum' },
        'acme-lib.acme_identity.RoleId': { kind: 'class' },
      },
    } as any);
  });
  after(() => {
    delete process.env.JSII_RUBY_TARGET_CONFIG;
    resetTypeOracle();
  });

  test('a submodule import qualifies with the root module', () => {
    const ruby = toRuby(
      ["import * as storage from 'acme-lib/acme-storage';", "new storage.Bucket(this, 'B');"].join('\n'),
    );
    assert.match(ruby, /ACME::Storage::Bucket/);
  });

  test('a root package import qualifies too', () => {
    const ruby = toRuby(
      ["import * as acme from 'acme-lib';", "new acme.Stack(app, 'S');"].join('\n'),
    );
    assert.match(ruby, /ACME::Stack/);
  });

  test('the overlay acronym casing is applied to the submodule', () => {
    const ruby = toRuby(
      ["import * as identity from 'acme-lib/acme-identity';", "new identity.RoleId(this, 'R');"].join('\n'),
    );
    assert.match(ruby, /ACME::Identity::/);
  });

  test('a selectively imported type is qualified', () => {
    // `import { Bucket } from 'acme-lib/acme-storage'` binds the type name
    // directly, so there is no alias in the reference at all — `Bucket.new`
    // names nothing in Ruby.
    const ruby = toRuby(
      ["import { Bucket } from 'acme-lib/acme-storage';", "new Bucket(this, 'B');"].join('\n'),
    );
    assert.match(ruby, /ACME::Storage::Bucket/);
  });

  test('a renamed selective import is qualified under its local name', () => {
    const ruby = toRuby(
      ["import { Bucket as B } from 'acme-lib/acme-storage';", "new B(this, 'x');"].join('\n'),
    );
    assert.match(ruby, /ACME::Storage::Bucket/);
  });

  test('a selectively imported function is left alone', () => {
    // Lowercase bindings are values, not types; qualifying them would produce
    // a constant path for something that is not a constant.
    const ruby = toRuby(
      ["import { doThing } from '@scope/some-module';", 'doThing();'].join('\n'),
    );
    assert.match(ruby, /^\s*do_thing/m);
    assert.ok(!/Scope::SomeModule::do_thing/.test(ruby), `function was qualified:\n${ruby}`);
  });

  test('an unimported CDK submodule alias is qualified, with acronym casing', () => {
    // Published CDK examples are fragments: the fixture that would import
    // `iam` is not in the package, so there is no import to learn from. The
    // alias still names a real submodule of the assembly being documented,
    // and `Iam::Role` is wrong twice over — no root module, and IAM is an
    // acronym the overlay knows about.
    const ruby = toRuby("new identity.Role(this, 'R');");
    assert.match(ruby, /ACME::Identity::Role/);
  });

  test('the same inference covers the S3 fragment case', () => {
    assert.match(toRuby("new storage.Bucket(this, 'B');"), /ACME::Storage::Bucket/);
  });

  test('acronyms apply to the type name as well as the module', () => {
    assert.match(toRuby("new identity.RoleId(this, 'R');"), /ACME::Identity::RoleID/);
  });

  test('an alias that names no known submodule is left alone', () => {
    // Inference must not invent a module for something the assembly does not
    // declare.
    const ruby = toRuby("new widgets.Thing();");
    assert.match(ruby, /Widgets::Thing/);
    assert.ok(!/ACME::Widgets/.test(ruby), `invented a module:\n${ruby}`);
  });

  test('a lowercase member is a method call, not a type reference', () => {
    // `identity.something()` is a call on a local variable; qualifying it would
    // turn a value into a constant path.
    const ruby = toRuby('identity.someHelper();');
    assert.ok(!/ACME::Identity/.test(ruby), `qualified a method call:\n${ruby}`);
  });

  test('a static readonly member reads as a constant, like an enum member', () => {
    // A static readonly member and an enum member are indistinguishable in a
    // snippet that does not typecheck (SCREAMING_SNAKE after a PascalCase
    // name) — and no longer need distinguishing: both are read with `::`,
    // the static resolving through Jsii::StaticConstants.
    const ruby = toRuby("new identity.Client(this, 'C', { role: identity.RoleId.ADMIN });");
    assert.match(ruby, /ACME::Identity::RoleID::ADMIN/);
  });

  test('an enum member is still a constant', () => {
    const ruby = toRuby("new storage.Bucket(this, 'B', { encryption: storage.BucketEncryption.MANAGED });");
    assert.match(ruby, /ACME::Storage::BucketEncryption::MANAGED/);
  });

  test('an unknown package still renders its alias, not a bogus prefix', () => {
    const ruby = toRuby(
      ["import * as other from 'some-other-lib';", "new other.Thing();"].join('\n'),
    );
    assert.match(ruby, /SomeOtherLib::Thing/);
  });
});
