/**
 * Shared helpers for the Ruby target: case conversions, identifier escaping,
 * reserved-name handling, and the member-collision (dedup) passes. Everything
 * here is a pure function of its inputs — no generator state.
 */
import { toPascalCase, toSnakeCase } from 'codemaker';

// One import site for every case conversion the target uses.
export { toPascalCase, toSnakeCase };

/**
 * SCREAMING_SNAKE_CASE — the casing of Ruby constants (enum members).
 * Characters that cannot appear in a Ruby constant collapse to `_`.
 */
export function toScreamingSnakeCase(name: string): string {
  return toSnakeCase(name)
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_');
}

/**
 * Escape a string for use inside a Ruby single-quoted ('...') literal.
 * Single-quoted strings only treat `\\` and `\'` specially.
 */
export function rubySq(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Escape a string for literal use inside a RegExp pattern.
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render a JS value as a Ruby expression that evaluates to JSON.parse of the
 * value's canonical JSON encoding.  Base64 keeps the embedded literal safe
 * from any input — no backslashes, quotes, `#{...}`, or newlines to escape.
 * Replaces the previous `%q{${JSON.stringify(...)}}` pattern, which silently
 * mangled any backslash in the JSON (Ruby's `%q{}` does not preserve `\\`).
 */
export function rubyJsonLiteral(value: any): string {
  const json = JSON.stringify(value ?? { primitive: 'any' });
  const b64 = Buffer.from(json, 'utf-8').toString('base64');
  return `JSON.parse(Base64.strict_decode64("${b64}"))`;
}

/**
 * Whether a jsii member (method, property, or enum value) is marked
 * `@deprecated` in the source assembly.  Used by the collision-resolution
 * passes to pick a winning member when multiple snake_case to the same name.
 *
 * The reflect API exposes two shapes:
 *   - Plain spec objects (used by enum members `typeSpec.members`):
 *     `docs?.deprecated` is `string | undefined`.
 *   - `Documentable.docs` instances (used by `allProperties` / `allMethods`):
 *     `.docs.deprecated` is a boolean that also reflects the parent type's
 *     deprecation status.
 * We treat any truthy value on either shape as deprecated.
 */
export function isDeprecated(member: { docs?: { deprecated?: unknown } }): boolean {
  return !!member.docs?.deprecated;
}

/**
 * Minimal structural shape required by the member-collision passes —
 * satisfied by reflect members (whose `docs.deprecated` is a boolean) and
 * raw spec members (where it is a string reason).
 */
export interface MemberLike {
  readonly name: string;
  readonly static?: boolean;
  readonly docs?: { readonly deprecated?: unknown };
}

/**
 * Names that must be renamed (with a leading underscore) when used as Ruby
 * method/parameter identifiers.  Includes:
 *   - Ruby keywords (`end`, `class`, `def`, ...).  Using one as a method
 *     name produces a parse error.
 *   - The handful of Object methods the runtime hard-depends on
 *     (`send`, `__send__`) — without these the kernel can't dispatch back
 *     into a Ruby override.
 *   - Names the Ruby object model or the jsii runtime itself depends on:
 *     `initialize` (a member by that name would silently replace the
 *     generated constructor), `new` / `allocate` (class methods used to
 *     instantiate proxies — the registry hydrates refs via
 *     `klass.allocate`), `to_jsii` (struct serialization) and `ruby_class`
 *     (internal dispatch helper).
 *   - Additionally (not in this set — see `rubyName`): any name beginning
 *     with `jsii_` is prefixed, so generated members can never shadow the
 *     runtime's own API surface (`jsii_ref`, `jsii_serialize`,
 *     `jsii_call_method`, `jsii_properties`, ...), present or future.
 *
 * Other Object/Kernel methods (`method`, `methods`, `inspect`, `to_s`,
 * `hash`, ...) are deliberately NOT renamed: jsii-calc and real-world
 * assemblies use these names for legitimate JSII methods, and the
 * shadowing cost is mild (those methods are still reachable via
 * `Object.instance_method(:foo).bind(self).call(...)` or `__send__`).
 *
 * Must stay in sync with `Jsii::Utils::RUBY_RESERVED_NAMES` in
 * runtime/lib/jsii/utils.rb (enforced by compliance/spec/unit/utils_spec.rb),
 * so kernel callbacks dispatch to the renamed member.
 */
export const RUBY_RESERVED_NAMES = new Set([
  // Keywords
  'alias',
  'and',
  'begin',
  'break',
  'case',
  'class',
  'def',
  // NB: unreachable — toSnakeCase strips the question mark before lookup —
  // kept so the list reads as the complete Ruby keyword set.
  'defined?',
  'do',
  'else',
  'elsif',
  'end',
  'ensure',
  'false',
  'for',
  'if',
  'in',
  'module',
  'next',
  'nil',
  'not',
  'or',
  'redo',
  'rescue',
  'retry',
  'return',
  'self',
  'super',
  'then',
  'true',
  'undef',
  'unless',
  'until',
  'when',
  'while',
  'yield',
  // Hard runtime dependencies (callbacks use `__send__` for dispatch).
  'send',
  '__send__',
  // Ruby object-model / jsii-runtime hooks (see doc comment above).
  'initialize',
  'new',
  'allocate',
  'to_jsii',
  'ruby_class',
]);

/**
 * Member (method/property/parameter) name in Ruby: snake_case, with a `_`
 * prefix for reserved names, the runtime's `jsii_` namespace, and
 * digit-leading names (invalid Ruby identifiers).
 */
export function rubyName(name: string): string {
  const snake = toSnakeCase(name);
  if (RUBY_RESERVED_NAMES.has(snake)) {
    return `_${snake}`;
  }
  // The `jsii_` prefix is reserved for the runtime's own API surface
  // (`jsii_ref`, `jsii_serialize`, `jsii_call_method`, ...) — prefix any
  // member that would land in it so generated code can never shadow a
  // runtime method, present or future.
  if (snake.startsWith('jsii_')) {
    return `_${snake}`;
  }
  // Names starting with a digit are invalid Ruby identifiers.
  if (/^\d/.test(snake)) {
    return `_${snake}`;
  }
  return snake;
}

/**
 * Ruby constant name for an enum member: SCREAMING_SNAKE, `V_`-prefixed when
 * digit-leading (constants must start with a letter).
 */
export function rubyConstName(name: string): string {
  const constName = toScreamingSnakeCase(name);
  if (/^[0-9]/.test(constName)) {
    return `V_${constName}`;
  }
  return constName;
}

/**
 * The acronym list an assembly (or submodule) declares for module-name
 * casing (`targets.ruby.acronyms`).  Acronym casing is library data, not
 * generator knowledge; blank or non-string entries are discarded.
 */
export function assemblyAcronyms(config: { targets?: { ruby?: { acronyms?: unknown } } } | undefined): string[] {
  const list = (config?.targets as any)?.ruby?.acronyms ?? [];
  return (list as unknown[]).filter(
    (a: unknown): a is string => typeof a === 'string' && a.length > 0,
  );
}

/**
 * Module/type-name conversion: PascalCase with `::` nesting for scoped
 * packages, hyphen segments concatenated, declared acronyms case-restored
 * (word-boundary aware, literal not pattern), and a `V_` prefix when the
 * result cannot open a Ruby constant.
 */
export function rubyModuleName(name: string, acronyms: string[] = []): string {
  // Handle scoped packages: @scope/package -> Scope::Package
  if (name.startsWith('@')) {
    const parts = name.slice(1).split('/');
    return parts.map((p) => rubyModuleName(p, acronyms)).join('::');
  }

  // Handle hyphens: jsii-calc -> JsiiCalc
  if (name.includes('-')) {
    const parts = name.split('-');
    return parts.map((p) => rubyModuleName(p, acronyms)).join('');
  }

  const sanitized = name.replace(/[^a-zA-Z0-9_]/g, '');
  let pascal =
    sanitized.charAt(0) === sanitized.charAt(0).toUpperCase()
      ? sanitized
      : toPascalCase(sanitized);

  for (const acronym of acronyms) {
    // Find the acronym case-insensitively. A match is only considered a valid
    // word boundary if it starts with a capital letter and is followed by either
    // another capital letter, a digit, an 's' (for plurals), or the end of the string.
    // The acronym is config-supplied text, not a pattern — escape it.
    const regex = new RegExp(`(${escapeRegExp(acronym)})`, 'ig');
    pascal = pascal.replace(regex, (match, _p1, offset) => {
      if (match[0] !== match[0].toUpperCase()) return match;

      const nextChar = pascal[offset + match.length];
      if (nextChar) {
        // Must be uppercase, digit, or 's' followed by uppercase, digit, or end of string
        const isValid =
          /^[A-Z0-9]$/.test(nextChar) ||
          (nextChar === 's' &&
            (!pascal[offset + match.length + 1] ||
              /^[A-Z0-9]$/.test(pascal[offset + match.length + 1])));
        if (!isValid) return match;
      }

      return acronym;
    });
  }

  // Ruby constants must start with an uppercase letter.  npm allows
  // package names like `3d-tools` (and leading underscores), which would
  // otherwise produce invalid constants like `3dTools`.  Prefix with `V_`,
  // mirroring rubyConstName's treatment of digit-leading enum members.
  if (!/^[A-Z]/.test(pascal)) {
    pascal = `V_${pascal}`;
  }

  return pascal;
}

/**
 * Resolve property/method collisions ACROSS the two member categories: a
 * property and a method converging on one Ruby name is fatal unless
 * deprecation picks a single winner (the deprecated side is dropped).
 * Statics and instance members do not collide with each other.
 */
export function dedupCrossCategory<P extends MemberLike, M extends MemberLike>(
  props: P[],
  methods: M[],
  propRubyName: (p: P) => string,
  methodRubyName: (m: M) => string,
  fqn: string,
): { props: P[]; methods: M[] } {
  const buckets = new Map<string, Array<{ member: P | M; isProp: boolean }>>();
  const add = (member: P | M, isProp: boolean, name: string) => {
    const key = `${member.static ? 'static' : 'instance'}:${name}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push({ member, isProp });
    buckets.set(key, bucket);
  };
  for (const p of props) add(p, true, propRubyName(p));
  for (const m of methods) add(m, false, methodRubyName(m));

  const dropped = new Set<any>();
  for (const [key, bucket] of buckets) {
    if (bucket.length === 1) {
      continue;
    }
    const rubyKey = key.split(':')[1];
    const nonDeprecated = bucket.filter((e) => !isDeprecated(e.member));
    if (nonDeprecated.length === 0) {
      throw new Error(
        `All members mapping to Ruby name '${rubyKey}' on ${fqn} are ` +
          `deprecated; cannot pick a winner.  jsii names: ${bucket
            .map((e) => `'${e.member.name}'`)
            .join(', ')}`,
      );
    }
    if (nonDeprecated.length > 1) {
      throw new Error(
        `A property and a method on ${fqn} both map to Ruby name ` +
          `'${rubyKey}': ${nonDeprecated
            .map(
              (e) => `${e.isProp ? 'property' : 'method'} '${e.member.name}'`,
            )
            .join(
              ', ',
            )}.  Mark all but one deprecated (or rename) to disambiguate.`,
      );
    }
    for (const e of bucket) {
      if (e !== nonDeprecated[0]) {
        dropped.add(e.member);
      }
    }
  }

  return {
    props: props.filter((p) => !dropped.has(p)),
    methods: methods.filter((m) => !dropped.has(m)),
  };
}

/**
 * Resolve collisions WITHIN one member category (e.g. two enum members
 * snake_casing identically): deprecation picks the single winner, anything
 * else is fatal.
 */
export function dedupByRubyName<T extends MemberLike>(
  members: readonly T[],
  rubyName_: (m: T) => string,
  fqn: string,
): T[] {
  const byName = new Map<string, T[]>();
  for (const m of members) {
    const key = rubyName_(m);
    const bucket = byName.get(key) ?? [];
    bucket.push(m);
    byName.set(key, bucket);
  }

  const out: T[] = [];
  for (const [rubyKey, bucket] of byName) {
    if (bucket.length === 1) {
      out.push(bucket[0]);
      continue;
    }
    const nonDeprecated = bucket.filter((m) => !isDeprecated(m));
    if (nonDeprecated.length === 0) {
      throw new Error(
        `All members mapping to Ruby name '${rubyKey}' on ${fqn} are ` +
          `deprecated; cannot pick a winner.  jsii names: ${bucket
            .map((m) => `'${m.name}'`)
            .join(', ')}`,
      );
    }
    if (nonDeprecated.length > 1) {
      throw new Error(
        `Multiple non-deprecated members map to Ruby name '${rubyKey}' ` +
          `on ${fqn}: ${nonDeprecated
            .map((m) => `'${m.name}'`)
            .join(
              ', ',
            )}.  Mark all but one deprecated (or rename) to disambiguate.`,
      );
    }
    out.push(nonDeprecated[0]);
  }
  return out;
}
