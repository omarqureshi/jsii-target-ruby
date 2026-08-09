# Ruby target: design decisions

The completed version of the decision checklist that `create-jsii-language`
scaffolds for new targets — every question a jsii language binding must
answer, with the answer Ruby chose, why, and where it is enforced. Values
here are LOAD-BEARING: they are published gem, module, and method names.

## Type names

PascalCase modules nested with `::`. Assembly names map by segmentation:
hyphenated packages concatenate (`jsii-calc` → `JsiiCalc`), scoped packages
split on `/` (`@scope/jsii-calc-lib` → `Scope::JsiiCalcLib`). Names that
cannot open a Ruby constant get a `V_` prefix (`3d-tools` → `V_3dTools`,
`_internal` → `V__internal`).

**Acronym casing is library data, not code.** The generator has no built-in
acronym list; casing comes from `targets.ruby.acronyms` (or the overlay —
see below), is scoped per-assembly (never pooled across dependencies), is
matched as literal text with word-boundary awareness (`VpcEndpoint` →
`VPCEndpoint`, but `AWSpecial` stays `AWSpecial`), and blank/non-string
entries are discarded. aws-cdk-lib declares 53 acronyms
(`config/cdk-targets.json`), including two deliberate calls documented
there: `FSX` not AWS's `FSx` branding (the matcher is case-restoring over
PascalCase; mixed-case tokens are only used where declared), and version
suffixes stay lowercase in gem names (`-v6`) with `V2`-style casing only
where explicitly declared.

**Submodules**: explicit `module` config wins and must *extend* the parent
assembly's module (`AWSCDK::S3` under `AWSCDK`; a submodule declaring an
unrelated root is a generation-time error, not a silent remap). Without
config, names derive from the submodule name with the assembly's acronyms.
For aws-cdk-lib, all 328 top-level submodules are explicit entries in the
overlay — harvested from the original fork-era `.jsiirc` decisions — and
`scripts/check-cdk-naming.js` fails the build when an aws-cdk-lib release
adds a submodule with no recorded decision. Nested submodules derive from
their parent.

Enforced in: `src/helpers.ts` (`rubyModuleName`, `assemblyAcronyms`),
`src/ruby.ts` (`rubyFullTypeName`), `test/ruby-names.test.ts`,
`scripts/check-cdk-naming.js`.

## Member names

snake_case via an acronym-collapsing converter: `enforceSSL` →
`enforce_ssl`, `myVPCId` → `my_vpc_id`, `x509Certificate` →
`x509_certificate`. PascalCase (class-like) names pass through untouched.

Three escape classes get a `_` prefix:

1. **Ruby keywords** (`class` → `_class`, `end` → `_end`, …).
2. **Runtime machinery**: `initialize`, `new`, `allocate` (a generated
   member must never clobber construction), `send`, `to_jsii`,
   `ruby_class` (dispatch/serialization hooks).
3. **The reserved `jsii_` namespace**: any member landing there
   (`jsiiSerialize` → `_jsii_serialize`), so the runtime can add
   `jsii_*` API forever without colliding with generated code.

Digit-leading members prefix too (`2fa` → `_2fa`). Cross-category
collisions (a property and a method converging on one snake_case name):
the deprecated side is dropped; if neither or both are deprecated,
generation fails loudly (`cannot pick a winner`) rather than shipping an
ambiguous API. The runtime's `RUBY_RESERVED_NAMES` and the generator's are
asserted identical by a compliance spec that reads this repo's source.

Enforced in: `src/helpers.ts` (`rubyName`, `dedupCrossCategory`),
`test/ruby-names.test.ts`, `compliance/spec/unit/utils_spec.rb`.

## Structs

Keyword arguments / plain hashes in, typed value objects out. Callers write
`Bucket.new(self, 'B', versioned: true)`; nested struct positions accept
plain hashes (coerced recursively); return values materialize as typed
structs with snake_case readers. RBS signatures mirror the hash-literal
form so type checkers accept both spellings.

