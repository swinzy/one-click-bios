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
import Gdk from "gi://Gdk";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as QuickSettings from "resource:///org/gnome/shell/ui/quickSettings.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

const RESTART_ACTION_INDEX = 1;
const FIND_SYS_MENU_TIMEOUT = 1000;
const FIND_SYS_MENU_MAX_RETRY = 30;

export default class OneClickBios extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
    }

    enable() {
        // If we can find system quicksettings then enable now
        if (Main.panel.statusArea.quicksettings._system) {
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
                    throw new Error("Cannot find system menu.");
                    this._hSysMenuTimer = null;
                    return false;
                }

                // FOUND
                if (Main.panel.statusArea.quickSettings._system) {
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
        
        // Find "Restart..." action.
        // Because these actions are dynamically populated with no id defined. We can only assume the index will not change.
        // String matching is not feasible due to i18n.
        this._restartAction = powerMenu._getMenuItems()[RESTART_ACTION_INDEX];

        // Disable original click action and use our custom press event instead
        this._restartAction._clickAction.enabled = false;
        this._restartClickEventId = this._originalRestartAction.connect(
            "button-press-event",
            this.restartActionClicked
        );
    }

    disable() {
        // Revert original behaviour
        this._restartAction.disconnect(this._restartClickEventId);
        this._restartClickEventId = null;
        this._restartAction._clickAction.enabled = true;

        // Destroy timer, if any
        if (this._hSysMenuTimer) {
            GLib.source_remove(this._hSysMenuTimer);
            this._hSysMenuTimer = null;
        }
    }

    restartActionClicked(_widget, event) {
        if (event.get_state() & Gdk.ModifierType.SHIFT_MASK) {
            GLib.spawn_command_line_async("systemctl reboot --firmware");
        } else {
            const systemActions = new SystemActions.getDefault();
            systemActions.activateRestart();
        }
    }
}

