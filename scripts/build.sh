#!/usr/bin/env bash
# Build release tarballs: dist/sprig-<version>-<os>-<arch>.tar.gz
#
# Layout inside each tarball (matches what specLoader.ts looks for):
#   sprig/bin/sprig
#   sprig/share/sprig/specs/…      (Fig completion specs)
#   sprig/share/doc/sprig/…        (licenses)
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(bun -e 'console.log((await import("./src/paths.ts")).VERSION)')
targets=${TARGETS:-"darwin-arm64 darwin-x64 linux-x64 linux-arm64"}
specs=node_modules/@withfig/autocomplete/build

bun install --frozen-lockfile >/dev/null
mkdir -p dist

for target in $targets; do
  stage=$(mktemp -d)
  root=$stage/sprig
  mkdir -p "$root/bin" "$root/share/sprig" "$root/share/doc/sprig"
  bun build src/cli.ts --compile --minify --target="bun-$target" --outfile "$root/bin/sprig" >/dev/null
  cp -R "$specs" "$root/share/sprig/specs"
  cp node_modules/@withfig/autocomplete/LICENSE "$root/share/doc/sprig/LICENSE.withfig-autocomplete"
  [[ -f LICENSE ]] && cp LICENSE "$root/share/doc/sprig/LICENSE"
  out=dist/sprig-$version-$target.tar.gz
  tar -C "$stage" -czf "$out" sprig
  rm -rf "$stage"
  echo "built $out ($(du -h "$out" | cut -f1))"
done

(cd dist && shasum -a 256 sprig-"$version"-*.tar.gz > SHA256SUMS)
cat dist/SHA256SUMS
