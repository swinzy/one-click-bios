/* Test harness for One-Click BIOS.
 *
 * Runs inside a headless GNOME Shell started by tests/run.sh. It drives the
 * power menu with virtual input devices and reports results to the shell log
 * (lines prefixed with "OCBTEST:") and to $OCB_TEST_DIR/done ("ok" or "fail").
 *
 * Nothing here can restart the machine: run.sh puts a fake systemctl first in
 * PATH, and the original restart path (activateRestart) is stubbed below.
 */

import GLib from "gi://GLib";
import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as Config from "resource:///org/gnome/shell/misc/config.js";
import * as SystemActions from "resource:///org/gnome/shell/misc/systemActions.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const UUID = "oneclickbios@sao.studio";
const DIR = GLib.getenv("OCB_TEST_DIR");
const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION.split(".")[0]);
const FIRMWARE_CMD = "reboot --firmware-setup";
const FIRMWARE_LABEL = "Restart into Firmware Settings…";

const results = [];
// Disabling the extension under test also reloads extensions enabled after it, including this one
let started = false;

function log(msg) {
    console.log(`OCBTEST: ${msg}`);
}

function check(name, ok, extra = "") {
    results.push(ok);
    log(`${ok ? "PASS" : "FAIL"} ${name} ${extra}`);
}

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

function readLog() {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(`${DIR}/systemctl.log`)[1]).trim();
    } catch {
        return "";
    }
}

const firmwareCount = () => readLog().split("\n").filter(l => l === FIRMWARE_CMD).length;

function findItems() {
    const systemItem = Main.panel.statusArea.quickSettings._system._systemItem;
    const shutdownItem = systemItem.child.get_children().find(c => c.constructor.name === "ShutdownItem");
    return { shutdownItem, restart: shutdownItem.menu._getMenuItems()[1] };
}

// Clutter.get_default_backend() was removed in GNOME 51
function getSeat() {
    const backend = global.stage.context?.get_backend?.() ?? Clutter.get_default_backend();
    return backend.get_default_seat();
}

// PopupMenu.open() takes a params object since GNOME 51, an animation argument before
function openWithoutAnimation(menu) {
    if (SHELL_MAJOR >= 51)
        menu.open({ animate: false });
    else
        menu.open(false);
}

export default class OneClickBiosTest extends Extension {
    enable() {
        if (started)
            return;
        started = true;

        this._run().catch(e => {
            log(`FAIL exception ${e}\n${e.stack}`);
            this._finish();
        });
    }

    disable() {}

    _finish() {
        const failed = results.filter(r => !r).length;
        log(`DONE ${results.length - failed}/${results.length} passed`);
        GLib.file_set_contents(`${DIR}/done`, failed === 0 && results.length > 0 ? "ok" : "fail");
    }

    async _openPowerMenu() {
        const { shutdownItem, restart } = findItems();
        openWithoutAnimation(Main.panel.statusArea.quickSettings.menu);
        await sleep(300);

        for (let i = 0; i < 20 && !restart.mapped; i++) {
            openWithoutAnimation(shutdownItem.menu);
            await sleep(300);
        }
        if (!restart.mapped) {
            const qs = Main.panel.statusArea.quickSettings;
            log(`power menu did not open: qsOpen=${qs.menu.isOpen} shutdownItem.visible=${shutdownItem.visible} ` +
                `shutdownItem.mapped=${shutdownItem.mapped} powerMenuOpen=${shutdownItem.menu.isOpen} ` +
                `restart.visible=${restart.visible} sessionMode=${Main.sessionMode.currentMode} ` +
                `locked=${Main.sessionMode.isLocked}`);
        }
        await sleep(500);
        return restart;
    }

