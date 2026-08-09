import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { translateTypeScript } from 'jsii-rosetta/lib/translate';

import { RubyVisitor } from '../src/rosetta/ruby-visitor';

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
    // Reads render as a class-method call with constant casing
    // (`C.MY_VALUE`), matching what pacmak generates for real jsii statics —
    // so the declaration has to define that method. It previously emitted a
    // bare `MyValue = 5` constant, which no read ever referenced.
    const read = /\bC\.([A-Za-z_][A-Za-z0-9_]*)/.exec(ruby)?.[1];
    assert.ok(read, `no static read found in:\n${ruby}`);
    assert.match(
      ruby,
      new RegExp(`def self\\.${read}\\b`),
      `read C.${read} has no matching declaration in:\n${ruby}`,
    );
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
  // Most aws-cdk-lib examples are marked "generated from non-compiling
  // source": rosetta cannot resolve their symbols, so type references fall
  // back to rendering the local import alias. `s3.Bucket` became `S3::Bucket`,
  // which raises NameError when pasted — the root module is not optional in
  // Ruby. The alias is the only thing tying the reference to its assembly, so
  // the import statement has to be remembered.
  const OVERLAY = path.resolve(__dirname, '..', '..', 'config', 'cdk-targets.json');

  before(() => {
    process.env.JSII_RUBY_TARGET_CONFIG = OVERLAY;
  });
  after(() => {
    delete process.env.JSII_RUBY_TARGET_CONFIG;
  });

  test('a submodule import qualifies with the root module', () => {
    const ruby = toRuby(
      ["import * as s3 from 'aws-cdk-lib/aws-s3';", "new s3.Bucket(this, 'B');"].join('\n'),
    );
    assert.match(ruby, /AWSCDK::S3::Bucket/);
  });

  test('a root package import qualifies too', () => {
    const ruby = toRuby(
      ["import * as cdk from 'aws-cdk-lib';", "new cdk.Stack(app, 'S');"].join('\n'),
    );
    assert.match(ruby, /AWSCDK::Stack/);
  });

  test('the overlay acronym casing is applied to the submodule', () => {
    const ruby = toRuby(
      ["import * as ec2 from 'aws-cdk-lib/aws-ec2';", "new ec2.Vpc(this, 'V');"].join('\n'),
    );
    assert.match(ruby, /AWSCDK::EC2::/);
  });

  test('a selectively imported type is qualified', () => {
    // `import { Bucket } from 'aws-cdk-lib/aws-s3'` binds the type name
    // directly, so there is no alias in the reference at all — `Bucket.new`
    // names nothing in Ruby.
    const ruby = toRuby(
      ["import { Bucket } from 'aws-cdk-lib/aws-s3';", "new Bucket(this, 'B');"].join('\n'),
    );
    assert.match(ruby, /AWSCDK::S3::Bucket/);
  });

  test('a renamed selective import is qualified under its local name', () => {
    const ruby = toRuby(
      ["import { Bucket as B } from 'aws-cdk-lib/aws-s3';", "new B(this, 'x');"].join('\n'),
    );
    assert.match(ruby, /AWSCDK::S3::Bucket/);
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

  test('an unknown package still renders its alias, not a bogus prefix', () => {
    const ruby = toRuby(
      ["import * as other from 'some-other-lib';", "new other.Thing();"].join('\n'),
    );
    assert.match(ruby, /SomeOtherLib::Thing/);
  });
});
