#!/usr/bin/env bash
# Links this plugin's dependencies to a jsii monorepo checkout (built on a
# branch that includes the pacmak plugin API, e.g. jsii-language-plugins).
#
#   ./scripts/link-toolchain.sh <path-to-jsii-monorepo> [<path-to-jsii-rosetta>]
#
# IMPORTANT: the checkout linked here must be the SAME one whose jsii-pacmak
# runs `--plugin` against this package. Mixing two checkouts loads two copies
# of jsii-reflect/@jsii/spec with incompatible object identities and fails in
# confusing ways. Once the plugin API ships in released packages, this script
# disappears in favor of a plain npm install.
set -euo pipefail

jsii_repo="$(cd "${1:?usage: link-toolchain.sh <path-to-jsii-monorepo> [<path-to-jsii-rosetta>]}" && pwd)"
rosetta_repo="${2:-}"

cd "$(dirname "$0")/.."
mkdir -p node_modules/@jsii node_modules/@types

link() {
  ln -sfn "$2" "node_modules/$1"
  echo "  $1 -> $2"
}

link jsii-pacmak   "${jsii_repo}/packages/jsii-pacmak"
link jsii-reflect  "${jsii_repo}/packages/jsii-reflect"
link codemaker     "${jsii_repo}/packages/codemaker"
link @jsii/spec    "${jsii_repo}/packages/@jsii/spec"
link fs-extra      "${jsii_repo}/node_modules/fs-extra"
link semver        "${jsii_repo}/node_modules/semver"
link @types/node   "${jsii_repo}/node_modules/@types/node"
link @types/semver "${jsii_repo}/node_modules/@types/semver"
link @types/fs-extra "${jsii_repo}/node_modules/@types/fs-extra"
link typescript    "${jsii_repo}/node_modules/typescript"

# The compliance harness generates from the monorepo's jsii-calc fixture
# (only present once the fixture chain has been built in that checkout).
if [[ -e "${jsii_repo}/packages/jsii-calc/.jsii" ]]; then
  link jsii-calc "${jsii_repo}/packages/jsii-calc"
fi

if [[ -n "${rosetta_repo}" ]]; then
  link jsii-rosetta "$(cd "${rosetta_repo}" && pwd)"
  # The plugin compiles against the rosetta checkout's TypeScript version to
  # avoid dual-compiler type clashes in the visitor.
  if [[ -d "${rosetta_repo}/node_modules/typescript" ]]; then
    link typescript "$(cd "${rosetta_repo}" && pwd)/node_modules/typescript"
  fi
fi

echo "linked. build with: npm run build"
