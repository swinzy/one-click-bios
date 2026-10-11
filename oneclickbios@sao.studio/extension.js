/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */


import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";
import { Extension, gettext as _, ngettext } from "resource:///org/gnome/shell/extensions/extension.js";

const RESTART_ACTION_INDEX = 1;
const FIND_SYS_MENU_TIMEOUT = 1000;
const FIND_SYS_MENU_MAX_RETRY = 30;
const SHIFT_POLL_INTERVAL = 50;

// Translatable strings are looked up when used, not at module load:
// the extension's translations are only set up once the extension object exists
const firmwareLabel = () => _("Restart into Firmware Settings…");
const firmwareDialogTitle = () => _("Restart into Firmware Settings");
const firmwareDialogDescription = seconds => ngettext(
    "The system will restart into firmware settings automatically in %d second",
    "The system will restart into firmware settings automatically in %d seconds",
    seconds).format(seconds);
const notSupportedError = () => _("This computer does not support restarting into firmware settings");
const notAllowedError = () => _("Restarting into firmware settings is not allowed");
const firmwareSetupFailedTitle = () => _("Could not restart into firmware settings");
const ACTIVATE_KEYS = [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space];

// The dialog type gnome-session asks GNOME Shell's end session dialog for when restarting
const DIALOG_TYPE_RESTART = 2;
// Same countdown steps as the system restart dialog
const DIALOG_INTERVAL = 10;
// How long a restart request waits for gnome-session to open the restart dialog
const FIRMWARE_REQUEST_TIMEOUT = 10 * GLib.USEC_PER_SEC;
const LOGIND_CALL_TIMEOUT = 5000;
// Long enough to type a password when logind asks for authentication
const LOGIND_AUTH_CALL_TIMEOUT = GLib.MAXINT32;

// Same rounding as the system restart dialog: steps of `interval`, then counting down by 1
function roundSecondsToInterval(totalSeconds, secondsLeft, interval) {
    let time = Math.ceil(secondsLeft);
    if (time <= interval)
        return time;

    time += interval - 1;
    if (time > totalSeconds)
        return Math.ceil(totalSeconds);
    return time - time % interval;
}

// Calls a method of systemd-logind, which may ask for authentication
async function callLogind(method, parameters, timeout, cancellable) {
    const reply = await Gio.DBus.system.call(
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
        method,
        parameters,
        null,
        Gio.DBusCallFlags.ALLOW_INTERACTIVE_AUTHORIZATION,
        timeout,
        cancellable);
    return reply.deepUnpack();
}

// Makes the next boot (or not) go into the firmware setup, like `systemctl reboot --firmware-setup`
function setRebootToFirmwareSetup(enabled, cancellable = null) {
    return callLogind("SetRebootToFirmwareSetup", new GLib.Variant("(b)", [enabled]),
        LOGIND_AUTH_CALL_TIMEOUT, cancellable);
}

