#!/usr/bin/env bash
# Generate the Ruby bindings for the jsii-calc fixture assemblies into ./lib,
# where spec/spec_helper.rb expects to find them — using THIS plugin, exactly
# the way an end user would: stock jsii-pacmak with `--plugin`.
#
# The test scripts run this every time, unconditionally — do NOT reintroduce a
# `test -d ./lib || ...` guard. lib/ is gitignored generated output; when it is
# present but stale (built by an older plugin/pacmak) such a guard silently
# runs the specs against months-old bindings and reports phantom failures. This
# script is only a few seconds, so always regenerating is the safe default.
set -euo pipefail

cd "$(dirname "$0")"

genRoot="./lib"

# Clean up any previously-generated bindings so stale types don't linger when
# an assembly is removed or renamed upstream.
rm -rf "${genRoot}"

# Rebuild the plugin so --plugin resolves to fresh output, not a stale lib/.
node ../node_modules/typescript/bin/tsc --build ..

# `--code-only` skips `gem build`, which would require RubyGems to be present
# in every environment that generates.  The specs do not consume a built .gem —
# they load the generated sources under lib/ directly via $LOAD_PATH (see
# spec/spec_helper.rb).
#
# `--recurse` pacmaks jsii-calc *and* the whole dependency closure
# (@scope/jsii-calc-{lib,base,base-of-base}), so we only need to pass the
# top-level assembly here.
#
# `--force-target`: the upstream fixtures carry no `jsii.targets.ruby` config
# (external-language config never lands in an AWS repo), so pacmak would skip
# them.  The generator's defaults derive the same gem/module names an explicit
# config would state (jsii-calc/JsiiCalc, scope-jsii-calc-lib/
# Scope::JsiiCalcLib, ...).  The planned pacmak `--target-config` overlay is
# the general answer for names the defaults cannot derive.
node ../node_modules/jsii-pacmak/bin/jsii-pacmak \
  --plugin .. \
  -t ruby --code-only --recurse --force-target \
  -o "${genRoot}" \
  ../node_modules/jsii-calc
