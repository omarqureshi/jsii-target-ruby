#!/usr/bin/env bash
# All modules rendered in ONE YARD registry so cross-module type links resolve
# (e.g. S3's `encryption_key : KMS::IKey` links to AWSCDK/KMS/IKey.html). YARD only
# linkifies types present in its registry at render time, so the whole library has to be
# a single `yard doc` run — per-module builds leave those refs as plain text. Output tree
# is AWSCDK/<Module>/<Class>.html (+ shared css/js). Built with the gem lib as CWD so
# "Defined in" paths render clean ("dynamo_db/table.rb"). Finally the theme is applied.
#
# Set PER_MODULE=1 to fall back to isolated per-module builds: crash-safe (each module in
# its own process), but cross-module links won't resolve. Kept as a safety valve.
#
#   build-module-docs.sh <gem-lib-dir> <out-dir> [module ...]   (no args = all)
set -euo pipefail
GEM_LIB="$(cd "$1" && pwd)"; OUT="$(mkdir -p "$2" && cd "$2" && pwd)"; shift 2
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$(ruby -e 'print Gem.user_dir')/bin:$PATH"

# YARD's parser/registry recurse deeply on the big modules (interfaces is ~3.3k files)
# and SystemStackError. BOTH raises below are required — neither alone is enough
# (verified on `interfaces`): they clear two different limits hit at two different phases.
# Raise only the C/machine stack and it still dies in the registry resolver
# (YARD::Registry.at) when the VM frame stack fills; raise only the VM stack and it dies
# in the parser (ruby_parser Array.new) when the C stack fills. Set both. Best-effort.
ulimit -s unlimited 2>/dev/null || ulimit -s 1048576 2>/dev/null || true
export RUBY_THREAD_VM_STACK_SIZE="${RUBY_THREAD_VM_STACK_SIZE:-536870912}"

# jsii docs (and the module READMEs) are CommonMark. Render with redcarpet: it handles
# fenced ```ruby blocks *and* YARD then applies its own highlighter to them, so README
# examples get the same token markup as inline @example blocks. (kramdown's default mode
# doesn't recognise ``` fences; its GFM mode uses a different, unthemed highlighter.)
MARKUP=(--markup markdown --markup-provider redcarpet)

modules=("$@")
[ ${#modules[@]} -eq 0 ] && modules=($(ls "$GEM_LIB"))
mkdir -p "$OUT/AWSCDK"
cd "$GEM_LIB"

# Keep only real module dirs (relative names, so "Defined in" paths stay clean).
mods=()
for mod in "${modules[@]}"; do
  [ -d "$GEM_LIB/$mod" ] && mods+=("$mod") || echo "skip $mod (no dir)"
done
[ ${#mods[@]} -eq 0 ] && { echo "no modules to build"; exit 0; }

if [ "${PER_MODULE:-0}" = 1 ]; then
  # Fallback: isolated per-module builds. Crash-safe, but cross-module links stay plain.
  for mod in "${mods[@]}"; do
    tmp=$(mktemp -d)
    mapfile -t files < <(find "$mod" -name '*.rb')   # relative paths -> clean "Defined in"
    if [ ${#files[@]} -gt 0 ]; then
      printf 'yard %-22s %s files\n' "$mod" "${#files[@]}"
      if yard doc "${files[@]}" -o "$tmp" --no-cache --no-progress -q "${MARKUP[@]}" 2>/dev/null; then
        cp -r "$tmp/." "$OUT/"   # merge: AWSCDK/<Module>/ accumulates; css/js last-wins
      else
        echo "  (yard failed for $mod)"
      fi
    fi
    rm -rf "$tmp"
  done
else
  # Unified: one registry over the whole library so cross-module type links resolve.
  # Pass module dirs (YARD recurses for *.rb); a single invocation = a single registry.
  # Also pass the top-level *.rb files — the AWSCDK root module's core types (Stack,
  # App, IResolvable, Duration, RemovalPolicy, ...). They aren't under any submodule
  # dir, so a dirs-only run would drop them *and* leave every reference to them
  # unlinked (they're referenced everywhere). Skip the root _readme.rb (the package
  # README; the site's own landing is the intro).
  mapfile -t rootfiles < <(find . -maxdepth 1 -name '*.rb' ! -name '_readme.rb')
  total=$(find "${mods[@]}" -name '*.rb' | wc -l)
  printf 'yard (unified) %s modules + %s root types, %s files -> one registry\n' \
    "${#mods[@]}" "${#rootfiles[@]}" "$((total + ${#rootfiles[@]}))"
  yard doc "${mods[@]}" "${rootfiles[@]}" -o "$OUT" --no-cache --no-progress -q "${MARKUP[@]}"
fi

# Apply the theme: YARD loads common.css last, so this overrides style.css site-wide.
if [ -f "$SELF_DIR/docs-theme.css" ] && [ -d "$OUT/css" ]; then
  cp "$SELF_DIR/docs-theme.css" "$OUT/css/common.css"
  echo "applied theme -> css/common.css"
fi
