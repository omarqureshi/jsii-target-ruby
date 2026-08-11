#!/usr/bin/env bash
# Generate Ruby bindings for cdk8s and prove they behave like the originals.
#
#   scripts/cdk8s-conformance.sh <workdir> [node_modules-with-cdk8s]
#
# Builds the same chart twice — once from test/cdk8s/app.rb against generated
# Ruby bindings, once from test/cdk8s/app.ts against the npm packages — and
# diffs the synthesized Kubernetes manifests. A difference is a failure.
#
# Why cdk8s specifically: a cdk8s app synthesizes YAML and talks to no cloud
# account, so the comparison is cheap, offline and exact. aws-cdk-lib can be
# checked the same way in principle, but it is 20,268 types against cdk8s's 37
# (plus 785 in cdk8s-plus-27) and needs credentials to go further than synth.
#
# The npm packages are taken from an existing node_modules rather than
# installed, so this runs offline; pass a directory containing cdk8s,
# cdk8s-plus-27 and constructs as the second argument.
set -euo pipefail

WORK="${1:?usage: cdk8s-conformance.sh <workdir> [node_modules-dir]}"
SRC_MODULES="${2:-$(cd "$(dirname "$0")/../../aws-cdk/node_modules" 2>/dev/null && pwd)}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

for pkg in cdk8s cdk8s-plus-27 constructs; do
  [ -d "$SRC_MODULES/$pkg" ] || { echo "missing $pkg in $SRC_MODULES"; exit 1; }
done

rm -rf "$WORK" && mkdir -p "$WORK/node_modules"
for pkg in cdk8s cdk8s-plus-27 constructs; do cp -r "$SRC_MODULES/$pkg" "$WORK/node_modules/$pkg"; done
echo '{"name":"cdk8s-conformance","version":"1.0.0","private":true}' > "$WORK/package.json"

echo "==> generating Ruby bindings (cdk8s-plus-27 pulls cdk8s + constructs via --recurse)"
( cd "$WORK" && JSII_RUBY_TARGET_CONFIG="$HERE/config/cdk8s-targets.json" \
  node "$HERE/../jsii/packages/jsii-pacmak/bin/jsii-pacmak" \
    --plugin "$HERE" -t ruby --code-only --force-target --recurse \
    -o gen node_modules/cdk8s-plus-27 )

RUBY_LIB="$WORK/gen/ruby/lib"
echo "==> generated $(find "$RUBY_LIB" -name '*.rb' | wc -l) Ruby files"

# Every generated file must at least parse; a file that does not is a defect
# no amount of behavioural comparison would reach (it is never loaded).
bad=0
while IFS= read -r f; do ruby -c "$f" >/dev/null 2>&1 || { echo "does not parse: $f"; bad=$((bad + 1)); }; done \
  < <(find "$RUBY_LIB" -name '*.rb')
[ "$bad" -eq 0 ] || { echo "FAIL: $bad generated files do not parse"; exit 1; }
echo "==> all generated files parse"

echo "==> synthesizing from Ruby"
( cd "$WORK" && NODE_PATH="$WORK/node_modules" CDK8S_RUBY_LIB="$RUBY_LIB" \
  ruby -I "$HERE/runtime/lib" "$HERE/test/cdk8s/app.rb" )
mv "$WORK/dist" "$WORK/out-ruby"

echo "==> synthesizing from TypeScript"
cp "$HERE/test/cdk8s/app.ts" "$WORK/app.ts"
( cd "$WORK" && npx --yes esbuild app.ts --bundle --platform=node --outfile=app.js \
    --external:cdk8s --external:cdk8s-plus-27 --external:constructs >/dev/null \
  && node app.js )
mv "$WORK/dist" "$WORK/out-ts"

echo "==> comparing manifests"
if diff -r "$WORK/out-ruby" "$WORK/out-ts"; then
  echo "PASS: Ruby and TypeScript synthesize identical manifests"
else
  echo "FAIL: manifests differ (above)"
  exit 1
fi
