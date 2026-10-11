# Technical notes

How One-Click BIOS works, what it relies on in GNOME Shell, and how it is tested and released. Supported GNOME Shell versions: 46 to 51.

## Overview

Holding <kbd>Shift</kbd> while activating "Restart…" in the system menu restarts into the UEFI firmware settings instead of a normal restart. The extension does not restart anything itself. It uses the same path as a normal restart:

1. The extension asks gnome-session to restart, exactly as the menu item normally does.
2. gnome-session asks GNOME Shell to show its restart dialog (`Main.endSessionDialog`).
3. While that dialog is open for our request, the extension changes its title and countdown text to say that the computer will restart into firmware settings.
4. When the restart is confirmed (button or end of the countdown), the extension calls logind's `SetRebootToFirmwareSetup(true)` and then lets the dialog confirm as usual.
5. gnome-session ends the session and asks logind to reboot. Because the firmware flag is set, the firmware opens its setup screen on the next boot.

This mirrors what GNOME Shell's restart dialog already does for its hidden "Boot Options" button (hold <kbd>Alt</kbd>), which calls logind's `SetRebootToBootLoaderMenu()` before confirming. Going through gnome-session means busy applications, unsaved work and other logged-in users are shown as for a normal restart, and logind inhibitors are respected. Earlier versions ran `systemctl reboot --firmware-setup` directly, which bypassed all of this and failed silently when an inhibitor was active.

## Enabling

`enable()` is async. GNOME Shell has awaited `enable()` since GNOME 44, so a rejected promise puts the extension in the ERROR state, with the message shown in the Extensions app. The reviewers confirmed this is acceptable.

1. Ask logind `CanRebootToFirmwareSetup()`:
   - `na`: the firmware or boot mode does not support it. Throw "This computer does not support restarting into firmware settings".
   - `no`: polkit does not allow it. Throw "Restarting into firmware settings is not allowed".
   - `yes` or `challenge` (allowed after authentication): carry on.

   Nothing is changed before this check, so an extension that fails here leaves GNOME Shell untouched. An extension in the ERROR state cannot be enabled again until GNOME Shell restarts.
