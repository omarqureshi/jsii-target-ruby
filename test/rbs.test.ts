import * as assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as spec from '@jsii/spec';

import { attrSignatures, rbsParamType, rbsType, RbsHost } from '../src/rbs';

// The whole-file output of generateRbs is validated by the compliance
// suite's rbs_spec.rb, which runs the real `rbs` tool over the generated
// signatures for the jsii-calc closure. These tests pin the type-mapping
// functions directly against a minimal host.

const host: RbsHost = {
  rubyFullTypeName: (fqn) => fqn.replace('my_assembly.', 'MyAsm::'),
  rubyPropertyName: (p: any) => p.name,
  rubyMethodName: (m: any) => m.name,
  typeRefSpec: (ref: any) => ref,
  isStructFqn: (fqn) => fqn.endsWith('Props'),
};

const STRING: spec.TypeReference = { primitive: spec.PrimitiveType.String };
const NUMBER: spec.TypeReference = { primitive: spec.PrimitiveType.Number };
const STRUCT: spec.TypeReference = { fqn: 'my_assembly.BucketProps' };
const CLASS: spec.TypeReference = { fqn: 'my_assembly.Bucket' };

describe('rbsType (output positions)', () => {
  test('primitives', () => {
    assert.equal(rbsType(host, STRING), 'String');
    assert.equal(rbsType(host, NUMBER), 'Numeric');
    assert.equal(rbsType(host, { primitive: spec.PrimitiveType.Boolean }), 'bool');
    assert.equal(rbsType(host, { primitive: spec.PrimitiveType.Date }), 'DateTime');
    assert.equal(rbsType(host, { primitive: spec.PrimitiveType.Json }), 'untyped');
    assert.equal(rbsType(host, { primitive: spec.PrimitiveType.Any }), 'untyped');
    assert.equal(rbsType(host, undefined), 'untyped');
  });

  test('named types are fully qualified through the host', () => {
    assert.equal(rbsType(host, CLASS), '::MyAsm::Bucket');
  });

  test('collections', () => {
    assert.equal(
      rbsType(host, { collection: { kind: spec.CollectionKind.Array, elementtype: STRING } }),
      'Array[String]',
    );
    assert.equal(
      rbsType(host, { collection: { kind: spec.CollectionKind.Map, elementtype: NUMBER } }),
      'Hash[String, Numeric]',
    );
  });

  test('unions parenthesize (RBS overload-separator collision) and dedupe arms', () => {
    assert.equal(rbsType(host, { union: { types: [STRING, NUMBER] } }), '(String | Numeric)');
    assert.equal(rbsType(host, { union: { types: [STRING, STRING] } }), 'String');
  });

  test('optional appends ?, but never onto untyped', () => {
    assert.equal(rbsType(host, STRING, true), 'String?');
    assert.equal(rbsType(host, { primitive: spec.PrimitiveType.Any }, true), 'untyped');
  });

  test('output positions keep bare struct types (values come back hydrated)', () => {
    assert.equal(rbsType(host, STRUCT), '::MyAsm::BucketProps');
  });
});

describe('rbsParamType (input positions)', () => {
  test('struct references widen to accept the hash-literal form', () => {
    assert.equal(rbsParamType(host, STRUCT), '(::MyAsm::BucketProps | Hash[Symbol, untyped])');
  });

  test('the widening recurses through collections', () => {
    assert.equal(
      rbsParamType(host, { collection: { kind: spec.CollectionKind.Array, elementtype: STRUCT } }),
      'Array[(::MyAsm::BucketProps | Hash[Symbol, untyped])]',
    );
  });

  test('non-struct named types stay bare', () => {
    assert.equal(rbsParamType(host, CLASS), '::MyAsm::Bucket');
  });

  test('optional struct params keep the widened form with ?', () => {
    assert.equal(
      rbsParamType(host, STRUCT, true),
      '(::MyAsm::BucketProps | Hash[Symbol, untyped])?',
    );
  });
});

describe('attribute signatures', () => {
  test('an immutable property gets a reader only', () => {
    assert.deepEqual(
      attrSignatures(host, { name: 'bucketName', type: STRING, immutable: true } as any),
      ['  attr_reader bucket_name: String'],
    );
  });

  test('a mutable property also gets a writer', () => {
    assert.deepEqual(
      attrSignatures(host, { name: 'bucketName', type: STRING } as any),
      ['  attr_reader bucket_name: String', '  attr_writer bucket_name: String'],
    );
  });

  test('the writer admits a hash literal where the reader does not', () => {
    // Writers are input positions: the generated setter coerces a hash into
    // the struct, so a type checker must accept the call the docs show.
    const [reader, writer] = attrSignatures(host, { name: 'props', type: STRUCT } as any);
    assert.equal(reader, '  attr_reader props: ::MyAsm::BucketProps');
    assert.match(writer, /Hash\[/);
  });

  test('an optional property is nilable in both positions', () => {
    const [reader, writer] = attrSignatures(
      host,
      { name: 'count', type: NUMBER, optional: true } as any,
    );
    assert.match(reader, /\?$|nil/);
    assert.match(writer, /\?$|nil/);
  });
});
