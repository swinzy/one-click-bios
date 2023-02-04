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

const { Gio, GObject, Gdk, Gtk, St, Clutter, GLib } = imports.gi;

const QuickSettings = imports.ui.quickSettings;
const System = imports.ui.status.system;
const Main = imports.ui.main;
const Dialog = imports.ui.dialog;
const SystemActions = imports.misc.systemActions;
const ModalDialog = imports.ui.modalDialog;

// This is the live instance of the Quick Settings menu
const QuickSettingsMenu = imports.ui.main.panel.statusArea.quickSettings;

// This is the live instance of the System Item
const SystemItem = QuickSettingsMenu._system._systemItem;

class Extension {
    constructor() {
    }

    enable() {
        // Find the instance of "Power Off" button according to its class type
        for (let i = 0; i < SystemItem.child.get_children().length; i++) {
            let child = SystemItem.child.get_child_at_index(i);

            // TODO: Please someone find me a better solution!
            if (child.constructor.name == "ShutdownItem")
                this._powerMenuButton = child;
        }

        // Detect Shift+Click by listening pressing event of the Power Menu Button
        this._powerMenuButtonEventId = this._powerMenuButton.connect(
            "button-press-event",
            this._powerMenuButtonClicked
        );
    }   

    disable() {
        // Disconnect the listening event so that it won't show Restart to Firmware anymore
        this._powerMenuButton.disconnect(this._powerMenuButtonEventId);

        // Remove timeout loop source
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _powerMenuButtonClicked(_widget, event) {
        if (event.get_state() & Gdk.ModifierType.SHIFT_MASK) {
            // If cannot restart, do not trigger Restart Into Firmware
            if (!_widget._systemActions.can_restart) return;
            
            let dialog = new RestartIntoFirmwareDialog();
            dialog.open();
            Main.panel.closeQuickSettings();
        }
    }  
}

var RestartIntoFirmwareDialog = GObject.registerClass(
    class RestartIntoFirmwareDialog extends ModalDialog.ModalDialog {
        _init() {
            super._init({ destroyOnClose: true });
            this._buildLayout();

            // Used for ticking to automatically restart
            this._secondsLeft = 0;
            this._totalSecondsToStayOpen = 60;
            this._startTimer();
        }

        _buildLayout() {
            // Title
            let title = new Dialog.MessageDialogContent({
                title: _('Restart into Firmware Settings'),
            });
            this.contentLayout.add_child(title);
            
            // Content
            let content = new St.Label({
                text: _("The system will restart into firmware settings in 60 seconds."),
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.contentLayout.add_child(content);

            // Cancel button
            this.addButton({
                action: () => {
                    this._stopTimer();
                    this.close();
                },
                label: _('Cancel'),     // Why _()
                key: Clutter.KEY_Escape,
            });

            // Restart button
            this.addButton({
                action: () => {
                    this._stopTimer();
                    this.close();
                },
                label: _('Restart'),
            });
        }

        _startTimer() {
            let startTime = GLib.get_monotonic_time();
            this._secondsLeft = this._totalSecondsToStayOpen;
    
            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                let currentTime = GLib.get_monotonic_time();
                let secondsElapsed = (currentTime - startTime) / 1000000;
    
                this._secondsLeft = this._totalSecondsToStayOpen - secondsElapsed;
                if (this._secondsLeft > 0) {
                    // Update how many seconds left on modal
                    this._sync();
                    return GLib.SOURCE_CONTINUE;
                }
    
                GLib.spawn_command_line_async("systemctl reboot --firmware");
                this._timerId = 0;
    
                return GLib.SOURCE_REMOVE;
            });

            // TODO: What's the purpose of this line?
            //GLib.Source.set_name_by_id(this._timerId, '[gnome-shell] this._confirm');
        }

        _stopTimer() {
            if (this._timerId > 0) {
                GLib.source_remove(this._timerId);
                this._timerId = 0;
            }
        }

        // TODO: Feature to be implemented
        _sync() {
            let open = this.state == ModalDialog.State.OPENING || this.state == ModalDialog.State.OPENED;
            if (!open)
                return;
            let displayTime = (this._totalSecondsToStayOpen - this._secondsLeft).toString();
        }
    }
);
    

function init() {
    return new Extension();
}