2. Read gnome-session's `org.gnome.SessionManager` `logout-prompt` setting, if the schema is installed (see [Restart without a prompt](#restart-without-a-prompt)).
3. Hook into the restart dialog (see [The restart dialog](#the-restart-dialog)).
4. Find the "Restart…" menu item and change its behaviour (see [The menu item](#the-menu-item)). At login the quick settings may not exist yet, so this retries once a second for up to 30 seconds.

## The menu item

The power menu is found among the system item's children by its class name, `ShutdownItem`. "Restart…" is its second menu item: the items have no IDs and their labels are translated, so they cannot be matched by name.

- **Activation:** `activate()` is overridden on that item instance only. Clicks and keyboard activation both go through `activate()` on all supported versions, whether the item uses `Clutter.ClickAction` (before GNOME 49) or `Clutter.ClickGesture`. With <kbd>Shift</kbd> in the event state, it starts a restart into firmware; otherwise it calls the prototype's `activate()`.
- **Keyboard:** GNOME Shell does not activate menu items while a modifier is held, so a `key-press-event` handler on the item handles <kbd>Shift</kbd>+<kbd>Enter</kbd>, <kbd>Shift</kbd>+keypad <kbd>Enter</kbd> and <kbd>Shift</kbd>+<kbd>Space</kbd>.
- **Label:** while the item is mapped, a 50 ms timer reads the modifier state (`global.get_pointer()`) and switches the label between the original text and "Restart into Firmware Settings…". No modifier-change signal works on every supported version, hence the polling. The timer runs only while the menu is open, and the original label is restored when the item is unmapped.

## The restart dialog

`Main.endSessionDialog` is a single instance that GNOME Shell reuses for every log out, power off and restart dialog. The extension changes that instance only, never the class:

- **Which dialog is ours:** a restart into firmware records the time of the request. When the dialog's `state` changes to `OPENING`, it is ours if a request was made in the last 10 seconds; the request is then used up. It also has to be a restart dialog (type `2`, gnome-session's `GSM_SHELL_END_SESSION_DIALOG_TYPE_RESTART`). With offline updates scheduled, GNOME Shell turns a restart into "Restart & Install Updates"; that dialog is left as it is and restarts normally.
- **Text:** the dialog sets its title and description from several places, some through callbacks bound when it was created. Instead of overriding those, the extension listens to `notify::title` and `notify::description` on the dialog's `MessageDialogContent` and puts its own text back. The countdown uses the dialog's own `_secondsLeft` and `_totalSecondsToStayOpen` and the same rounding as GNOME Shell (steps of 10 seconds, then 1).
- **Confirming:** `_confirm()` is overridden. For our dialog and the `ConfirmedReboot` signal, it first awaits `SetRebootToFirmwareSetup(true)`, then calls the original `_confirm()`. If logind refuses, the restart is cancelled rather than done normally, and a notification ("Could not restart into firmware settings") gives logind's reason.
- **Boot Options:** `_confirmRebootToBootLoaderMenu()` is overridden only to mark the dialog as not ours, so <kbd>Alt</kbd> → "Boot Options" goes to the boot loader menu as usual.
- **Cancelling:** `cancel()` is overridden to take back a firmware flag that was set before the dialog opened (see below).

The logind flag is set only when the restart is confirmed, like GNOME's own "Boot Options". If gnome-session gives up on the restart after that, the flag stays set and the next restart goes into the firmware settings. GNOME's "Boot Options" has the same limitation.

### Restart without a prompt

With `logout-prompt` off, gnome-session restarts without showing the dialog unless an application is busy. In that case the extension calls `SetRebootToFirmwareSetup(true)` before asking for the restart. If the dialog still appears (because an application is busy) and is cancelled, the flag is set back to `false`.

## logind calls

The extension talks to `org.freedesktop.login1.Manager` on the system bus with `Gio.DBusConnection.call()` (promisified by GNOME Shell), with `ALLOW_INTERACTIVE_AUTHORIZATION` so polkit can ask for a password where needed.

| Method | When | Timeout |
|---|---|---|
| `CanRebootToFirmwareSetup()` | `enable()` | 5 s |
| `SetRebootToFirmwareSetup(true)` | restart confirmed, or before a restart without a prompt | none, so the user has time to authenticate |
| `SetRebootToFirmwareSetup(false)` | a pending restart is cancelled or the extension is disabled | none |

On most systems setting the flag needs no authentication: polkit's default for `org.freedesktop.login1.set-reboot-to-firmware-setup` allows active local sessions.

## Disabling

`disable()` cleans up unconditionally; only restores that need an object sit behind a check for that object:

- removes the label timer and the menu retry timer;
- deletes the `activate()` override, disconnects the item's signals and restores its label;
- cancels our restart dialog if it is open, disconnects from the dialog and deletes the dialog method overrides;
- cancels the `Gio.Cancellable` used by every logind call, so no late reply restarts or changes anything. If a call to set the flag is cancelled mid-way, the flag is set back to `false`.

The extension has no `unlock-dialog` session mode, so it is disabled while the screen is locked; a pending restart into firmware is cancelled then.

## GNOME Shell internals used

These are not public API and are checked on every supported version by the tests:

- `Main.panel.statusArea.quickSettings._system._systemItem`, the `ShutdownItem` class name and `menu._getMenuItems()`
- the menu item's prototype `activate()` and its `label`
- `Main.endSessionDialog` with `_type`, `_messageDialogContent`, `_secondsLeft`, `_totalSecondsToStayOpen`, `_confirm()`, `cancel()` and `_confirmRebootToBootLoaderMenu()`
- `ModalDialog.State` and the dialog's `state` property

## Translations

The extension's own strings use gettext through the `Extension` class, with the domain `oneclickbios@sao.studio` (`gettext-domain` in `metadata.json`). They are looked up when used, not at module load, because the domain is only bound once the extension object exists. The "Cancel" and "Restart" buttons are GNOME Shell's, in GNOME Shell's translation.

Sources are in `po/`. `es` is Latin American Spanish, so `es_MX`, `es_AR` and other Spanish locales fall back to it; `es_ES` is Spanish for Spain. An extension's translation only shows when GNOME Shell itself is translated into that language.

- `tools/update-pot.sh` extracts the strings into the template and merges them into every `.po` file.
- `tools/build.sh <dir>` copies the extension and compiles the `.po` files into `locale/`.
- `tools/pack.sh` builds `dist/oneclickbios@sao.studio.zip`, the file uploaded to extensions.gnome.org and attached to GitHub releases. It contains only `extension.js`, `metadata.json`, `LICENSE` and the compiled translations.

## Tests

`tests/run.sh` runs the built extension in a headless GNOME Shell (`--headless --virtual-monitor`) with throw-away `HOME` and XDG directories, a private session bus and a private bus in place of the system bus. Nothing on the machine can be restarted:

- `tests/fake-services.js` (GJS) owns `org.freedesktop.login1` on the private system bus and `org.gnome.SessionManager` on the session bus. Like gnome-session, its `Reboot()` opens GNOME Shell's restart dialog, unless `logout-prompt` is off. It records every request and dialog signal in `services.log`. Files in the test directory make `CanRebootToFirmwareSetup()` return another answer or `SetRebootToFirmwareSetup()` fail.
- A fake `systemctl` first in `PATH` is a second safety net.
- `tests/ocbtest@local` is a test extension that drives the menu with virtual pointer and keyboard devices and checks the label, the dialog's text, the order of logind and gnome-session events, logind failures, `logout-prompt` off, disabling during a restart, re-enabling, and the ERROR state when firmware setup is not supported.

Set `LANG` and `OCB_EXPECT_TRANSLATED=1` to check a translation, and `OCB_SCREENSHOT_DIR` to save screenshots of the menu and the dialog. Before a release the tests run on GNOME 46, 48, 49, 50 and 51 in both English and a translated locale.

## Releasing

Development happens on `devel`, which starts each version by bumping `version` in `metadata.json`. The zip from `tools/pack.sh` is uploaded to extensions.gnome.org; only code that passed review is merged into `main`. GitHub releases are made from `main` with the manual `Release` workflow (`.github/workflows/release.yml`), which packs the extension with the same script and tags `v<version>`.
