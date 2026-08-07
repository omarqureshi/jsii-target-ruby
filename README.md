# jsii-target-ruby

The Ruby language target for [jsii](https://github.com/aws/jsii), packaged as
an **external jsii-pacmak plugin** — no fork of the jsii toolchain required.
Generates idiomatic Ruby bindings (snake_case members, keyword-argument props,
lazy autoloads, RBS signatures, YARD docs) from any jsii assembly:

```sh
npx jsii-pacmak --plugin jsii-target-ruby -t ruby -o dist -- .
```

Extracted from the [Ruby bindings fork](https://github.com/omarqureshi/jsii)
as the reference implementation for the jsii language-plugin RFC. Validated by
generating the `jsii-calc` fixture closure through **stock upstream
jsii-pacmak** and running the full jsii compliance suite against the output
with the published `@jsii/runtime` — full pass; all generated files pass
`ruby -c`.

The repo carries everything Ruby, per the plugin model (no language content in
AWS repositories):

- `src/` — the pacmak target (code generator), the rosetta visitor, and
  plugin-owned version mapping.
- `runtime/` — the `jsii-ruby-runtime` gem: the Ruby client for the jsii
  kernel that generated bindings load at runtime.
- `test/` — TypeScript unit tests for naming and version mapping
  (`node --test`, no test-framework dependency).
- `compliance/` — the jsii compliance suite plus runtime unit specs (RSpec).
  `generate.sh` regenerates the `jsii-calc` bindings through `--plugin` on
  every run, so the specs always exercise the current generator.

## Testing

```sh
# TypeScript unit tests (naming, version mapping)
npm run test:unit

# Full compliance + runtime specs: regenerates jsii-calc via --plugin,
# then runs RSpec against the generated bindings (requires Ruby >= 3.3)
npm run test:compliance
```

The compliance fixtures upstream carry no `jsii.targets.ruby` configuration
(external-language config never lands in an AWS repo), so `generate.sh` passes
`--force-target` and relies on the generator's default gem/module name
derivation — which produces exactly the names the specs expect. The pacmak
`--target-config` overlay proposed in the RFC is the general mechanism for
names the defaults cannot derive.

## Status: spike

- Depends on the (experimental) pacmak plugin API — `--plugin` support and
  plugin API v0.1.0, currently on the `jsii-language-plugins` branch of the
  jsii fork, proposed as deliverable D1 of the plugin RFC.
- `@example`/README code blocks are emitted as TypeScript verbatim: Ruby
  translation needs a Ruby-capable jsii-rosetta, which is the RFC's phase-2
  (D3) deliverable. Inline prose code refs are still rubified.
- `node_modules` is symlinked into a sibling jsii monorepo checkout for
  development; published packaging comes with the RFC's D1 landing.
