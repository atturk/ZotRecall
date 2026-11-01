#!/usr/bin/env bash
# Build build/zotrecall-<version>.xpi from addon/
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./addon/manifest.json').version")
mkdir -p build
out="build/zotrecall-$version.xpi"
rm -f "$out"
(cd addon && zip -qr -X "../$out" . -x '.*')
echo "$out"
