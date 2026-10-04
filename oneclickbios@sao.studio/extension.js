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


import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Clutter from "gi://Clutter";
import Gettext from "gettext";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as Dialog from "resource:///org/gnome/shell/ui/dialog.js";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const RESTART_ACTION_INDEX = 1;
const FIND_SYS_MENU_TIMEOUT = 1000;
const FIND_SYS_MENU_MAX_RETRY = 30;
const SHIFT_POLL_INTERVAL = 50;

// TODO: Translate
const FIRMWARE_LABEL = "Restart into Firmware Settings…";
const FIRMWARE_DIALOG_TITLE = "Restart into Firmware Settings";
const firmwareDialogDescription = seconds =>
    `The system will restart into firmware settings automatically in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
const ACTIVATE_KEYS = [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space];

// Same timeout and countdown steps as the system restart dialog
const FIRMWARE_DIALOG_TIMEOUT = 60;
const FIRMWARE_DIALOG_INTERVAL = 10;

// Button labels come from GNOME Shell's own translations
const shellGettext = msgid => Gettext.dgettext("gnome-shell", msgid);
const shellPgettext = (context, msgid) => Gettext.dpgettext("gnome-shell", context, msgid);

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

const FirmwareDialog = GObject.registerClass(
class FirmwareDialog extends ModalDialog.ModalDialog {
    _init(onConfirm) {
        super._init({ styleClass: "end-session-dialog", destroyOnClose: true });

        this._onConfirm = onConfirm;
        this._totalSeconds = FIRMWARE_DIALOG_TIMEOUT;
        this._secondsLeft = this._totalSeconds;
        this._timerId = 0;

        this._content = new Dialog.MessageDialogContent({ title: FIRMWARE_DIALOG_TITLE });
        this.contentLayout.add_child(this._content);

        this.addButton({
            action: () => this.close(),
            label: shellGettext("Cancel"),
            key: Clutter.KEY_Escape,
        });
        this.addButton({
            action: () => this._confirm(),
            label: shellPgettext("button", "Restart"),
            default: true,
        });

        this.connect("destroy", () => this._stopTimer());
    }

    open() {
        if (!super.open())
            return false;

        this._startTimer();
        this._sync();
        return true;
    }

    close() {
        this._stopTimer();
        super.close();
    }

    _confirm() {
        this.close();
        this._onConfirm();
    }

    _sync() {
        const seconds = roundSecondsToInterval(this._totalSeconds, this._secondsLeft, FIRMWARE_DIALOG_INTERVAL);
        this._content.description = firmwareDialogDescription(seconds);
    }

    _startTimer() {
        const startTime = GLib.get_monotonic_time();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            const secondsElapsed = (GLib.get_monotonic_time() - startTime) / 1000000;
            this._secondsLeft = this._totalSeconds - secondsElapsed;
            if (this._secondsLeft > 0) {
                this._sync();
                return GLib.SOURCE_CONTINUE;
            }

            this._timerId = 0;
            this._confirm();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }
});

export default class OneClickBios extends Extension {
    constructor(metadata) {
        super(metadata);
        this._restartAction = null;
        this._originalLabel = null;
        this._dialog = null;
    }

    enable() {
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
        this._restartMappedId = this._restartAction.connect("notify::mapped", () => this._syncShiftPolling());
        this._syncShiftPolling();
    }

    disable() {
        // Revert original behaviour by removing the override, which exposes the prototype's activate() again
        if (this._restartAction) {
            delete this._restartAction.activate;
            this._restartAction.disconnect(this._restartKeyPressId);
            this._restartAction.disconnect(this._restartMappedId);
            this._stopShiftPolling();
            this._restartAction = null;
        }

        // Cancel a pending restart into firmware
        this._destroyDialog();

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
            this._stopShiftPolling();
        }
    }

    _stopShiftPolling() {
        if (this._hShiftPollTimer) {
            GLib.source_remove(this._hShiftPollTimer);
            this._hShiftPollTimer = null;
        }
        this._restartAction.label.text = this._originalLabel;
    }

    _updateLabel() {
        const [, , mods] = global.get_pointer();
        const text = mods & Clutter.ModifierType.SHIFT_MASK ? FIRMWARE_LABEL : this._originalLabel;
        if (this._restartAction.label.text !== text)
            this._restartAction.label.text = text;
    }

    _onRestartKeyPress(event) {
        if ((event.get_state() & Clutter.ModifierType.SHIFT_MASK) && ACTIVATE_KEYS.includes(event.get_key_symbol())) {
            this._confirmRestartIntoFirmware();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Ask first, like the system restart dialog does
    _confirmRestartIntoFirmware() {
        Main.panel.closeQuickSettings();

        this._destroyDialog();
        this._dialog = new FirmwareDialog(() => this._restartIntoFirmware());
        // The dialog destroys itself when closed
        this._dialogDestroyId = this._dialog.connect("destroy", () => {
            this._dialog = null;
            this._dialogDestroyId = null;
        });
        this._dialog.open();
    }

    _destroyDialog() {
        if (this._dialog) {
            this._dialog.disconnect(this._dialogDestroyId);
            this._dialog.destroy();
            this._dialog = null;
            this._dialogDestroyId = null;
        }
    }

    _restartIntoFirmware() {
        GLib.spawn_command_line_async("systemctl reboot --firmware-setup");
    }

    _onRestartActivated(event) {
        if (event?.get_state() & Clutter.ModifierType.SHIFT_MASK) {
            this._confirmRestartIntoFirmware();
        } else {
            // Original behaviour: emits "activate", which shows the restart dialog and closes the menu
            Object.getPrototypeOf(this._restartAction).activate.call(this._restartAction, event);
        }
    }
}
