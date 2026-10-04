#!/bin/bash
# Packs the extension into dist/oneclickbios@sao.studio.zip, the file uploaded
# to extensions.gnome.org and attached to GitHub releases.
#
# Usage: tools/pack.sh
# Needs msgfmt (gettext) and zip.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=oneclickbios@sao.studio
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

"$ROOT/tools/build.sh" "$STAGE"
mkdir -p "$ROOT/dist"
rm -f "$ROOT/dist/$UUID.zip"
(cd "$STAGE/$UUID" && zip -q -X -r "$ROOT/dist/$UUID.zip" .)
unzip -l "$ROOT/dist/$UUID.zip"
