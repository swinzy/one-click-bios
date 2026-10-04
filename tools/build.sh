#!/bin/bash
# Stages the extension with its compiled translations, ready to install or pack.
#
# Usage: tools/build.sh <out-dir>
# Creates <out-dir>/oneclickbios@sao.studio/, with po/<lang>.po compiled to
# locale/<lang>/LC_MESSAGES/<gettext-domain>.mo. Needs msgfmt (gettext).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=oneclickbios@sao.studio
OUT=${1:?usage: tools/build.sh <out-dir>}
DOMAIN=$(sed -n 's/.*"gettext-domain": *"\([^"]*\)".*/\1/p' "$ROOT/$UUID/metadata.json")

rm -rf "${OUT:?}/$UUID"
mkdir -p "$OUT"
cp -r "$ROOT/$UUID" "$OUT/$UUID"

for po in "$ROOT"/po/*.po; do
    [ -e "$po" ] || continue
    lang=$(basename "$po" .po)
    mkdir -p "$OUT/$UUID/locale/$lang/LC_MESSAGES"
    msgfmt --check -o "$OUT/$UUID/locale/$lang/LC_MESSAGES/$DOMAIN.mo" "$po"
done
