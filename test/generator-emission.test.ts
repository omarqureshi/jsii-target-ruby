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

describe('generator emission', () => {
  let source: string;

  before(async () => {
    const typeSystem = new TypeSystem();
    const assembly = await typeSystem.load(FIXTURE);

    const generator = new RubyGenerator({} as any, {
      targetName: 'ruby',
      packageDir: '.',
      assembly,
      runtimeTypeChecking: true,
      arguments: {},
      rosetta: {} as any,
    } as any);
    await generator.load('.', assembly);
    generator.generate(false);

    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-emission-'));
    // save() copies the assembly tarball into the package; its contents are
    // irrelevant to what these tests assert.
    const tarball = path.join(outdir, 'assembly.tgz');
    fs.writeFileSync(tarball, '');
    await generator.save(outdir, tarball, {
      license: 'Apache-2.0',
      notice: '',
    });
    source = fs.readFileSync(
      path.join(outdir, 'lib', 'variadic_struct', 'consumer.rb'),
      'utf-8',
    );
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
    const typeSystem = new TypeSystem();
    const assembly = await typeSystem.load(FIXTURE);
    const generator = new RubyGenerator({} as any, {
      targetName: 'ruby',
      packageDir: '.',
      assembly,
      runtimeTypeChecking: true,
      arguments: {},
      rosetta: {} as any,
    } as any);
    await generator.load('.', assembly);
    generator.generate(false);
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-emission-'));
    const tarball = path.join(outdir, 'assembly.tgz');
    fs.writeFileSync(tarball, '');
    await generator.save(outdir, tarball, { license: 'Apache-2.0', notice: '' });
    const read = (f: string) =>
      fs.readFileSync(path.join(outdir, 'lib', 'variadic_struct', f), 'utf-8');
    enumSource = read('plain_enum.rb');
    deprecatedEnumSource = read('deprecated_enum.rb');
    structSource = read('some_struct.rb');
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
