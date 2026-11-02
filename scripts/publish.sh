#!/bin/sh
# Publish the built xpi as an automatic update:
#  1. add build/zotrecall-<version>.xpi to the orphan `releases` branch
#  2. add the version on top of updates.json on main (update_url in the manifest)
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./addon/manifest.json').version")
XPI="build/zotrecall-$VERSION.xpi"
[ -f "$XPI" ] || { echo "Build first: npm run build"; exit 1; }
HASH=$(sha256sum "$XPI" | cut -d' ' -f1)
TMP=$(mktemp -d)
git fetch -q origin releases main
git worktree add -q --detach "$TMP/rel" origin/releases
cp "$XPI" "$TMP/rel/"
git -C "$TMP/rel" add "zotrecall-$VERSION.xpi"
git -C "$TMP/rel" commit -q -m "Add $VERSION build"
git -C "$TMP/rel" push -q origin HEAD:releases
git worktree add -q --detach "$TMP/main" origin/main
VERSION="$VERSION" HASH="$HASH" node -e '
const fs = require("fs"); const f = process.argv[1];
const d = JSON.parse(fs.readFileSync(f, "utf8"));
const u = d.addons["zotrecall@atturk.github.io"].updates;
if (u.some(x => x.version === process.env.VERSION)) { console.error("version already published"); process.exit(1); }
u.unshift({ version: process.env.VERSION,
  update_link: `https://raw.githubusercontent.com/atturk/ZotRecall/releases/zotrecall-${process.env.VERSION}.xpi`,
  update_hash: "sha256:" + process.env.HASH,
  applications: { zotero: { strict_min_version: "10.0", strict_max_version: "10.*" } } });
fs.writeFileSync(f, JSON.stringify(d, null, "\t") + "\n");' "$TMP/main/updates.json"
git -C "$TMP/main" add updates.json
git -C "$TMP/main" commit -q -m "Publish update manifest for $VERSION"
git -C "$TMP/main" push -q origin HEAD:main
git worktree remove --force "$TMP/rel"
git worktree remove --force "$TMP/main"
echo "Published $VERSION ($HASH)"
