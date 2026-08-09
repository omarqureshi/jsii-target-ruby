/**
 * RBS signature generation: emits `sig/<assembly>.rbs` mirroring the
 * generated Ruby, so Steep/TypeProf users get static checking and editor
 * completion.
 *
 * Names come from the SAME mappers the `.rb` emission uses — the pure ones
 * imported from helpers, the assembly-bound ones via the host interface —
 * so signatures line up with the real methods by construction.
 */
import * as path from 'path';

import * as spec from '@jsii/spec';
import * as fs from 'fs-extra';
import * as reflect from 'jsii-reflect';

import { dedupByRubyName, dedupCrossCategory, rubyConstName, rubyName } from './helpers';

/**
 * The slice of the Ruby generator the RBS emitter depends on — only the
 * genuinely generator-bound parts (assembly-aware naming and type
 * normalization); pure helpers are imported directly.
 */
export interface RbsHost {
  rubyFullTypeName(fqn: string): string;
  rubyPropertyName(prop: reflect.Property): string;
  rubyMethodName(method: reflect.Method): string;
  typeRefSpec(ref: unknown): spec.TypeReference | undefined;
  isStructFqn(fqn: string): boolean;
}

/**
 * Emit `sig/<assembly>.rbs` for the given types. Uses fully-qualified
 * declaration headers (`class A::B::C`) with empty namespace-module
 * predeclarations, which keeps emission order-independent (RBS resolves a
 * file as a whole).
 */
