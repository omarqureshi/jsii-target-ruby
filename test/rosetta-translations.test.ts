import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { translateTypeScript } from 'jsii-rosetta/lib/translate';

import { RubyVisitor } from '../src/rosetta/ruby-visitor';

/**
 * Syntactic translation of a TypeScript snippet to Ruby (no type resolution needed for these
 * cases). Returns the rendered Ruby source.
 */
function toRuby(source: string): string {
  return translateTypeScript({ contents: source, fileName: 'test.ts' }, new RubyVisitor()).translation;
}

describe('imports -> require', () => {
  const cases: Array<[string, string]> = [
    // A plain package import maps to the gem of the same name.
    ["import * as cdk from 'aws-cdk-lib';", "require 'aws-cdk-lib'"],
    // A *submodule* import resolves to the gem, not a per-submodule require: the
    // submodule is autoloaded from the package. Regression: this used to `/`->`-` the
    // whole path and emit `require 'aws-cdk-lib-aws-s3tables'`.
    ["import * as s3tables from 'aws-cdk-lib/aws-s3tables';", "require 'aws-cdk-lib'"],
    ["import { Bucket } from 'aws-cdk-lib/aws-s3';", "require 'aws-cdk-lib'"],
    // Scoped packages: @scope/name -> scope-name; a submodule still maps to the package.
    ["import { Foo } from '@scope/jsii-calc-lib';", "require 'scope-jsii-calc-lib'"],
    ["import { Foo } from '@scope/jsii-calc-lib/submodule';", "require 'scope-jsii-calc-lib'"],
  ];
  for (const [source, expected] of cases) {
    test(`${source} -> ${expected}`, () => {
      assert.ok(toRuby(source).includes(expected));
    });
  }

  test('relative imports use require_relative', () => {
    assert.ok(toRuby("import { Foo } from './my-module';").includes("require_relative './my-module'"));
  });

  test('imports resolving to the same gem emit a single require', () => {
    const ruby = toRuby(
      ["import * as s3 from 'aws-cdk-lib/aws-s3';", "import * as sqs from 'aws-cdk-lib/aws-sqs';"].join('\n'),
    );
    // Regression: each import used to emit its own `require 'aws-cdk-lib'`.
    assert.equal((ruby.match(/require 'aws-cdk-lib'/g) ?? []).length, 1);
    assert.ok(!ruby.includes('\n\n'));
  });

  test('require dedupe resets between snippets when a visitor is reused', () => {
    // `translateMarkdown` renders every snippet in a document with a single
    // visitor instance; a require emitted for one snippet must not suppress
    // the same require in the next one.
    const visitor = new RubyVisitor();
    const snippet = { contents: "import * as cdk from 'aws-cdk-lib';", fileName: 'test.ts' };
    translateTypeScript(snippet, visitor);
    assert.ok(translateTypeScript(snippet, visitor).translation.includes("require 'aws-cdk-lib'"));
  });
});

describe('array literal formatting', () => {
  test('a broken array puts each element on its own line, not just the closing bracket', () => {
    const ruby = toRuby(
      [
        "new Foo(stack, 'T', {",
        '  replicas: [',
        "    { region: 'us-east-1' }, { region: 'us-east-2' }",
        '  ],',
        '});',
      ].join('\n'),
    );
    // Regression: elements shared one line while `]` dropped to its own line
    // (`...{region: "us-east-2"}\n    ]`). Each element should be on its own line.
    assert.match(ruby, /\{region: "us-east-1"\},\n/);
    assert.ok(ruby.includes('{region: "us-east-2"}'));
  });

  test('a short array stays inline', () => {
    assert.ok(toRuby('const x = [1, 2, 3];').includes('[1, 2, 3]'));
  });

  test('a broken hash keeps a property after a multi-line value on its own line', () => {
    const ruby = toRuby(
      [
        "new Foo(stack, 'T', {",
        '  importSource: {',
        '    inputFormat: InputFormat.csv({',
        "      delimiter: ',',",
        '    }),',
        '    bucket: bucket,',
        '  },',
        '});',
      ].join('\n'),
    );
    // Regression: `bucket:` was stranded on the csv(...) closing line (`}), bucket: bucket`).
    assert.match(ruby, /\}\),\n\s*bucket: bucket/);
  });

  test('a short hash stays inline', () => {
    assert.ok(toRuby('const x = { a: 1, b: 2 };').includes('{a: 1, b: 2}'));
  });
});