function isCancelled(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export default class OneClickBios extends Extension {
    constructor(metadata) {
        super(metadata);
        this._restartAction = null;
        this._originalLabel = null;
        this._cancellable = null;
        this._sessionSettings = null;
        this._endSessionDialog = null;
        // When the restart into firmware was asked for, until gnome-session opens its dialog
        this._firmwareRequestTime = 0;
        // Whether the open restart dialog restarts into firmware
        this._firmwareDialog = false;
        // Whether logind was told to boot into firmware before the restart was confirmed
        this._firmwareSetupEarly = false;
    }

    async enable() {
        this._cancellable = new Gio.Cancellable();

        // Fail with the reason, shown in the Extensions app, rather than offer a restart that cannot work.
        // GNOME Shell waits for this before it counts the extension as enabled.
        const [support] = await callLogind("CanRebootToFirmwareSetup", null, LOGIND_CALL_TIMEOUT, this._cancellable);
        if (support === "na")
            throw new Error(notSupportedError());
        if (support === "no")
            throw new Error(notAllowedError());

        // gnome-session restarts without asking when this is off, unless an application is busy
        const schema = Gio.SettingsSchemaSource.get_default().lookup("org.gnome.SessionManager", true);
        if (schema)
            this._sessionSettings = new Gio.Settings({ settings_schema: schema });

        this._connectEndSessionDialog();

        // If we can find system quicksettings then enable now
        if (Main.panel.statusArea.quickSettings && Main.panel.statusArea.quickSettings._system) {
            this._enable();
        } else {
            let tries = 0;

            // Remove previous timer
            if (this._hSysMenuTimer) {
                GLib.source_remove(this._hSysMenuTimer);
                this._hSysMenuTimer = null;
            }

            // Set timer loop to try finding system menu
            this._hSysMenuTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FIND_SYS_MENU_TIMEOUT, () => {
                // If too many retries
                if (tries >= FIND_SYS_MENU_MAX_RETRY) {
                    console.error(`${this.metadata.name}: Cannot find system menu.`);
                    this._hSysMenuTimer = null;
                    return false;
                }

                // FOUND
                if (Main.panel.statusArea.quickSettings && Main.panel.statusArea.quickSettings._system) {
                    this._hSysMenuTimer = null;
                    this._enable();
                    return false;
                }

                // NOT FOUND
                tries++;
                return true;
            })
        }
    }

    _enable() {
        // This is the live instance of the System Item
        const SystemItem = Main.panel.statusArea.quickSettings._system._systemItem;

        // Find Power menu dynamically
        var powerMenu = null;
        for (let i = 0; i < SystemItem.child.get_children().length; i++) {
            let child = SystemItem.child.get_child_at_index(i);

            // TODO: Please someone find me a better solution!
            if (child.constructor.name == "ShutdownItem") {
                powerMenu = child.menu;
                break;
            }
        }
        if (!powerMenu) {
            console.error(`${this.metadata.name}: Cannot find power menu.`);
            return;
        }

        // Find "Restart..." action.
        // Because these actions are dynamically populated with no id defined. We can only assume the index will not change.
        // String matching is not feasible due to i18n.
        const restartAction = powerMenu._getMenuItems()[RESTART_ACTION_INDEX];
        if (!restartAction) {
            console.error(`${this.metadata.name}: Cannot find restart action.`);
            return;
        }
        this._restartAction = restartAction;

        // Override activate() on this item only. Both clicks and keyboard activation go through it
        // on all supported versions, so we don't depend on how the item handles input internally
        // (Clutter.ClickAction before GNOME 49, Clutter.ClickGesture since).
        this._restartAction.activate = event => this._onRestartActivated(event);

        // GNOME Shell only activates menu items from the keyboard when no modifier is held,
        // so handle Shift + Enter / Space ourselves
        this._restartKeyPressId = this._restartAction.connect(
            "key-press-event",
            (_actor, event) => this._onRestartKeyPress(event)
        );

        // While the item is on screen, show what it will do when Shift is held.
        // There is no modifier-change signal that works on all supported versions, so poll.
        this._originalLabel = this._restartAction.label.text;
        // Looked up once, as the label is updated many times a second while the menu is open
        this._firmwareLabel = firmwareLabel();
        this._restartMappedId = this._restartAction.connect("notify::mapped", () => this._syncShiftPolling());
        this._syncShiftPolling();
    }

    disable() {
        this._removeShiftPollTimer();

        // Revert original behaviour by removing the override, which exposes the prototype's activate() again
        if (this._restartAction) {
            delete this._restartAction.activate;
            this._restartAction.disconnect(this._restartKeyPressId);
            this._restartAction.disconnect(this._restartMappedId);
            this._restartAction.label.text = this._originalLabel;
            this._restartAction = null;
        }

        // Cancel a pending restart into firmware
        this._disconnectEndSessionDialog();
        this._cancellable.cancel();
        this._cancellable = null;
        this._sessionSettings = null;

        // Destroy timer, if any
        if (this._hSysMenuTimer) {
            GLib.source_remove(this._hSysMenuTimer);
            this._hSysMenuTimer = null;
        }
    }

    _syncShiftPolling() {
        if (this._restartAction.mapped) {
            if (!this._hShiftPollTimer) {
                this._hShiftPollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHIFT_POLL_INTERVAL, () => {
                    this._updateLabel();
                    return true;
                });
            }
            this._updateLabel();
        } else {
            this._removeShiftPollTimer();
            this._restartAction.label.text = this._originalLabel;
        }
    }

    _removeShiftPollTimer() {
        if (this._hShiftPollTimer) {
            GLib.source_remove(this._hShiftPollTimer);
            this._hShiftPollTimer = null;
        }
    }

    _updateLabel() {
        const [, , mods] = global.get_pointer();
        const text = mods & Clutter.ModifierType.SHIFT_MASK ? this._firmwareLabel : this._originalLabel;
        if (this._restartAction.label.text !== text)
            this._restartAction.label.text = text;
    }

    _onRestartKeyPress(event) {
        if ((event.get_state() & Clutter.ModifierType.SHIFT_MASK) && ACTIVATE_KEYS.includes(event.get_key_symbol())) {
            this._restartIntoFirmware(event).catch(logError);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onRestartActivated(event) {
        if (event?.get_state() & Clutter.ModifierType.SHIFT_MASK)
            this._restartIntoFirmware(event).catch(logError);
        else
            this._activateRestart(event);
    }

    // Original behaviour: emits "activate", which asks gnome-session to restart and closes the menu
    _activateRestart(event) {
        Object.getPrototypeOf(this._restartAction).activate.call(this._restartAction, event);
    }

    // Restart the way GNOME does, through gnome-session and its restart dialog, so busy applications
    // and other users are shown and applications can save their work. The dialog is changed to say
    // where the restart goes, and logind is told to boot into firmware when the restart is confirmed,
    // like the dialog's own "Boot Options" does for the boot loader menu.
    async _restartIntoFirmware(event) {
        this._firmwareRequestTime = GLib.get_monotonic_time();

        if (this._sessionSettings?.get_boolean("logout-prompt") === false) {
            // gnome-session will restart without asking, so tell logind now
            const cancellable = this._cancellable;
            try {
                await setRebootToFirmwareSetup(true, cancellable);
            } catch (e) {
                this._firmwareRequestTime = 0;
                if (isCancelled(e)) {
                    // Disabled meanwhile; logind may have been told already
                    setRebootToFirmwareSetup(false).catch(logError);
                } else {
                    Main.panel.closeQuickSettings();
                    this._notifyFirmwareSetupFailed(e);
                }
                return;
            }
            this._firmwareSetupEarly = true;
        }

        this._activateRestart(event);
    }

    _notifyFirmwareSetupFailed(error) {
        if (error instanceof GLib.Error)
            Gio.DBusError.strip_remote_error(error);
        Main.notifyError(firmwareSetupFailedTitle(), error.message);
    }

    _connectEndSessionDialog() {
        const dialog = Main.endSessionDialog;
        const proto = Object.getPrototypeOf(dialog);
        this._endSessionDialog = dialog;

        this._dialogStateId = dialog.connect("notify::state", () => this._onDialogStateChanged());
        // The dialog sets its texts from many places, so put ours back whenever it does
        this._dialogTitleId = dialog._messageDialogContent.connect("notify::title", () => this._syncDialogText());
        this._dialogDescriptionId = dialog._messageDialogContent.connect("notify::description",
            () => this._syncDialogText());

        // Override these methods on the dialog instance only; disable() deletes them, which exposes
        // the prototype's methods again
        dialog._confirm = signal => this._confirmDialog(signal);
        dialog.cancel = () => {
            if (this._firmwareSetupEarly) {
                this._firmwareSetupEarly = false;
                setRebootToFirmwareSetup(false).catch(logError);
            }
            proto.cancel.call(dialog);
        };
        // "Boot Options" (Alt) goes to the boot loader menu instead
        dialog._confirmRebootToBootLoaderMenu = () => {
            this._firmwareDialog = false;
            proto._confirmRebootToBootLoaderMenu.call(dialog);
        };
    }

    _disconnectEndSessionDialog() {
        const dialog = this._endSessionDialog;
        if (!dialog)
            return;

        const open = dialog.state === ModalDialog.State.OPENING || dialog.state === ModalDialog.State.OPENED;
        if (this._isFirmwareDialog() && open)
            dialog.cancel();

        dialog.disconnect(this._dialogStateId);
        dialog._messageDialogContent.disconnect(this._dialogTitleId);
        dialog._messageDialogContent.disconnect(this._dialogDescriptionId);
        delete dialog._confirm;
        delete dialog.cancel;
        delete dialog._confirmRebootToBootLoaderMenu;
        this._endSessionDialog = null;
        this._firmwareRequestTime = 0;
        this._firmwareDialog = false;
        this._firmwareSetupEarly = false;
    }

    _isFirmwareDialog() {
        // The dialog type is final once the dialog opens: with offline updates scheduled,
        // GNOME Shell turns a restart into "Restart & Install Updates", which stays as it is
        return this._firmwareDialog && this._endSessionDialog._type === DIALOG_TYPE_RESTART;
    }

    _onDialogStateChanged() {
        if (this._endSessionDialog.state !== ModalDialog.State.OPENING)
            return;

        // Only the dialog opened for our request restarts into firmware
        const elapsed = GLib.get_monotonic_time() - this._firmwareRequestTime;
        this._firmwareDialog = this._firmwareRequestTime > 0 && elapsed < FIRMWARE_REQUEST_TIMEOUT;
        this._firmwareRequestTime = 0;
        this._syncDialogText();
    }

    _syncDialogText() {
        if (!this._isFirmwareDialog())
            return;

        const dialog = this._endSessionDialog;
        const total = dialog._totalSecondsToStayOpen;
        // The countdown has not started yet while the dialog is opening
        const secondsLeft = dialog._secondsLeft > 0 ? dialog._secondsLeft : total;
        dialog._messageDialogContent.title = firmwareDialogTitle();
        dialog._messageDialogContent.description = firmwareDialogDescription(
            roundSecondsToInterval(total, secondsLeft, DIALOG_INTERVAL));
    }

    // Called by the dialog when the restart is confirmed, by its button or at the end of the countdown
    async _confirmDialog(signal) {
        const dialog = this._endSessionDialog;
        const proto = Object.getPrototypeOf(dialog);

        if (signal === "ConfirmedReboot" && this._isFirmwareDialog()) {
            this._firmwareDialog = false;
            const cancellable = this._cancellable;
            try {
                await setRebootToFirmwareSetup(true, cancellable);
            } catch (e) {
                // Don't restart normally instead
                proto.cancel.call(dialog);
                if (isCancelled(e))
                    setRebootToFirmwareSetup(false).catch(logError);
                else
                    this._notifyFirmwareSetupFailed(e);
                return;
            }
        }

        this._firmwareSetupEarly = false;
        await proto._confirm.call(dialog, signal);
    }
}