Enforced in: `compliance/spec/compliance/structs_spec.rb`,
`compliance/spec/unit/hash_coercion_spec.rb`, `spec/unit/rbs_spec.rb`.

## Behavioral interfaces

`include`-able modules (`include AWSCDK::IAM::IResourcePolicyFactory`).
The runtime registers overrides for any interface/virtual method the user
class defines, so plain `def for_resource(resource)` participates in
kernel callbacks — no decorator or registration ceremony. Object identity
round-trips through the object registry.

Enforced in: `compliance/spec/compliance/interfaces_spec.rb`,
`spec/unit/registry_pending_object_spec.rb`, `spec/unit/respond_to_spec.rb`.

## Enums

Module constants: `BucketEncryption::KMS_MANAGED` (SCREAMING_SNAKE members
under a PascalCase constant). Serialized over the wire as `$jsii.enum`
refs.

Enforced in: `compliance/spec/compliance/enums_spec.rb`.

## Union types

Pass-through — Ruby is dynamically typed, so unions need no surface
syntax; the runtime type-checks values at the kernel boundary and raises
idiomatically on mismatch. (`onUnionProperty` treats union-typed
properties as ordinary properties.)

Enforced in: `compliance/spec/compliance/union_types_spec.rb`,
`spec/unit/type_validation_spec.rb`.

## Version scheme

npm semver → RubyGems, with prerelease labels mapped
(`alpha`/`beta`/`rc`/`dev`, plus `post`) and unrepresentable shapes
rejected loudly at generation time: unmappable labels (`1.2.3-pre`),
multiple prerelease labels, and `rc.0`-style non-positive sequences are
errors, never guesses. Ranges: `^`/`~` become `'>= x', '< y'` pairs;
OR-sets are rejected (RubyGems has no native `||`).

**Pinning policy**: the feed publishes the closure atomically, so
`JSII_RUBY_PIN_DEPENDENCIES=exact` pins every inter-gem dependency to the
exact version generated and tested together (`= 2.263.0`), while the
`jsii-ruby-runtime` constraint stays `~> 0.1` — in lockstep with this
plugin's version — so runtime patch releases don't force regenerating the
closure.

Enforced in: `src/version-utils.ts`, `test/version-utils.test.ts`,
`src/gemspec.ts`.

## Callback ergonomics

Sync and async overrides are plain method definitions on subclasses;
`super` works inside an override (the kernel completes the original), and
overrides may call other methods on self. The kernel is single-threaded:
one mutex serializes the wire, and callbacks dispatch on the calling
thread. Property overrides work through the same mechanism. JRuby is not
blocked (no engine check; CRuby ≥ 3.3 is the tested platform).

Enforced in: `compliance/spec/compliance/async_overrides_spec.rb`,
`sync_overrides_spec.rb`, `property_overrides_spec.rb`,
`spec/unit/kernel_concurrency_spec.rb`, `spec/unit/callbacks_spec.rb`.

## Documentation

YARD comments (CommonMark rendered with redcarpet), `@example` blocks
carrying rosetta-translated Ruby (TypeScript verbatim until the rosetta
registry path is active), RBS signatures under `sig/` for editor support
and static checking, and lazy `autoload` trees so requiring a gem with 622
submodules stays fast. The docs site (single-registry YARD build with
cross-module linking + assembly-driven index) builds from `docs-gen/` via
the `publish-docs` workflow.

Enforced in: `spec/unit/autoload_spec.rb`, `spec/unit/rbs_spec.rb`,
`docs-gen/README.md`.

## Packaging

One gem per assembly: generated `.rb` sources, `sig/*.rbs`, and the
embedded `.jsii.tgz` (assembly + original JavaScript), so a gem is
self-contained — the kernel loads the embedded tarball, no npm at
runtime. Gem names derive from npm names (`@scope/pkg` → `scope-pkg`)
unless `targets.ruby.gem` says otherwise. Runtime dependency `base64` is
real (unbundled from Ruby 3.3+ default gems), `required_ruby_version >=
3.3.0`, 2-space indentation.
