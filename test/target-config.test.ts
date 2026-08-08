import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { applyRubyTargetOverlay, TARGET_CONFIG_ENV } from '../src/target-config';

function withOverlay(overlay: unknown): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-target-config-')), 'overlay.json');
  fs.writeFileSync(file, JSON.stringify(overlay));
  process.env[TARGET_CONFIG_ENV] = file;
}

function fakeAssembly(): any {
  return {
    name: 'aws-cdk-lib',
    targets: { js: { npm: 'aws-cdk-lib' } },
    submodules: {
      'aws-cdk-lib.aws_s3': { targets: { python: { module: 'aws_cdk.aws_s3' } } },
    },
    dependencyClosure: {
      constructs: { targets: { js: { npm: 'constructs' } } },
    },
  };
}

describe('applyRubyTargetOverlay', () => {
  afterEach(() => {
    delete process.env[TARGET_CONFIG_ENV];
  });

  test('no env var: assembly untouched', () => {
    const assembly = fakeAssembly();
    const before = JSON.stringify(assembly);
    applyRubyTargetOverlay(assembly);
    assert.equal(JSON.stringify(assembly), before);
  });

  test('merges root config, keeping other languages', () => {
    withOverlay({ 'aws-cdk-lib': { module: 'AWSCDK', acronyms: ['VPC', 'S3'] } });
    const assembly = fakeAssembly();
    applyRubyTargetOverlay(assembly);
    assert.deepEqual(assembly.targets.ruby, { module: 'AWSCDK', acronyms: ['VPC', 'S3'] });
    assert.deepEqual(assembly.targets.js, { npm: 'aws-cdk-lib' });
  });

  test('overlay wins over in-assembly ruby config', () => {
    withOverlay({ 'aws-cdk-lib': { module: 'AWSCDK' } });
    const assembly = fakeAssembly();
    assembly.targets.ruby = { module: 'WrongName', gem: 'kept-gem' };
    applyRubyTargetOverlay(assembly);
    assert.equal(assembly.targets.ruby.module, 'AWSCDK');
    assert.equal(assembly.targets.ruby.gem, 'kept-gem'); // unmentioned keys survive
  });

  test('merges into the dependency closure', () => {
    withOverlay({ constructs: { gem: 'constructs', module: 'Constructs' } });
    const assembly = fakeAssembly();
    applyRubyTargetOverlay(assembly);
    assert.deepEqual(assembly.dependencyClosure.constructs.targets.ruby, {
      gem: 'constructs',
      module: 'Constructs',
    });
  });

  test('merges submodule entries; tolerates unknown submodules', () => {
    withOverlay({
      'aws-cdk-lib': {
        module: 'AWSCDK',
        submodules: {
          'aws-cdk-lib.aws_s3': { module: 'AWSCDK::S3' },
          'aws-cdk-lib.not_a_module': { module: 'AWSCDK::Ghost' },
        },
      },
    });
    const assembly = fakeAssembly();
    applyRubyTargetOverlay(assembly);
    assert.equal(assembly.submodules['aws-cdk-lib.aws_s3'].targets.ruby.module, 'AWSCDK::S3');
    assert.equal(assembly.submodules['aws-cdk-lib.not_a_module'], undefined);
  });

  test('ignores _comment keys at both levels', () => {
    withOverlay({
      _comment: 'top-level note',
      'aws-cdk-lib': { _decisions: { why: 'because' }, module: 'AWSCDK' },
    });
    const assembly = fakeAssembly();
    applyRubyTargetOverlay(assembly);
    assert.deepEqual(assembly.targets.ruby, { module: 'AWSCDK' });
  });

  test('is idempotent', () => {
    withOverlay({ 'aws-cdk-lib': { module: 'AWSCDK' } });
    const assembly = fakeAssembly();
    applyRubyTargetOverlay(assembly);
    const once = JSON.stringify(assembly);
    applyRubyTargetOverlay(assembly);
    assert.equal(JSON.stringify(assembly), once);
  });
});
