/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
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
 * SPDX-License-Identifier: GPL-3.0-or-later
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

const DIALOG_TYPE_RESTART = 2; // GSM_SHELL_END_SESSION_DIALOG_TYPE_RESTART
const DIALOG_INTERVAL = 10;
const FIRMWARE_REQUEST_TIMEOUT = 10 * GLib.USEC_PER_SEC;
const LOGIND_CALL_TIMEOUT = 5000;
const LOGIND_AUTH_CALL_TIMEOUT = GLib.MAXINT32;

function roundSecondsToInterval(totalSeconds, secondsLeft, interval) {
    let time = Math.ceil(secondsLeft);
    if (time <= interval)
        return time;

    time += interval - 1;
    if (time > totalSeconds)
        return Math.ceil(totalSeconds);
    return time - time % interval;
}

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
        this._firmwareRequestTime = 0;
        this._firmwareDialog = false;
        this._firmwareSetupEarly = false;
    }

    async enable() {
        this._cancellable = new Gio.Cancellable();

        const [support] = await callLogind("CanRebootToFirmwareSetup", null, LOGIND_CALL_TIMEOUT, this._cancellable);
        if (support === "na")
            throw new Error(notSupportedError());
        if (support === "no")
            throw new Error(notAllowedError());

        const schema = Gio.SettingsSchemaSource.get_default().lookup("org.gnome.SessionManager", true);
        if (schema)
            this._sessionSettings = new Gio.Settings({ settings_schema: schema });

        this._connectEndSessionDialog();

        if (Main.panel.statusArea.quickSettings && Main.panel.statusArea.quickSettings._system) {
            this._enable();
        } else {
            let tries = 0;

            if (this._findSystemMenuTimerId) {
                GLib.source_remove(this._findSystemMenuTimerId);
                this._findSystemMenuTimerId = null;
            }

            this._findSystemMenuTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FIND_SYS_MENU_TIMEOUT, () => {
                if (tries >= FIND_SYS_MENU_MAX_RETRY) {
                    console.error(`${this.metadata.name}: Cannot find system menu.`);
                    this._findSystemMenuTimerId = null;
                    return GLib.SOURCE_REMOVE;
                }

                if (Main.panel.statusArea.quickSettings && Main.panel.statusArea.quickSettings._system) {
                    this._findSystemMenuTimerId = null;
                    this._enable();
                    return GLib.SOURCE_REMOVE;
                }

                tries++;
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    disable() {
        this._removeShiftPollTimer();

        if (this._restartAction) {
            delete this._restartAction.activate;
            this._restartAction.disconnect(this._restartKeyPressId);
            this._restartAction.disconnect(this._restartMappedId);
            this._restartAction.label.text = this._originalLabel;
            this._restartAction = null;
        }

        this._disconnectEndSessionDialog();
        this._cancellable.cancel();
        this._cancellable = null;
        this._sessionSettings = null;

        if (this._findSystemMenuTimerId) {
            GLib.source_remove(this._findSystemMenuTimerId);
            this._findSystemMenuTimerId = null;
        }
    }

    _enable() {
        const SystemItem = Main.panel.statusArea.quickSettings._system._systemItem;

        let powerMenu = null;
        for (let i = 0; i < SystemItem.child.get_children().length; i++) {
            const child = SystemItem.child.get_child_at_index(i);

            if (child.constructor.name === "ShutdownItem") {
                powerMenu = child.menu;
                break;
            }
        }
        if (!powerMenu) {
            console.error(`${this.metadata.name}: Cannot find power menu.`);
            return;
        }

        // Menu items have no IDs and their labels are translated
        const restartAction = powerMenu._getMenuItems()[RESTART_ACTION_INDEX];
        if (!restartAction) {
            console.error(`${this.metadata.name}: Cannot find restart action.`);
            return;
        }
        this._restartAction = restartAction;

        this._restartAction.activate = event => this._onRestartActivated(event);

        // GNOME Shell does not activate menu items while a modifier is held
        this._restartKeyPressId = this._restartAction.connect(
            "key-press-event",
            (_actor, event) => this._onRestartKeyPress(event)
        );

        this._originalLabel = this._restartAction.label.text;
        this._firmwareLabel = firmwareLabel();
        this._restartMappedId = this._restartAction.connect("notify::mapped", () => this._syncShiftPolling());
        this._syncShiftPolling();
    }

    _syncShiftPolling() {
        if (this._restartAction.mapped) {
            // No modifier-change signal works on every supported GNOME version
            if (!this._shiftPollTimerId) {
                this._shiftPollTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SHIFT_POLL_INTERVAL, () => {
                    this._updateLabel();
                    return GLib.SOURCE_CONTINUE;
                });
            }
            this._updateLabel();
        } else {
            this._removeShiftPollTimer();
            this._restartAction.label.text = this._originalLabel;
        }
    }

    _removeShiftPollTimer() {
        if (this._shiftPollTimerId) {
            GLib.source_remove(this._shiftPollTimerId);
            this._shiftPollTimerId = null;
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

    _activateRestart(event) {
        Object.getPrototypeOf(this._restartAction).activate.call(this._restartAction, event);
    }

    async _restartIntoFirmware(event) {
        this._firmwareRequestTime = GLib.get_monotonic_time();

        // Without the prompt, gnome-session restarts without showing the dialog
        if (this._sessionSettings?.get_boolean("logout-prompt") === false) {
            const cancellable = this._cancellable;
            try {
                await setRebootToFirmwareSetup(true, cancellable);
            } catch (e) {
                this._firmwareRequestTime = 0;
                if (isCancelled(e)) {
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
        this._dialogTitleId = dialog._messageDialogContent.connect("notify::title", () => this._syncDialogText());
        this._dialogDescriptionId = dialog._messageDialogContent.connect("notify::description",
            () => this._syncDialogText());

        dialog._confirm = signal => this._confirmDialog(signal);
        dialog.cancel = () => {
            if (this._firmwareSetupEarly) {
                this._firmwareSetupEarly = false;
                setRebootToFirmwareSetup(false).catch(logError);
            }
            proto.cancel.call(dialog);
        };
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
        // Scheduled offline updates turn the dialog into "Restart & Install Updates"
        return this._firmwareDialog && this._endSessionDialog._type === DIALOG_TYPE_RESTART;
    }

    _onDialogStateChanged() {
        if (this._endSessionDialog.state !== ModalDialog.State.OPENING)
            return;

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
        const secondsLeft = dialog._secondsLeft > 0 ? dialog._secondsLeft : total;
        dialog._messageDialogContent.title = firmwareDialogTitle();
        dialog._messageDialogContent.description = firmwareDialogDescription(
            roundSecondsToInterval(total, secondsLeft, DIALOG_INTERVAL));
    }

    async _confirmDialog(signal) {
        const dialog = this._endSessionDialog;
        const proto = Object.getPrototypeOf(dialog);

        if (signal === "ConfirmedReboot" && this._isFirmwareDialog()) {
            this._firmwareDialog = false;
            const cancellable = this._cancellable;
            try {
                await setRebootToFirmwareSetup(true, cancellable);
            } catch (e) {
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
