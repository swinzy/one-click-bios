/* Fake systemd-logind and gnome-session for tests/run.sh.
 *
 * Run with `gjs -m` on a private system bus (DBUS_SYSTEM_BUS_ADDRESS) and the
 * test's session bus, before GNOME Shell starts. Nothing here can restart
 * anything: it only records what was asked, one event per line, in
 * $OCB_TEST_DIR/services.log. "ready" is written once both names are owned.
 *
 * Controlled by files in $OCB_TEST_DIR:
 *   firmware-support       answer of CanRebootToFirmwareSetup ("yes" if missing)
 *   firmware-setup-fails   if present, SetRebootToFirmwareSetup fails
 *
 * Like gnome-session, Reboot shows GNOME Shell's restart dialog unless the
 * org.gnome.SessionManager logout-prompt setting is off.
 */

import Gio from "gi://Gio";
import GLib from "gi://GLib";

const DIR = GLib.getenv("OCB_TEST_DIR");
const DIALOG_TYPE_RESTART = 2;
const DIALOG_SECONDS = 60;

const LOGIND_XML = `<node>
  <interface name="org.freedesktop.login1.Manager">
    <method name="CanRebootToFirmwareSetup"><arg type="s" direction="out"/></method>
    <method name="SetRebootToFirmwareSetup"><arg type="b" direction="in"/></method>
  </interface>
</node>`;

const SESSION_MANAGER_XML = `<node>
  <interface name="org.gnome.SessionManager">
    <method name="Reboot"/>
  </interface>
</node>`;

function record(event) {
    const stream = Gio.File.new_for_path(`${DIR}/services.log`).append_to(Gio.FileCreateFlags.NONE, null);
    stream.write_all(new TextEncoder().encode(`${event}\n`), null);
    stream.close(null);
}

function readControl(name) {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(`${DIR}/${name}`)[1]).trim();
    } catch {
        return null;
    }
}

function logoutPrompt() {
    const schema = Gio.SettingsSchemaSource.get_default().lookup("org.gnome.SessionManager", true);
    return !schema || new Gio.Settings({ settings_schema: schema }).get_boolean("logout-prompt");
}

const logind = {
    CanRebootToFirmwareSetup() {
        return readControl("firmware-support") ?? "yes";
    },

    SetRebootToFirmwareSetup(enabled) {
        if (readControl("firmware-setup-fails") !== null)
            throw new GLib.Error(Gio.DBusError, Gio.DBusError.ACCESS_DENIED, "Test: access denied");
        record(`firmware-setup ${enabled}`);
    },
};

const sessionManager = {
    Reboot() {
        record("reboot-requested");
        if (!logoutPrompt()) {
            record("reboot");
            return;
        }
        Gio.DBus.session.call(
            "org.gnome.Shell", "/org/gnome/SessionManager/EndSessionDialog",
            "org.gnome.SessionManager.EndSessionDialog", "Open",
            new GLib.Variant("(uuuao)", [DIALOG_TYPE_RESTART, 0, DIALOG_SECONDS, []]),
            null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    record(`dialog-error ${e.message}`);
                }
            });
    },
};

function closeDialog() {
    Gio.DBus.session.call(
        "org.gnome.Shell", "/org/gnome/SessionManager/EndSessionDialog",
        "org.gnome.SessionManager.EndSessionDialog", "Close",
        null, null, Gio.DBusCallFlags.NONE, -1, null, null);
}

for (const [signal, event] of [["ConfirmedReboot", "confirmed-reboot"], ["Canceled", "canceled"]]) {
    Gio.DBus.session.signal_subscribe(null, "org.gnome.SessionManager.EndSessionDialog", signal,
        "/org/gnome/SessionManager/EndSessionDialog", null, Gio.DBusSignalFlags.NONE,
        () => {
            record(event);
            // A confirmed restart leaves the dialog faded out until the session ends.
            // Close it instead, so the test can go on.
            if (signal === "ConfirmedReboot")
                closeDialog();
        });
}

const exported = [
    [Gio.DBus.system, LOGIND_XML, logind, "/org/freedesktop/login1", "org.freedesktop.login1"],
    [Gio.DBus.session, SESSION_MANAGER_XML, sessionManager, "/org/gnome/SessionManager", "org.gnome.SessionManager"],
];
let owned = 0;
for (const [bus, xml, impl, path, name] of exported) {
    const object = Gio.DBusExportedObject.wrapJSObject(xml, impl);
    object.export(bus, path);
    impl._object = object;
    Gio.bus_own_name_on_connection(bus, name, Gio.BusNameOwnerFlags.NONE,
        () => {
            if (++owned === exported.length)
                record("ready");
        },
        () => record(`lost ${name}`));
}

new GLib.MainLoop(null, false).run();
