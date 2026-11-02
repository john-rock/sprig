#!/usr/bin/env bash
# Install sprig for the current user, without Homebrew.
#
#   scripts/install.sh                      build from this checkout and install
#   scripts/install.sh sprig-X-os-arch.tar.gz   install a release tarball
#
# Installs to ~/.local/share/sprig/<version>, links ~/.local/bin/sprig, then
# runs `sprig install` to add one line to ~/.zshrc.
set -euo pipefail

prefix_root=${SPRIG_PREFIX:-$HOME/.local/share/sprig}
bindir=${SPRIG_BINDIR:-$HOME/.local/bin}
tarball=${1:-}

if [[ -z $tarball ]]; then
  cd "$(dirname "$0")/.."
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m); [[ $arch == x86_64 ]] && arch=x64; [[ $arch == aarch64 ]] && arch=arm64
  TARGETS="$os-$arch" scripts/build.sh >/dev/null
  version=$(bun -e 'console.log((await import("./src/paths.ts")).VERSION)')
  tarball=$PWD/dist/sprig-$version-$os-$arch.tar.gz
fi

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
tar -C "$stage" -xzf "$tarball"
version=$("$stage/sprig/bin/sprig" version)

dest=$prefix_root/$version
rm -rf "$dest"
mkdir -p "$prefix_root" "$bindir"
mv "$stage/sprig" "$dest"
ln -sfn "$dest/bin/sprig" "$bindir/sprig"
echo "installed sprig $version → $dest"
echo "linked $bindir/sprig"

case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "note: $bindir is not on your PATH; add it in ~/.zshrc" ;;
esac

# Remove older versions.
for d in "$prefix_root"/*/; do
  [[ ${d%/} != "$dest" ]] && rm -rf "$d"
done

"$bindir/sprig" install
