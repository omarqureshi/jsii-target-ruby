import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';

import { TypeSystem } from 'jsii-reflect';

import { RubyGenerator } from '../src/ruby';

// A representative subset of the CDK acronym list — only those exercised by
// the assertions below. Includes the cases that matter beyond a simple match:
// the IP/IPv4 overlap and the 2-letter `CE` surviving among its neighbours.
const CDK_ACRONYMS = [
  'AWS',
  'VPC',
  'ECS',
  'API',
  'DB',
  'CIDR',
  'IP',
  'IPv4',
  'CE',
];

// Resolved against the source tree so the compiled test (build/test/*.js)
// finds the fixture without copying it into the build output.
const FIXTURE = path.resolve(
  __dirname,
  '..',
  '..',
  'test',
  'fixtures',
  'base.jsii.json',
);

describe('Ruby naming behavior', () => {
  let rubyTarget: any; // Use any to access private methods for testing

  before(async () => {
    const typeSystem = new TypeSystem();
    const assembly = await typeSystem.load(FIXTURE);

    // Mock targets to include the acronyms array
    (assembly as any).spec.targets = {
      ruby: {
        acronyms: CDK_ACRONYMS,
        module: 'BaseModule',
      },
    };

    rubyTarget = new RubyGenerator({} as any, {
      targetName: 'ruby',
      packageDir: '.',
      assembly,
      runtimeTypeChecking: true,
      arguments: {},
      rosetta: {} as any, // not used for this test
    } as any);
    await rubyTarget.load('.', assembly);
  });

  describe('rubyModuleName', () => {
    it('capitalizes acronyms correctly', () => {
      assert.equal(rubyTarget.rubyModuleName('CfnVpc'), 'CfnVPC');
      assert.equal(rubyTarget.rubyModuleName('CfnVPCConnection'), 'CfnVPCConnection');
      assert.equal(rubyTarget.rubyModuleName('dbTable'), 'DBTable');
      assert.equal(rubyTarget.rubyModuleName('IpAddress'), 'IPAddress');
      assert.equal(rubyTarget.rubyModuleName('awsIpv4Cidr'), 'AWSIPv4CIDR');
      assert.equal(rubyTarget.rubyModuleName('apiGateway'), 'APIGateway'); // API is an acronym
      assert.equal(rubyTarget.rubyModuleName('EcsCluster'), 'ECSCluster');
    });

    it('produces valid constants for digit- and underscore-leading names', () => {
      // npm allows package names like `3d-tools`; Ruby constants must start
      // with an uppercase letter.  V_ prefix mirrors rubyConstName.
      assert.equal(rubyTarget.rubyModuleName('3d-tools'), 'V_3dTools');
      assert.equal(rubyTarget.rubyModuleName('3DSecure'), 'V_3DSecure');
      assert.equal(rubyTarget.rubyModuleName('@scope/3d'), 'Scope::V_3d');
      assert.equal(rubyTarget.rubyModuleName('_internal'), 'V__internal');
      // Ordinary names are untouched.
      assert.equal(rubyTarget.rubyModuleName('jsii-calc'), 'JsiiCalc');
    });

    it('treats acronyms as literal text, not regex patterns', () => {
      // A config-supplied acronym containing regex metacharacters must not
      // break generation (previously: "Nothing to repeat" SyntaxError) or
      // inject match behavior.
      assert.doesNotThrow(() => rubyTarget.rubyModuleName('CppHelper', ['C++']));
      assert.equal(rubyTarget.rubyModuleName('CppHelper', ['C++']), 'CppHelper');
      assert.equal(rubyTarget.rubyModuleName('fooBar', ['.*']), 'FooBar');
    });

    it('scopes acronyms to the supplied list (per-assembly, not pooled)', () => {
      // Explicit empty list: nothing rewritten even though the test
      // assembly configures VPC as an acronym.
      assert.equal(rubyTarget.rubyModuleName('CfnVpc', []), 'CfnVpc');
      assert.equal(rubyTarget.rubyModuleName('CfnVpc', ['VPC']), 'CfnVPC');
      // Default (no list passed) uses the generated assembly's own config.
      assert.equal(rubyTarget.rubyModuleName('CfnVpc'), 'CfnVPC');
    });

    it('ignores blank acronym entries', () => {
      // An empty-string acronym would match everywhere; assemblyAcronyms
      // filters it out before it reaches the regex.
      assert.deepEqual(
        rubyTarget.assemblyAcronyms({
          targets: { ruby: { acronyms: ['', 'VPC', 42] } },
        }),
        ['VPC'],
      );
    });

    it('does not over-capitalize acronyms embedded inside words', () => {
      // "AWSpecial" contains "AWS" but not at a word boundary — it must
      // survive unmangled, while true acronym positions are rewritten.
      assert.equal(rubyTarget.rubyModuleName('AWSpecial'), 'AWSpecial');
      assert.equal(rubyTarget.rubyModuleName('VpcEndpoint'), 'VPCEndpoint');
      assert.equal(
        rubyTarget.rubyModuleName('awsCertificatemanager'),
        'AWSCertificatemanager',
      );
      assert.equal(rubyTarget.rubyModuleName('awsCeService'), 'AWSCEService');
    });
  });

  describe('rubyName', () => {
    it('passes through ordinary member names', () => {
      assert.equal(rubyTarget.rubyName('fooBar'), 'foo_bar');
      assert.equal(rubyTarget.rubyName('hello'), 'hello');
    });

    it('prefixes Ruby keywords', () => {
      assert.equal(rubyTarget.rubyName('break'), '_break');
      assert.equal(rubyTarget.rubyName('class'), '_class');
      assert.equal(rubyTarget.rubyName('while'), '_while');
    });

    it('prefixes constructor/allocation hooks so members cannot clobber them', () => {
      // `def initialize` would silently replace the generated constructor;
      // `new`/`allocate` are the class methods used to instantiate proxies.
      assert.equal(rubyTarget.rubyName('initialize'), '_initialize');
      assert.equal(rubyTarget.rubyName('new'), '_new');
      assert.equal(rubyTarget.rubyName('allocate'), '_allocate');
    });

    it('prefixes runtime serialization/dispatch hooks', () => {
      assert.equal(rubyTarget.rubyName('toJsii'), '_to_jsii');
      assert.equal(rubyTarget.rubyName('rubyClass'), '_ruby_class');
      assert.equal(rubyTarget.rubyName('send'), '_send');
    });

    it('prefixes anything landing in the reserved jsii_ namespace', () => {
      assert.equal(rubyTarget.rubyName('jsiiRef'), '_jsii_ref');
      assert.equal(rubyTarget.rubyName('jsiiSerialize'), '_jsii_serialize');
      assert.equal(rubyTarget.rubyName('jsiiSomeFutureApi'), '_jsii_some_future_api');
    });

    it('prefixes names that start with a digit', () => {
      assert.equal(rubyTarget.rubyName('2fa'), '_2fa');
    });
  });

  describe('dedupCrossCategory', () => {
    const byRubyName = (m: any) => rubyTarget.rubyName(m.name);
    const dedup = (props: any[], methods: any[]) =>
      rubyTarget.dedupCrossCategory(
        props,
        methods,
        byRubyName,
        byRubyName,
        'test.Type',
      );

    it('passes through non-colliding members', () => {
      const props = [{ name: 'fooBar' }];
      const methods = [{ name: 'doThing' }];
      assert.deepEqual(dedup(props, methods), { props, methods });
    });

    it('does not treat a static and an instance member as colliding', () => {
      const props = [{ name: 'value', static: true }];
      const methods = [{ name: 'value' }];
      assert.deepEqual(dedup(props, methods), { props, methods });
    });

    it('drops the deprecated side of a property/method collision', () => {
      const prop = { name: 'fooBar', docs: { deprecated: 'use foo_bar()' } };
      const method = { name: 'foo_bar' };
      assert.deepEqual(dedup([prop], [method]), {
        props: [],
        methods: [method],
      });
    });

    it('throws when a property and a method collide and neither is deprecated', () => {
      assert.throws(
        () => dedup([{ name: 'fooBar' }], [{ name: 'foo_bar' }]),
        /property 'fooBar', method 'foo_bar'/,
      );
    });

    it('throws when every colliding member is deprecated', () => {
      assert.throws(
        () =>
          dedup(
            [{ name: 'fooBar', docs: { deprecated: 'x' } }],
            [{ name: 'foo_bar', docs: { deprecated: 'y' } }],
          ),
        /cannot pick a winner/,
      );
    });
  });

  describe('rubyFullTypeName with submodules', () => {
    // Swap in a mock assembly, run the assertion, restore.
    function withAssembly(mock: unknown, fn: () => void) {
      const original = rubyTarget.assembly;
      Object.defineProperty(rubyTarget, 'assembly', {
        value: mock,
        configurable: true,
      });
      try {
        fn();
      } finally {
        Object.defineProperty(rubyTarget, 'assembly', {
          value: original,
          configurable: true,
        });
      }
    }

    it('respects explicit submodule targets', () => {
      const mockConfig = {
        name: 'aws-cdk-lib',
        targets: { ruby: { module: 'AWSCDK' } },
        submodules: {
          'aws-cdk-lib.aws_dynamodb': {
            targets: { ruby: { module: 'AWSCDK::DynamoDB' } },
          },
          'aws-cdk-lib.aws_dynamodb.nested': {
            targets: { ruby: { module: 'AWSCDK::DynamoDB::Nested' } },
          },
        },
      };

      withAssembly(mockConfig, () => {
        assert.equal(
          rubyTarget.rubyFullTypeName('aws-cdk-lib.aws_dynamodb.Table'),
          'AWSCDK::DynamoDB::Table',
        );
        assert.equal(
          rubyTarget.rubyFullTypeName('aws-cdk-lib.aws_dynamodb.nested.Type'),
          'AWSCDK::DynamoDB::Nested::Type',
        );
        // Fallback for unconfigured submodule
        assert.equal(
          rubyTarget.rubyFullTypeName('aws-cdk-lib.aws_s3.Bucket'),
          'AWSCDK::AwsS3::Bucket',
        );
      });
    });

    it('rejects submodule modules that do not extend the assembly module', () => {
      const mockConfig = {
        name: 'aws-cdk-lib',
        targets: { ruby: { module: 'AWSCDK' } },
        submodules: {
          'aws-cdk-lib.rogue': {
            // Replaces the root instead of extending it — relative-namespace
            // slicing would emit types into the wrong module.
            targets: { ruby: { module: 'Flat' } },
          },
        },
      };

      withAssembly(mockConfig, () => {
        assert.throws(
          () => rubyTarget.relativeRubyNamespace('aws-cdk-lib.rogue.Type'),
          /does not live under its assembly's module 'AWSCDK'/,
        );
      });
    });
  });
});
