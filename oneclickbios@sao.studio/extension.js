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
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

const RESTART_ACTION_INDEX = 1;
const FIND_SYS_MENU_TIMEOUT = 1000;
const FIND_SYS_MENU_MAX_RETRY = 30;

export default class OneClickBios extends Extension {
    constructor(metadata) {
        super(metadata);
        this._restartAction = null;
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
    }

    disable() {
        // Revert original behaviour by removing the override, which exposes the prototype's activate() again
        if (this._restartAction) {
            delete this._restartAction.activate;
            this._restartAction = null;
        }

        // Destroy timer, if any
        if (this._hSysMenuTimer) {
            GLib.source_remove(this._hSysMenuTimer);
            this._hSysMenuTimer = null;
        }
    }

    _onRestartActivated(event) {
        if (event?.get_state() & Clutter.ModifierType.SHIFT_MASK) {
            Main.panel.closeQuickSettings();
            GLib.spawn_command_line_async("systemctl reboot --firmware-setup");
        } else {
            // Original behaviour: emits "activate", which shows the restart dialog and closes the menu
            Object.getPrototypeOf(this._restartAction).activate.call(this._restartAction, event);
        }
    }
}