    async _click(actor, shift) {
        const [x, y] = actor.get_transformed_position();
        const [w, h] = actor.get_transformed_size();
        const now = () => GLib.get_monotonic_time();

        // The first motion of a session can land elsewhere (seen at y=0), so retry until the pointer is there
        const [cx, cy] = [Math.round(x + w / 2), Math.round(y + h / 2)];
        for (let i = 0; i < 10; i++) {
            this._pointer.notify_absolute_motion(now(), cx, cy);
            await sleep(200);
            const [px, py] = global.get_pointer();
            if (Math.abs(px - cx) <= 1 && Math.abs(py - cy) <= 1)
                break;
        }
        if (shift) {
            this._keyboard.notify_keyval(now(), Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
            await sleep(100);
        }
        this._pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await sleep(100);
        this._pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await sleep(100);
        if (shift)
            this._keyboard.notify_keyval(now(), Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
        await sleep(500);
    }

    async _setShift(pressed) {
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Shift_L,
            pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
        // Longer than the extension's Shift polling interval
        await sleep(300);
    }

    async _pressReturn(actor, shift = false) {
        const now = () => GLib.get_monotonic_time();

        actor.grab_key_focus();
        await sleep(200);
        if (shift)
            await this._setShift(true);
        this._keyboard.notify_keyval(now(), Clutter.KEY_Return, Clutter.KeyState.PRESSED);
        await sleep(100);
        this._keyboard.notify_keyval(now(), Clutter.KEY_Return, Clutter.KeyState.RELEASED);
        await sleep(100);
        if (shift)
            await this._setShift(false);
        await sleep(400);
    }

    async _run() {
        log(`GNOME Shell ${Config.PACKAGE_VERSION}`);

        // Stub the original restart path so it only counts calls
        const systemActions = SystemActions.getDefault();
        let restartCalls = 0;
        systemActions.activateRestart = () => restartCalls++;

        // The isolated session has no logind session, so logind reports that it cannot reboot and the
        // restart item is hidden. Pin the restart action as available; a pending or later update from
        // logind then has no effect.
        Object.defineProperty(systemActions._actions.get("restart"), "available", {
            get: () => true,
            set: () => {},
        });
        systemActions.notify("can-restart");

        // Wait for the extension under test
        for (let i = 0; i < 50 && Main.extensionManager.lookup(UUID)?.state !== 1; i++)
            await sleep(200);
        const ext = Main.extensionManager.lookup(UUID);
        check("extension enabled", ext?.state === 1, `state=${ext?.state} error=${ext?.error ?? ""}`);
        await sleep(1500);

        // Warm up the virtual devices: the first events of a new device can be dropped
        const seat = getSeat();
        this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        await sleep(300);
        this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), 10, 400);
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        this._keyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
        await sleep(300);

        let { restart } = findItems();
        check("override installed", Object.hasOwn(restart, "activate"));

        // 1. Shift + click: restart into firmware
        restart = await this._openPowerMenu();
        await this._click(restart, true);
        check("shift+click runs systemctl reboot --firmware-setup", firmwareCount() === 1, `log="${readLog()}"`);
        check("shift+click does not call activateRestart", restartCalls === 0, `calls=${restartCalls}`);
        check("shift+click closes quick settings", !Main.panel.statusArea.quickSettings.menu.isOpen);

        // 2. Plain click: original restart. Shift was still held when the menu closed in step 1,
        // so this also checks that the label was restored.
        restart = await this._openPowerMenu();
        const originalLabel = restart.label.text;
        check("label is original without Shift", originalLabel !== FIRMWARE_LABEL, `label="${originalLabel}"`);
        await this._click(restart, false);
        check("plain click calls activateRestart", restartCalls === 1, `calls=${restartCalls}`);
        check("plain click does not run systemctl", firmwareCount() === 1, `log="${readLog()}"`);
        check("plain click closes quick settings", !Main.panel.statusArea.quickSettings.menu.isOpen);

        // 3. Keyboard: original restart
        restart = await this._openPowerMenu();
        await this._pressReturn(restart);
        check("Return key calls activateRestart", restartCalls === 2, `calls=${restartCalls}`);

        // 4. Label follows Shift while the menu is open
        restart = await this._openPowerMenu();
        await this._setShift(true);
        check("label changes while Shift is held", restart.label.text === FIRMWARE_LABEL, `label="${restart.label.text}"`);
        await this._setShift(false);
        check("label reverts when Shift is released", restart.label.text === originalLabel, `label="${restart.label.text}"`);

        // 5. Shift + Return: restart into firmware
        await this._pressReturn(restart, true);
        check("shift+Return runs systemctl reboot --firmware-setup", firmwareCount() === 2, `log="${readLog()}"`);
        check("shift+Return does not call activateRestart", restartCalls === 2, `calls=${restartCalls}`);
        check("shift+Return closes quick settings", !Main.panel.statusArea.quickSettings.menu.isOpen);

        // 6. Disabled: override removed, label untouched, shift + click uses the original restart
        await Main.extensionManager.disableExtension(UUID);
        await sleep(500);
        ({ restart } = findItems());
        check("override removed on disable", !Object.hasOwn(restart, "activate"));
        restart = await this._openPowerMenu();
        await this._setShift(true);
        check("disabled: label stays original with Shift", restart.label.text === originalLabel, `label="${restart.label.text}"`);
        await this._setShift(false);
        await this._click(restart, true);
        check("disabled: shift+click uses original restart", restartCalls === 3 && firmwareCount() === 2,
            `calls=${restartCalls} log="${readLog()}"`);

        // 7. Re-enabled: works again
        await Main.extensionManager.enableExtension(UUID);
        await sleep(500);
        ({ restart } = findItems());
        check("override reinstalled on re-enable", Object.hasOwn(restart, "activate"));
        restart = await this._openPowerMenu();
        await this._click(restart, true);
        check("re-enabled: shift+click runs systemctl again", firmwareCount() === 3, `log="${readLog()}"`);

        Main.panel.closeQuickSettings();
        this._finish();
    }
}
