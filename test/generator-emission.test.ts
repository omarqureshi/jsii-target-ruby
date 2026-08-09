import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { before, describe, test } from 'node:test';

import { TypeSystem } from 'jsii-reflect';

import { RubyGenerator } from '../src/ruby';

// Emission-level regressions from the max-effort code review (2026-08-09),
// driven over a synthetic assembly because the jsii-calc fixtures happen not
// to contain the shapes involved (there is no variadic *struct* constructor
// parameter anywhere in jsii-calc — its one variadic union constructor is
// deliberately left uncoerced, since both arms are structs).
const FIXTURE = path.resolve(
  __dirname,
  '..',
  '..',
  'test',
  'fixtures',
  'variadic-struct.jsii.json',
);

/**
 * Generate the fixture assembly and return the emitted source for one file.
 * pacmak always hands a target a real RosettaTabletReader, so tests use one
 * too; VERBATIM (the default) leaves @example blocks as their TypeScript
 * source, TRANSLATE runs live conversion through the registered visitor.
 */
async function generateFixture(
  file: string,
  mode: 'verbatim' | 'translate' = 'verbatim',
  fixture: string = FIXTURE,
): Promise<string> {
  // Loading the plugin entry point registers the visitor with rosetta.
  require('../src/index');
  const { RosettaTabletReader, UnknownSnippetMode } = require('jsii-rosetta');
  const rosetta = new RosettaTabletReader({
    unknownSnippets:
      mode === 'translate' ? UnknownSnippetMode.TRANSLATE : UnknownSnippetMode.VERBATIM,
    prefixDisclaimer: false,
  });

  const typeSystem = new TypeSystem();
  const assembly = await typeSystem.load(fixture);
  rosetta.addAssembly(assembly.spec, path.dirname(fixture));

  const generator = new RubyGenerator(rosetta, {
    targetName: 'ruby',
    packageDir: '.',
    assembly,
    runtimeTypeChecking: true,
    arguments: {},
    rosetta,
  } as any);
  await generator.load('.', assembly);
  generator.generate(false);

  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-emission-'));
  const tarball = path.join(outdir, 'assembly.tgz');
  fs.writeFileSync(tarball, '');
  await generator.save(outdir, tarball, { license: 'Apache-2.0', notice: '' });
  return fs.readFileSync(path.join(outdir, 'lib', assembly.name, file), 'utf-8');
}

describe('generator emission', () => {
  let source: string;

  before(async () => {
    source = await generateFixture('consumer.rb');
  });

  test('coerces the elements of a variadic struct CONSTRUCTOR parameter', () => {
    // Pre-fix the constructor emitted `opts.is_a?(Hash) ? ... : opts` — a
    // test against the splat Array, which is never a Hash, so hashes went
    // over the wire raw with snake_case keys (silent wire corruption).
    const initializer = source.slice(source.indexOf('def initialize'));
    assert.ok(
      /opts\.map! \{ \|jsii_v0\| jsii_v0\.is_a\?\(Hash\)/.test(initializer),
      `expected element-wise coercion in the constructor, got:\n${initializer.slice(0, 400)}`,
    );
    assert.ok(
      !/\bopts\.is_a\?\(Hash\)/.test(initializer),
      'constructor must not test the splat array itself against Hash',
    );
  });

  test('constructor and method coerce variadic structs identically', () => {
    const initializer = source.slice(
      source.indexOf('def initialize'),
      source.indexOf('def self.jsii_overridable_methods'),
    );
    const method = source.slice(source.indexOf('def consume'));
    const coercion = /opts\.map!\{?[^\n]*/;
    assert.equal(
      coercion.exec(initializer)?.[0],
      coercion.exec(method)?.[0],
      'the two emission sites should produce the same coercion',
    );
  });

  test('forwards the caller block so Jsii::Object#initialize can yield self', () => {
    assert.match(source, /def initialize\([^)]*&jsii_block\)/);
    assert.match(source, /instance_method\(:initialize\)\.bind\(self\)\.call\([^)]*&jsii_block\)/);
  });
});