export async function generateRbs(
  host: RbsHost,
  assemblyName: string,
  outdir: string,
  sortedTypes: reflect.Type[],
): Promise<void> {
  const lines: string[] = [];

  // Ruby paths that are emitted as classes (jsii classes + datatype
  // interfaces) — we must NOT also predeclare them as namespace modules.
  const classPaths = new Set<string>();
  for (const type of sortedTypes) {
    if (
      type.isClassType() ||
      (type.isInterfaceType() && type.spec.datatype)
    ) {
      classPaths.add(host.rubyFullTypeName(type.fqn));
    }
  }

  // Predeclare every pure-namespace module fragment (every fqn prefix that
  // isn't itself a class path).
  const namespaces = new Set<string>();
  for (const type of sortedTypes) {
    const parts = host.rubyFullTypeName(type.fqn).split('::');
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}::${parts[i]}` : parts[i];
      if (!classPaths.has(current)) {
        namespaces.add(current);
      }
    }
  }
  for (const ns of Array.from(namespaces).sort(
    (a, b) => a.split('::').length - b.split('::').length,
  )) {
    lines.push(`module ${ns} end`);
  }
  if (namespaces.size > 0) {
    lines.push('');
  }

  for (const type of sortedTypes) {
    if (type.isEnumType()) {
      emitRbsEnum(host, type, lines);
    } else if (type.isInterfaceType()) {
      emitRbsInterface(host, type, lines);
    } else if (type.isClassType()) {
      emitRbsClass(host, type, lines);
    }
  }

  const sigPath = path.join(outdir, 'sig', `${assemblyName}.rbs`);
  await fs.mkdir(path.dirname(sigPath), { recursive: true });
  await fs.writeFile(sigPath, `${lines.join('\n')}\n`, 'utf-8');
}

/**
 * RBS type for an *output* position (returns, attribute readers).
 */
export function rbsType(
  host: RbsHost,
  ref: spec.TypeReference | undefined,
  optional = false,
): string {
  const bare = rbsTypeBare(host, ref);
  // `untyped` already admits nil; don't double-decorate.
  return optional && bare !== 'untyped' ? `${bare}?` : bare;
}

function rbsTypeBare(host: RbsHost, ref: spec.TypeReference | undefined): string {
  if (!ref) {
    return 'untyped';
  }
  if (spec.isPrimitiveTypeReference(ref)) {
    switch (ref.primitive) {
      case spec.PrimitiveType.String:
        return 'String';
      case spec.PrimitiveType.Number:
        return 'Numeric';
      case spec.PrimitiveType.Boolean:
        return 'bool';
      case spec.PrimitiveType.Date:
        return 'DateTime';
      // `json` is recursively any-shaped and `any` is the escape hatch;
      // both are honestly `untyped` rather than a flattened Hash/Object.
      case spec.PrimitiveType.Json:
      case spec.PrimitiveType.Any:
        return 'untyped';
    }
  }
  if (spec.isNamedTypeReference(ref)) {
    return `::${host.rubyFullTypeName(ref.fqn)}`;
  }
  if (spec.isCollectionTypeReference(ref)) {
    const elem = rbsTypeBare(host, ref.collection.elementtype);
    return ref.collection.kind === spec.CollectionKind.Array
      ? `Array[${elem}]`
      : `Hash[String, ${elem}]`;
  }
  if (spec.isUnionTypeReference(ref)) {
    const arms = [
      ...new Set(ref.union.types.map((t) => rbsTypeBare(host, t))),
    ];
    // A bare `A | B` collides with RBS's method-overload separator, so
    // unions must be parenthesized to be valid in return/param position.
    return arms.length === 1 ? arms[0] : `(${arms.join(' | ')})`;
  }
  return 'untyped';
}

/**
 * RBS type for a *parameter* position.  Struct-typed inputs also accept the
 * idiomatic hash-literal form — the runtime coerces hashes into structs on
 * serialization, recursively through arrays, maps and union arms — so the
 * parameter surface widens struct references to `(Struct | Hash[Symbol,
 * untyped])`.  Output positions (returns, attribute readers) keep the bare
 * struct type: values coming back from the kernel are always hydrated
 * struct instances, never hashes.
 */
export function rbsParamType(
  host: RbsHost,
  ref: spec.TypeReference | undefined,
  optional = false,
): string {
  const bare = rbsParamTypeBare(host, ref);
  return optional && bare !== 'untyped' ? `${bare}?` : bare;
}

function rbsParamTypeBare(host: RbsHost, ref: spec.TypeReference | undefined): string {
  if (!ref) {
    return 'untyped';
  }
  if (spec.isNamedTypeReference(ref) && host.isStructFqn(ref.fqn)) {
    return `(::${host.rubyFullTypeName(ref.fqn)} | Hash[Symbol, untyped])`;
  }
  if (spec.isCollectionTypeReference(ref)) {
    const elem = rbsParamTypeBare(host, ref.collection.elementtype);
    return ref.collection.kind === spec.CollectionKind.Array
      ? `Array[${elem}]`
      : `Hash[String, ${elem}]`;
  }
  if (spec.isUnionTypeReference(ref)) {
    const arms = [
      ...new Set(ref.union.types.map((t) => rbsParamTypeBare(host, t))),
    ];
    return arms.length === 1 ? arms[0] : `(${arms.join(' | ')})`;
  }
  return rbsTypeBare(host, ref);
}

/** RBS parameter list for a callable's parameters. */
function rbsParams(host: RbsHost, params: readonly any[]): string {
  return params
    .map((p) => {
      const name = rubyName(p.name);
      if (p.variadic) {
        return `*${rbsParamTypeBare(host, host.typeRefSpec(p.type))} ${name}`;
      }
      const t = rbsParamType(host, host.typeRefSpec(p.type), p.optional);
      return p.optional ? `?${t} ${name}` : `${t} ${name}`;
    })
    .join(', ');
}

/** RBS return type for a method (`void` when it declares no return). */
function rbsReturn(host: RbsHost, method: any): string {
  const ret = method.spec?.returns;
  return ret?.type
    ? rbsType(host, host.typeRefSpec(ret.type), ret.optional)
    : 'void';
}

function emitRbsEnum(host: RbsHost, typeSpec: reflect.EnumType, lines: string[]): void {
  const members = dedupByRubyName(
    typeSpec.members,
    (m) => rubyConstName(m.name),
    typeSpec.fqn,
  );
  lines.push(`module ${host.rubyFullTypeName(typeSpec.fqn)}`);
  for (const m of members) {
    lines.push(`  ${rubyConstName(m.name)}: ::Jsii::Enum`);
  }
  lines.push('end', '');
}

function emitRbsInterface(
  host: RbsHost,
  typeSpec: reflect.InterfaceType,
  lines: string[],
): void {
  const { props, methods } = dedupCrossCategory(
    dedupByRubyName(
      typeSpec.allProperties,
      (p) => rubyName(p.name),
      typeSpec.fqn,
    ),
    dedupByRubyName(
      typeSpec.allMethods,
      (m) => rubyName(m.name),
      typeSpec.fqn,
    ),
    (p) => rubyName(p.name),
    (m) => rubyName(m.name),
    typeSpec.fqn,
  );
  const full = host.rubyFullTypeName(typeSpec.fqn);

  if (typeSpec.datatype) {
    // Struct → value class with a kwargs constructor + readers.
    const bases = typeSpec.spec.interfaces ?? [];
    const base =
      bases.length > 0
        ? `::${host.rubyFullTypeName(bases[0])}`
        : '::Jsii::Struct';
    lines.push(`class ${full} < ${base}`);
    const kwargs = props
      .map((p) => {
        // Constructor kwargs are input positions too: nested struct values
        // may be given as hashes (coerced at serialization).
        const t = rbsParamType(host, host.typeRefSpec(p.type), p.optional);
        return p.optional
          ? `?${rubyName(p.name)}: ${t}`
          : `${rubyName(p.name)}: ${t}`;
      })
      .join(', ');
    lines.push(`  def initialize: (${kwargs}) -> void`);
    for (const p of props) {
      lines.push(
        `  attr_reader ${rubyName(p.name)}: ${rbsType(host, host.typeRefSpec(p.type), p.optional)}`,
      );
    }
    lines.push('end', '');
    return;
  }

  // Behavioral interface → module of method/property signatures.
  lines.push(`module ${full}`);
  for (const p of props) {
    const t = rbsType(host, host.typeRefSpec(p.type), p.optional);
    lines.push(`  attr_reader ${rubyName(p.name)}: ${t}`);
    if (!p.immutable) {
      // Writers are INPUT positions: the generated setter coerces a hash
      // literal into the struct, so the signature has to admit it too —
      // otherwise a type checker rejects the idiomatic call the docs show.
      lines.push(
        `  attr_writer ${rubyName(p.name)}: ${rbsParamType(host, host.typeRefSpec(p.type), p.optional)}`,
      );
    }
  }
  for (const m of methods) {
    lines.push(
      `  def ${rubyName(m.name)}: (${rbsParams(host, m.parameters)}) -> ${rbsReturn(host, m)}`,
    );
  }
  lines.push('end', '');
}

function emitRbsClass(host: RbsHost, typeSpec: reflect.ClassType, lines: string[]): void {
  const { props, methods } = dedupCrossCategory(
    dedupByRubyName(
      typeSpec.allProperties,
      (p) => host.rubyPropertyName(p),
      typeSpec.fqn,
    ),
    dedupByRubyName(
      typeSpec.allMethods,
      (m) => host.rubyMethodName(m),
      typeSpec.fqn,
    ),
    (p) => host.rubyPropertyName(p),
    (m) => host.rubyMethodName(m),
    typeSpec.fqn,
  );
  const full = host.rubyFullTypeName(typeSpec.fqn);
  const base = typeSpec.spec.base
    ? `::${host.rubyFullTypeName(typeSpec.spec.base)}`
    : '::Jsii::Object';

  lines.push(`class ${full} < ${base}`);
  for (const iface of typeSpec.spec.interfaces ?? []) {
    lines.push(`  include ::${host.rubyFullTypeName(iface)}`);
  }

  const init = typeSpec.spec.initializer;
  if (init && init.parameters && init.parameters.length > 0) {
    lines.push(
      `  def initialize: (${rbsParams(host, init.parameters)}) -> void`,
    );
  } else if (init) {
    lines.push('  def initialize: () -> void');
  }

  for (const p of props) {
    const t = rbsType(host, host.typeRefSpec(p.type), p.optional);
    if (p.static) {
      // Statics (incl. const props) are generated as singleton getter/
      // setter methods, not Ruby attributes — emit `def self.` sigs.
      const name = host.rubyPropertyName(p);
      lines.push(`  def self.${name}: () -> ${t}`);
      if (!p.immutable) {
        lines.push(`  def self.${name}=: (${t}) -> ${t}`);
      }
      continue;
    }
    lines.push(`  attr_reader ${rubyName(p.name)}: ${t}`);
    if (!p.immutable) {
      // Writers are INPUT positions: the generated setter coerces a hash
      // literal into the struct, so the signature has to admit it too —
      // otherwise a type checker rejects the idiomatic call the docs show.
      lines.push(
        `  attr_writer ${rubyName(p.name)}: ${rbsParamType(host, host.typeRefSpec(p.type), p.optional)}`,
      );
    }
  }
  for (const m of methods) {
    const recv = m.static ? 'self.' : '';
    lines.push(
      `  def ${recv}${host.rubyMethodName(m)}: (${rbsParams(host, m.parameters)}) -> ${rbsReturn(host, m)}`,
    );
  }
  lines.push('end', '');
}
