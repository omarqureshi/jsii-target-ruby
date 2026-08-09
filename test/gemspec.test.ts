import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { generateGemspec, resolveInstalledVersion, rubyGemName } from '../src/gemspec';

describe('rubyGemName', () => {
  test('explicit targets.ruby.gem wins', () => {
    assert.equal(rubyGemName({ name: '@scope/x', targets: { ruby: { gem: 'custom' } } } as any), 'custom');
  });

  test('derives from the npm name otherwise', () => {
    assert.equal(rubyGemName({ name: 'jsii-calc' }), 'jsii-calc');
    assert.equal(rubyGemName({ name: '@scope/jsii-calc-lib' }), 'scope-jsii-calc-lib');
  });
});

describe('resolveInstalledVersion', () => {
  test('resolves a dependency installed under the package root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemspec-test-'));
    const dep = path.join(root, 'node_modules', 'some-dep');
    fs.mkdirSync(dep, { recursive: true });
    fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'some-dep', version: '3.1.4' }));
    assert.equal(resolveInstalledVersion('some-dep', root), '3.1.4');
  });

  test('returns undefined for unresolvable deps and undefined roots', () => {
    assert.equal(resolveInstalledVersion('definitely-not-installed-xyz', os.tmpdir()), undefined);
    assert.equal(resolveInstalledVersion('anything', undefined), undefined);
  });
});

describe('generateGemspec', () => {
  afterEach(() => {
    delete process.env.JSII_RUBY_PIN_DEPENDENCIES;
  });

  function fakeAssembly(overrides: Record<string, unknown> = {}): any {
    const spec = {
      name: 'jsii-calc',
      description: "It's a calculator",
      author: { name: 'Amazon Web Services' },
      license: 'Apache-2.0',
      homepage: 'https://example.com',
      targets: { ruby: { gem: 'jsii-calc' } },
      dependencies: { '@scope/jsii-calc-lib': '^0.1.2' },
      dependencyClosure: {
        '@scope/jsii-calc-lib': { targets: { ruby: { gem: 'scope-jsii-calc-lib' } } },
      },
      ...overrides,
    };
    return { spec, name: spec.name, version: '3.20.120' };
  }

  async function generated(assembly: any, packageRoot?: string): Promise<string> {
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemspec-out-'));
    await generateGemspec(assembly, packageRoot, outdir);
    return fs.readFileSync(path.join(outdir, 'jsii-calc.gemspec'), 'utf-8');
  }

  test('emits the full gemspec with converted version and translated ranges', async () => {
    const content = await generated(fakeAssembly());
    assert.match(content, /s\.name {8}= 'jsii-calc'/);
    assert.match(content, /s\.version {5}= '3\.20\.120'/);
    assert.match(content, /s\.description = 'It\\'s a calculator'/); // sq-escaped
    assert.match(content, /s\.add_dependency 'jsii-ruby-runtime', '~> 0\.1'/);
    assert.match(content, /s\.add_dependency 'base64', '~> 0\.2'/);
    // ^0.1.2 translates as a range, not a pin
    assert.match(content, /s\.add_dependency 'scope-jsii-calc-lib', '>= 0\.1\.2', '< 0\.2\.0'/);
  });

  test('JSII_RUBY_PIN_DEPENDENCIES=exact pins to the installed version', async () => {
    process.env.JSII_RUBY_PIN_DEPENDENCIES = 'exact';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemspec-root-'));
    const dep = path.join(root, 'node_modules', '@scope', 'jsii-calc-lib');
    fs.mkdirSync(dep, { recursive: true });
    fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: '@scope/jsii-calc-lib', version: '0.0.42' }));

    const content = await generated(fakeAssembly(), root);
    assert.match(content, /s\.add_dependency 'scope-jsii-calc-lib', '= 0\.0\.42'/);
  });

  test('exact mode falls back to the range when the dep is not installed', async () => {
    process.env.JSII_RUBY_PIN_DEPENDENCIES = 'exact';
    const content = await generated(fakeAssembly(), fs.mkdtempSync(path.join(os.tmpdir(), 'empty-root-')));
    assert.match(content, /s\.add_dependency 'scope-jsii-calc-lib', '>= 0\.1\.2', '< 0\.2\.0'/);
  });

  test('dependencies without an explicit gem name use the derived name', async () => {
    // Real assemblies carry no jsii.targets.ruby, so this is the DEFAULT
    // path. Skipping such dependencies produced a gem whose generated sources
    // `require` packages the gemspec never declared: installs fine, then
    // LoadError on the first require.
    const content = await generated(
      fakeAssembly({ dependencyClosure: { '@scope/jsii-calc-lib': { targets: {} } } }),
    );
    assert.match(content, /s\.add_dependency 'scope-jsii-calc-lib'/);
  });

  test('an explicit targets.ruby.gem on a dependency still wins', async () => {
    const content = await generated(
      fakeAssembly({
        dependencyClosure: {
          '@scope/jsii-calc-lib': { targets: { ruby: { gem: 'custom-name' } } },
        },
      }),
    );
    assert.match(content, /s\.add_dependency 'custom-name'/);
    assert.ok(!content.includes("'scope-jsii-calc-lib'"));
  });
});
