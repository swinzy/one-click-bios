#!/bin/bash
# Runs the extension in an isolated headless GNOME Shell and drives it with
# tests/ocbtest@local. Needs no graphical session (works over SSH) and does not
# touch the user's real settings: HOME, XDG dirs and the session bus are all
# temporary, and a fake systemctl records reboot requests instead of rebooting.
#
# Usage: tests/run.sh
# Exit status is 0 if all checks pass.
set -u

TESTS=$(cd "$(dirname "$0")" && pwd)
REPO=$(dirname "$TESTS")
TIMEOUT=120

T=$(mktemp -d "${TMPDIR:-/tmp}/ocb-test.XXXXXX")
mkdir -p "$T"/{home,config,data/gnome-shell/extensions,cache}
cp -r "$REPO/oneclickbios@sao.studio" "$T/data/gnome-shell/extensions/"
cp -r "$TESTS/ocbtest@local" "$T/data/gnome-shell/extensions/"

export HOME=$T/home XDG_CONFIG_HOME=$T/config XDG_DATA_HOME=$T/data XDG_CACHE_HOME=$T/cache
export OCB_TEST_DIR=$T PATH=$TESTS/bin:$PATH TIMEOUT
unset DBUS_SESSION_BUS_ADDRESS DISPLAY WAYLAND_DISPLAY

dbus-run-session -- bash -c '
    gsettings set org.gnome.shell enabled-extensions "[\"oneclickbios@sao.studio\", \"ocbtest@local\"]"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
    gnome-shell --headless --wayland --no-x11 --wayland-display=ocb-test-0 \
        --virtual-monitor 1280x800 > "$OCB_TEST_DIR/shell.log" 2>&1 &
    pid=$!
    for _ in $(seq 1 "$TIMEOUT"); do
        [ -f "$OCB_TEST_DIR/done" ] && break
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
    done
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
' > /dev/null 2>&1

grep -E "OCBTEST:|JS ERROR|oneclickbios" "$T/shell.log" | sed -E "s/^.*OCBTEST: //"
RESULT=$(cat "$T/done" 2>/dev/null || echo "no result (timeout or crash)")
echo "RESULT: $RESULT"
echo "Full log: $T/shell.log"
[ "$RESULT" = ok ]
