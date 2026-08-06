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
with the published `@jsii/runtime`: **152 examples, 0 failures**; all
generated files pass `ruby -c`.

Consumed at runtime by the [`jsii-ruby-runtime` gem](https://github.com/omarqureshi/jsii/tree/ruby-language-bindings/packages/%40jsii/ruby-runtime).

## Status: spike

- Depends on the (experimental) pacmak plugin API — `--plugin` support and
  plugin API v0.1.0, currently on the `jsii-language-plugins` branch of the
  jsii fork, proposed as deliverable D1 of the plugin RFC.
- `@example`/README code blocks are emitted as TypeScript verbatim: Ruby
  translation needs a Ruby-capable jsii-rosetta, which is the RFC's phase-2
  (D3) deliverable. Inline prose code refs are still rubified.
- `node_modules` is symlinked into a sibling jsii monorepo checkout for
  development; published packaging comes with the RFC's D1 landing.
