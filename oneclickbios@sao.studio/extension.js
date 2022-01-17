const { GObject, St, Clutter, Gdk } = imports.gi;
const Main = imports.ui.main;
const Menu = Main.panel.statusArea.aggregateMenu.menu;
const OldPowerMenu = Main.panel.statusArea.aggregateMenu._system.menu;
const PopupMenu = imports.ui.popupMenu;
const SystemActions = imports.misc.systemActions;
const BoxPointer = imports.ui.boxpointer;
const Util = imports.misc.util;

var _systemActions;

function init() {
    log("***STARTED!***");

    _systemActions = new SystemActions.getDefault();

    powerMenu = new PopupMenu.PopupSubMenuMenuItem(_('Power Off / Log Out'), true);
    powerMenu.icon.icon_name = 'system-shutdown-symbolic';
    powerMenu.connect('button-press-event', newEvent);

    logout = new PopupMenu.PopupMenuItem(_('Log Out'));
    logout.connect(
        'activate', () => {
            //powerMenu.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
            _systemActions.activateLogout();
        }
    );

    suspend = new PopupMenu.PopupMenuItem(_('Suspend'));
    suspend.connect(
        'activate', () => {
            //powerMenu.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
            _systemActions.activateSuspend();
        }
    );

    powerOff = new PopupMenu.PopupMenuItem(_('Power Off...'));
    powerOff.connect(
        'activate', () => {
            //powerMenu.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
            _systemActions.activatePowerOff();
        }
    );

    firmware = new PopupMenu.PopupMenuItem(_('Restart into Firmware Settings'));
    firmware.connect(
        'activate', () => {
            try {
                Util.trySpawnCommandLine('systemctl reboot --firmware-setup');
            } catch (err) {
                Main.notify("Error " + err);
            }
        }
    );

    separator1 = new PopupMenu.PopupSeparatorMenuItem;

    separator2 = new PopupMenu.PopupSeparatorMenuItem;

    powerMenu.menu.addMenuItem(logout);
    powerMenu.menu.addMenuItem(separator1);
    powerMenu.menu.addMenuItem(suspend);
    powerMenu.menu.addMenuItem(powerOff);
}

var powerMenu;
var logout;
var suspend;
var powerOff;
var firmware;
var separator1;
var separator2


function enable() {

    Menu.addMenuItem(powerMenu);  
    OldPowerMenu.actor.remove_child(Main.panel.statusArea.aggregateMenu._system._sessionSubMenu);       
}

function newEvent(widget, event) {
    
    if (event.get_state() & Gdk.ModifierType.SHIFT_MASK) {
        powerMenu.menu.addMenuItem(separator2);
        powerMenu.menu.addMenuItem(firmware);
    }
    else {
        powerMenu.menu.box.remove_actor(separator2);
        powerMenu.menu.box.remove_actor(firmware);
    }
    
}

function disable() {
    OldPowerMenu.box.insert_child_at_index(Main.panel.statusArea.aggregateMenu._system._sessionSubMenu, Main.panel.statusArea.aggregateMenu._system.menu.numMenuItems);
    Menu.box.remove_actor(powerMenu);
}