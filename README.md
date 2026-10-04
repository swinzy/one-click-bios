# One-Click BIOS
<img src="./Banner.png" height="256" />

A GNOME extension that allows you to restart into firmware settings directly from OS.<br>

| Current Support | Historical Support[^1] |
|-----------------|------------------------|
| 46 – 51         | 43                     |

[<img alt="Get it on GNOME Extensions" height="90" src="https://raw.githubusercontent.com/andyholmes/gnome-shell-extensions-badge/master/get-it-on-ego.svg?sanitize=true">](https://extensions.gnome.org/extension/5733/one-click-bios/)

## Usage:
1. Open the power menu as usual
2. Hold <kbd>Shift</kbd>: "Restart…" changes to "Restart into Firmware Settings…"
3. Click it, or press <kbd>Enter</kbd> while it is selected
4. Confirm with "Restart", or wait for the 60-second countdown, like a normal restart
5. The computer will now restart straight into your BIOS/UEFI settings automatically!

## Supported GNOME versions
At a minimum, this extension supports the GNOME versions shipped by:
- The **two** latest Ubuntu LTS releases
- The latest Debian release
- The latest RHEL release
- The latest SLES / openSUSE Leap release
- The latest Fedora Beta (the upcoming Fedora release, not Rawhide).

The supported range is from the oldest GNOME version to the latest GNOME version used among the above list, and is reviewed whenever one of these distributions has a new release. GNOME versions that are no longer supported can still install the last release of this extension that supported them from GNOME Extensions.

## Translations
Translations live in [`po/`](po/). To add or update one:
1. Run `tools/update-pot.sh` to refresh the template and existing translations
2. Start a new language with `msginit -i po/oneclickbios@sao.studio.pot -o po/<lang>.po -l <lang>`, or edit an existing `po/<lang>.po`
3. Run `tools/pack.sh` to build `dist/oneclickbios@sao.studio.zip` and install it with `gnome-extensions install --force dist/oneclickbios@sao.studio.zip`

The "Cancel" and "Restart" buttons use GNOME Shell's own translations.

[^1]: Will not receive updates.
