/* Test harness for One-Click BIOS.
 *
 * Runs inside a headless GNOME Shell started by tests/run.sh. It drives the
 * power menu with virtual input devices and reports results to the shell log
 * (lines prefixed with "OCBTEST:") and to $OCB_TEST_DIR/done ("ok" or "fail").
 *
 * Nothing here can restart the machine: run.sh runs the shell with fake
 * systemd-logind and gnome-session services (tests/fake-services.js), which
 * record what they were asked in $OCB_TEST_DIR/services.log, and puts a fake
 * systemctl first in PATH.
 */

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import Shell from "gi://Shell";
import Gettext from "gettext";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as Config from "resource:///org/gnome/shell/misc/config.js";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";
import * as SystemActions from "resource:///org/gnome/shell/misc/systemActions.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const UUID = "oneclickbios@sao.studio";
const DIR = GLib.getenv("OCB_TEST_DIR");
// Set to save screenshots of the UI under test (e.g. to review the dialog)
const SCREENSHOT_DIR = GLib.getenv("OCB_SCREENSHOT_DIR");
const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION.split(".")[0]);
const ExtensionState = { ACTIVE: 1, ERROR: 3 };
// Expected texts in the current locale, from the extension's own translations
const DOMAIN = "oneclickbios@sao.studio";
const tr = msgid => Gettext.dgettext(DOMAIN, msgid);
const FIRMWARE_LABEL_SOURCE = "Restart into Firmware Settings…";
// Looked up once the extension under test has bound its translation domain
let FIRMWARE_LABEL, FIRMWARE_TITLE, NOT_SUPPORTED, FAILED_TITLE;
function loadExpectedTexts() {
    FIRMWARE_LABEL = tr(FIRMWARE_LABEL_SOURCE);
    FIRMWARE_TITLE = tr("Restart into Firmware Settings");
    NOT_SUPPORTED = tr("This computer does not support restarting into firmware settings");
    FAILED_TITLE = tr("Could not restart into firmware settings");
}
const countdownText = seconds => Gettext.dngettext(DOMAIN,
    "The system will restart into firmware settings automatically in %d second",
    "The system will restart into firmware settings automatically in %d seconds",
    seconds).replace("%d", seconds);
// Set to 1 when running in a locale the extension has a translation for
const EXPECT_TRANSLATED = GLib.getenv("OCB_EXPECT_TRANSLATED") === "1";

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

function readFile(name) {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(`${DIR}/${name}`)[1]).trim();
    } catch {
        return "";
    }
}

// What the fake logind and gnome-session were asked, since the last call
let seenEvents = 0;
function newEvents() {
    const events = readFile("services.log").split("\n").filter(e => e && e !== "ready");
    const fresh = events.slice(seenEvents);
    seenEvents = events.length;
    return fresh.join(", ");
}

function setControl(name, value) {
    if (value === null)
        GLib.unlink(`${DIR}/${name}`);
    else
        GLib.file_set_contents(`${DIR}/${name}`, value);
}

async function screenshot(name) {
    if (!SCREENSHOT_DIR)
        return;

    const path = `${SCREENSHOT_DIR}/${name}.png`;
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    // Shell.Screenshot.screenshot() is promisified by GNOME Shell's screenshot UI
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
    log(`screenshot saved: ${path}`);
}

// GNOME Shell's restart dialog, if it is open
function findDialog() {
    const dialog = Main.endSessionDialog;
    const open = dialog.state === ModalDialog.State.OPENING || dialog.state === ModalDialog.State.OPENED;
    return open ? dialog : null;
}

const dialogTitle = dialog => dialog?._messageDialogContent.title;
const dialogDescription = dialog => dialog?._messageDialogContent.description;

function findItems() {
    const systemItem = Main.panel.statusArea.quickSettings._system._systemItem;
    const shutdownItem = systemItem.child.get_children().find(c => c.constructor.name === "ShutdownItem");
    return { shutdownItem, restart: shutdownItem.menu._getMenuItems()[1] };
}