describe('generator emission: enums and doc tags', () => {
  let enumSource: string;
  let deprecatedEnumSource: string;
  let structSource: string;

  before(async () => {
    enumSource = await generateFixture('plain_enum.rb');
    deprecatedEnumSource = await generateFixture('deprecated_enum.rb');
    structSource = await generateFixture('some_struct.rb');
  });

  test('registers the enum fqn so runtime type checks resolve it', () => {
    // Without this, Jsii::Type.check_fqn resolves the enum to nil and returns
    // without validating — type checking is a silent no-op for every
    // enum-typed parameter, property and struct member.
    assert.match(
      enumSource,
      /Jsii::Object\.register_jsii_fqn\("variadic_struct\.PlainEnum", self\)/,
    );
  });

  test('does not mark undocumented members as deprecated', () => {
    // rawDocs falls back to a jsii-reflect Docs instance whose getters return
    // ''/false rather than undefined, so an `!== undefined` test tagged every
    // undocumented member as @deprecated with an empty Default note.
    assert.ok(!/@deprecated/.test(enumSource), `unexpected @deprecated in:\n${enumSource}`);
    assert.ok(!/@note Default:/.test(enumSource), `unexpected empty Default note in:\n${enumSource}`);
    assert.ok(!/@deprecated/.test(structSource), `unexpected @deprecated in:\n${structSource}`);
  });

  test('still marks genuinely deprecated members, with their reason', () => {
    assert.match(deprecatedEnumSource, /# @deprecated use PlainEnum/);
    assert.match(deprecatedEnumSource, /# @deprecated gone soon/);
  });
});

describe('rosetta example translation', () => {
  // The plugin registers its visitor with jsii-rosetta's language registry on
  // load; with live conversion enabled the tablet reader resolves 'ruby'
  // through that registry, so @example blocks emit Ruby instead of the
  // TypeScript source.
  let source: string;

  before(async () => {
    source = await generateFixture('consumer.rb', 'translate');
  });

  test('emits the @example translated to Ruby', () => {
    const example = source.slice(source.indexOf('@example'));
    assert.match(example, /consumer = /);
    assert.match(example, /\.new\(/, 'expected Ruby construction');
    assert.match(example, /bucket_name:/, 'expected snake_case struct keys');
  });

  test('does not leave TypeScript syntax in the example', () => {
    const example = source.slice(source.indexOf('@example'), source.indexOf('def initialize'));
    assert.ok(!/\bconst\b/.test(example), `TypeScript 'const' survived:\n${example}`);
    assert.ok(!/;\s*$/m.test(example.replace(/^\s*#\s?/gm, '')), 'trailing semicolons survived');
  });
});


// The four member-doc emission sites (instance/static x property/method) each
// built the same `@param`/`@return` block by hand. These pin what each one
// renders, so unifying them cannot quietly drop a tag from one position.
describe('generator emission: member documentation', () => {
  const DOCUMENTED = path.resolve(
    __dirname,
    '..',
    '..',
    'test',
    'fixtures',
    'documented-members.jsii.json',
  );

  let widget: string;

  before(async () => {
    widget = await generateFixture('widget.rb', 'verbatim', DOCUMENTED);
  });

  /** The emitted source for one member definition, docs included. */
  function member(def: string): string {
    const at = widget.indexOf(def);
    assert.notEqual(at, -1, `no ${def} in:\n${widget}`);
    const before = widget.slice(0, at);
    // Walk back to the start of this member's comment block.
    const lines = before.split('\n');
    let start = lines.length - 1;
    while (start > 0 && /^\s*(#|$)/.test(lines[start - 1])) start--;
    return [...lines.slice(start), widget.slice(at).split('\n')[0]].join('\n');
  }

  test('instance property renders summary and @return of its type', () => {
    const prop = member('def instance_prop(');
    assert.match(prop, /# An instance property\./);
    assert.match(prop, /# @return \[String\]/);
  });

  test('optional instance property renders a nilable @return', () => {
    const prop = member('def optional_prop(');
    assert.match(prop, /# @return \[Numeric, nil\]/);
  });

  test('static property renders summary and @return of its type', () => {
    const prop = member('def self.static_prop');
    assert.match(prop, /# A static property\./);
    assert.match(prop, /# @return \[Boolean\]/);
  });

  test('instance method renders @param per parameter and @return', () => {
    const meth = member('def instance_method(');
    assert.match(meth, /# Does an instance thing\./);
    assert.match(meth, /# @param how_many \[Numeric\] How many to make\./);
    assert.match(meth, /# @return \[String\]/);
  });

  test('a method with no declared return renders @return [void]', () => {
    assert.match(member('def void_method('), /# @return \[void\]/);
  });

  test('static method renders @param per parameter and @return', () => {
    const meth = member('def self.static_method(');
    assert.match(meth, /# Does a static thing\./);
    assert.match(meth, /# @param seed_value \[String\] Where to start from\./);
    assert.match(meth, /# @return \[DocumentedMembers::Widget\]/);
  });

  test('constructor renders @param per parameter', () => {
    assert.match(member('def initialize('), /# @param label \[String\] The label to show\./);
  });
});