describe('if / elsif / else chains', () => {
  test('an if / else-if / else chain emits exactly one `end`', () => {
    const ruby = toRuby(['if (a) {', '  x();', '} else if (b) {', '  y();', '} else {', '  z();', '}'].join('\n'));

    assert.ok(ruby.includes('elsif'));
    assert.ok(ruby.includes('else'));
    // Exactly one closing `end` for the whole chain (regression: used to emit two).
    assert.equal((ruby.match(/^end$/gm) ?? []).length, 1);
  });

  test('nested else-if renders `elsif`, not a nested `if`', () => {
    const ruby = toRuby(['if (a) {', '  x();', '} else if (b) {', '  y();', '}'].join('\n'));
    assert.ok(ruby.includes('elsif'));
    assert.equal((ruby.match(/^end$/gm) ?? []).length, 1);
  });
});

describe('string escaping', () => {
  test('literal `#{` in a string is escaped so Ruby does not interpolate it', () => {
    const ruby = toRuby('const s = "a#{b}c";');
    assert.ok(ruby.includes('"a\\#{b}c"'));
  });

  test('template literals escape embedded quotes but keep real interpolation', () => {
    const ruby = toRuby('const x = 1;\nconst s = `say "hi" ${x}`;');
    assert.ok(ruby.includes('\\"hi\\"')); // embedded quotes escaped
    assert.ok(ruby.includes('#{x}')); // interpolation preserved
  });
});

describe('static members', () => {
  test('a static method becomes `def self.<name>`', () => {
    const ruby = toRuby('class C {\n  static foo() {\n    return 1;\n  }\n}');
    assert.ok(ruby.includes('def self.foo'));
    assert.ok(!ruby.includes('def foo'));
  });

  test('a static readonly field becomes a Ruby constant preserving its value', () => {
    const ruby = toRuby('class C {\n  static readonly FOO = 5;\n}');
    assert.ok(ruby.includes('FOO = 5'));
    assert.ok(!ruby.includes('attr_reader :foo'));
  });

  test('static readonly (const) property access keeps the constant name, not dropped', () => {
    // Regression: `BlockPublicAccess.BLOCK_ALL` used to render as just the type
    // (`...BlockPublicAccess`), silently dropping the member.
    const ruby = toRuby(
      ['class C {', '  static readonly BLOCK_ALL = new C();', '}', 'const x = C.BLOCK_ALL;'].join('\n'),
    );
    // Read as a constant, like an enum member: a snippet's own class declares
    // one outright, and a library type resolves it through
    // Jsii::StaticConstants.
    assert.ok(ruby.includes('C::BLOCK_ALL'), `member not read as a constant:\n${ruby}`);
    assert.ok(!ruby.includes('C.BLOCK_ALL'), `member still read as a method:\n${ruby}`);
  });
});

describe('type assertions', () => {
  test('`as number` / `as string` pass through without runtime coercion', () => {
    const ruby = toRuby('const a = 1;\nconst n = a as number;\nconst s = a as string;');
    assert.ok(!ruby.includes('.to_i'));
    assert.ok(!ruby.includes('.to_s'));
  });
});

describe('super calls', () => {
  test('`super()` renders with explicit empty parens (not bare `super`)', () => {
    const ruby = toRuby('class C extends B {\n  constructor() {\n    super();\n  }\n}');
    assert.ok(ruby.includes('super()'));
  });
});