function hasNotification(title) {
    return Main.messageTray.getSources().some(source => source.notifications.some(n => n.title === title));
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

    async _pressKey(keyval) {
        const now = () => GLib.get_monotonic_time();
        this._keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
        await sleep(100);
        this._keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
        await sleep(700);
    }

    // Waits for gnome-session (the fake) to open the restart dialog, so key presses reach it
    async _waitForDialog() {
        for (let i = 0; i < 30 && Main.endSessionDialog.state !== ModalDialog.State.OPENED; i++)
            await sleep(100);
        await sleep(300);
        return findDialog();
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

    // Clicks the dialog's confirm button ("Restart"), the last one; Return would press "Cancel",
    // which has the key focus when the dialog opens
    async _clickConfirm(dialog) {
        const buttons = dialog?.buttonLayout.get_children().filter(b => b.visible) ?? [];
        if (buttons.length < 2) {
            log(`no confirm button: ${buttons.length} buttons`);
            return;
        }
        await this._click(buttons[buttons.length - 1], false);
        await sleep(300);
    }

    // Opens the power menu and Shift-clicks "Restart…"
    async _shiftClickRestart() {
        const restart = await this._openPowerMenu();
        await this._click(restart, true);
        return this._waitForDialog();
    }

    async _run() {
        log(`GNOME Shell ${Config.PACKAGE_VERSION}`);

        // The isolated session has no logind session, so the restart item would be hidden.
        // Pin the restart action as available; a pending or later update has no effect.
        const systemActions = SystemActions.getDefault();
        Object.defineProperty(systemActions._actions.get("restart"), "available", {
            get: () => true,
            set: () => {},
        });
        systemActions.notify("can-restart");

        // Wait for the extension under test
        for (let i = 0; i < 50 && Main.extensionManager.lookup(UUID)?.state !== ExtensionState.ACTIVE; i++)
            await sleep(200);
        const ext = Main.extensionManager.lookup(UUID);
        check("extension enabled", ext?.state === ExtensionState.ACTIVE, `state=${ext?.state} error=${ext?.error ?? ""}`);
        await sleep(1500);
        loadExpectedTexts();
        newEvents();

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

        // 1. Shift + click: GNOME's restart dialog, saying where it goes; Escape cancels
        let dialog = await this._shiftClickRestart();
        check("shift+click opens the restart dialog", dialog !== null);
        await screenshot("dialog");
        check("shift+click closes quick settings", !Main.panel.statusArea.quickSettings.menu.isOpen);
        check("dialog title says firmware", dialogTitle(dialog) === FIRMWARE_TITLE, `title="${dialogTitle(dialog)}"`);
        check("dialog shows the countdown", dialogDescription(dialog) === countdownText(60),
            `description="${dialogDescription(dialog)}"`);
        await this._pressKey(Clutter.KEY_Escape);
        check("Escape closes the dialog", findDialog() === null);
        let events = newEvents();
        check("Escape cancels without firmware setup", events === "reboot-requested, canceled", `events="${events}"`);

        // 2. Plain click: the normal restart dialog. Shift was still held when the menu closed in step 1,
        // so this also checks that the label was restored.
        restart = await this._openPowerMenu();
        const originalLabel = restart.label.text;
        check("label is original without Shift", originalLabel !== FIRMWARE_LABEL, `label="${originalLabel}"`);
        await this._click(restart, false);
        dialog = await this._waitForDialog();
        check("plain click opens the restart dialog", dialog !== null);
        check("plain click closes quick settings", !Main.panel.statusArea.quickSettings.menu.isOpen);
        const restartTitle = dialogTitle(dialog);
        check("plain click: normal dialog title", restartTitle !== FIRMWARE_TITLE, `title="${restartTitle}"`);
        await this._clickConfirm(dialog);
        events = newEvents();
        check("plain click: confirming restarts normally", events === "reboot-requested, confirmed-reboot",
            `events="${events}"`);

        // 3. Keyboard: the normal restart dialog
        restart = await this._openPowerMenu();
        await this._pressReturn(restart);
        dialog = await this._waitForDialog();
        check("Return key: normal dialog", dialog !== null && dialogTitle(dialog) === restartTitle,
            `title="${dialogTitle(dialog)}"`);
        await this._pressKey(Clutter.KEY_Escape);
        events = newEvents();
        check("Return key: restart requested and cancelled", events === "reboot-requested, canceled", `events="${events}"`);

        // 4. Label follows Shift while the menu is open
        restart = await this._openPowerMenu();
        await this._setShift(true);
        check("label changes while Shift is held", restart.label.text === FIRMWARE_LABEL, `label="${restart.label.text}"`);
        if (EXPECT_TRANSLATED) {
            check("label is translated", restart.label.text !== FIRMWARE_LABEL_SOURCE, `label="${restart.label.text}"`);
            check("dialog text is translated", !countdownText(60).startsWith("The system"), `text="${countdownText(60)}"`);
        }
        await screenshot("menu-shift");
        await this._setShift(false);
        check("label reverts when Shift is released", restart.label.text === originalLabel, `label="${restart.label.text}"`);

        // 5. Shift + Return opens the dialog; confirming tells logind first
        await this._pressReturn(restart, true);
        dialog = await this._waitForDialog();
        check("shift+Return opens the firmware dialog", dialogTitle(dialog) === FIRMWARE_TITLE, `title="${dialogTitle(dialog)}"`);
        await this._clickConfirm(dialog);
        check("dialog closes after confirming", findDialog() === null);
        events = newEvents();
        check("confirming sets firmware setup, then restarts",
            events === "reboot-requested, firmware-setup true, confirmed-reboot", `events="${events}"`);

        // 6. The countdown restarts into firmware too (shortened to 2 seconds)
        dialog = await this._shiftClickRestart();
        if (dialog)
            dialog._totalSecondsToStayOpen = 2;
        await sleep(3500);
        check("dialog closes after the countdown", findDialog() === null);
        events = newEvents();
        check("countdown sets firmware setup, then restarts",
            events === "reboot-requested, firmware-setup true, confirmed-reboot", `events="${events}"`);

        // 7. The next plain restart is normal again
        restart = await this._openPowerMenu();
        await this._click(restart, false);
        dialog = await this._waitForDialog();
        check("plain restart after a firmware restart is normal", dialogTitle(dialog) === restartTitle,
            `title="${dialogTitle(dialog)}"`);
        await this._pressKey(Clutter.KEY_Escape);
        newEvents();

        // 8. If logind refuses, the restart is cancelled and the user is told
        setControl("firmware-setup-fails", "");
        dialog = await this._shiftClickRestart();
        await this._clickConfirm(dialog);
        setControl("firmware-setup-fails", null);
        events = newEvents();
        check("logind failure: no restart", events === "reboot-requested, canceled", `events="${events}"`);
        check("logind failure: notification shown", hasNotification(FAILED_TITLE));
        check("logind failure: dialog closed", findDialog() === null);

        // 9. With gnome-session's logout prompt off, restarts are not confirmed, so logind is told first
        const sessionSchema = Gio.SettingsSchemaSource.get_default().lookup("org.gnome.SessionManager", true);
        if (sessionSchema) {
            const sessionSettings = new Gio.Settings({ settings_schema: sessionSchema });
            sessionSettings.set_boolean("logout-prompt", false);
            Gio.Settings.sync();
            await sleep(500);
            restart = await this._openPowerMenu();
            await this._click(restart, true);
            await sleep(500);
            events = newEvents();
            check("no prompt: firmware setup, then restart", events === "firmware-setup true, reboot-requested, reboot",
                `events="${events}"`);
            check("no prompt: no dialog", findDialog() === null);
            restart = await this._openPowerMenu();
            await this._click(restart, false);
            await sleep(500);
            events = newEvents();
            check("no prompt: plain click restarts normally", events === "reboot-requested, reboot", `events="${events}"`);
            sessionSettings.reset("logout-prompt");
            Gio.Settings.sync();
            await sleep(500);
        } else {
            log("SKIP no prompt: org.gnome.SessionManager schema not installed");
        }

        // 10. Disabling the extension while the dialog is open cancels it
        dialog = await this._shiftClickRestart();
        check("dialog open before disabling", dialogTitle(dialog) === FIRMWARE_TITLE);
        if (dialog)
            dialog._totalSecondsToStayOpen = 2;
        await Main.extensionManager.disableExtension(UUID);
        await sleep(3500);
        check("disable closes the dialog", findDialog() === null);
        events = newEvents();
        // logind was told in step 9 and no restart happened since, so cancelling also takes that back.
        // logind and gnome-session are on different buses, so their events can come in either order.
        const expected = ["reboot-requested", "canceled", ...sessionSchema ? ["firmware-setup false"] : []];
        check("disable cancels the restart", events.split(", ").sort().join() === expected.sort().join(),
            `events="${events}"`);

        // 11. Disabled: everything restored, shift + click is a normal restart
        ({ restart } = findItems());
        check("override removed on disable", !Object.hasOwn(restart, "activate"));
        const dialogOverrides = ["_confirm", "cancel", "_confirmRebootToBootLoaderMenu"]
            .filter(name => Object.hasOwn(Main.endSessionDialog, name));
        check("dialog overrides removed on disable", dialogOverrides.length === 0, `left=${dialogOverrides}`);
        restart = await this._openPowerMenu();
        await this._setShift(true);
        check("disabled: label stays original with Shift", restart.label.text === originalLabel, `label="${restart.label.text}"`);
        await this._setShift(false);
        await this._click(restart, true);
        dialog = await this._waitForDialog();
        check("disabled: shift+click opens the normal dialog", dialogTitle(dialog) === restartTitle,
            `title="${dialogTitle(dialog)}"`);
        await this._clickConfirm(dialog);
        events = newEvents();
        check("disabled: confirming restarts normally", events === "reboot-requested, confirmed-reboot", `events="${events}"`);

        // 12. Re-enabled: works again
        await Main.extensionManager.enableExtension(UUID);
        await sleep(1000);
        ({ restart } = findItems());
        check("override reinstalled on re-enable", Object.hasOwn(restart, "activate"));
        dialog = await this._shiftClickRestart();
        check("re-enabled: shift+click opens the firmware dialog", dialogTitle(dialog) === FIRMWARE_TITLE);
        await this._clickConfirm(dialog);
        events = newEvents();
        check("re-enabled: confirming sets firmware setup",
            events === "reboot-requested, firmware-setup true, confirmed-reboot", `events="${events}"`);

        // 13. Without firmware support the extension fails with the reason and changes nothing.
        // Last: an extension in the error state cannot be enabled again until GNOME Shell restarts.
        setControl("firmware-support", "na");
        await Main.extensionManager.disableExtension(UUID);
        await sleep(500);
        await Main.extensionManager.enableExtension(UUID);
        await sleep(1000);
        check("not supported: extension in error state", ext.state === ExtensionState.ERROR,
            `state=${ext.state} error="${ext.error}"`);
        check("not supported: error gives the reason", ext.error?.includes(NOT_SUPPORTED), `error="${ext.error}"`);
        ({ restart } = findItems());
        check("not supported: menu unchanged", !Object.hasOwn(restart, "activate"));
        check("not supported: dialog unchanged", !Object.hasOwn(Main.endSessionDialog, "_confirm"));

        check("systemctl never run", readFile("systemctl.log") === "", `log="${readFile("systemctl.log")}"`);

        Main.panel.closeQuickSettings();
        this._finish();
    }
}
