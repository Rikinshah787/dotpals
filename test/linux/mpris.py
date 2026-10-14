# A pretend music player for test/linux/hands-linux.mjs: it shows up to playerctl over MPRIS
# (the session bus) as "dotplayer", playing "Sunny Morning" by The Examples, and prints each
# button pressed on it.
import sys
from gi.repository import Gio, GLib

XML = """<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
    <method name="Raise"/><method name="Quit"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/><method name="Play"/><method name="Pause"/><method name="Stop"/>
    <method name="Next"/><method name="Previous"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanControl" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
  </interface>
</node>"""
P = "org.mpris.MediaPlayer2.Player"
state = {"status": "Playing", "track": 0}
TRACKS = [("Sunny Morning", "The Examples"), ("Rainy Evening", "The Examples")]
conn = None


def meta():
    title, artist = TRACKS[state["track"] % len(TRACKS)]
    return {"mpris:trackid": GLib.Variant("o", "/dot/track/%d" % state["track"]),
            "xesam:title": GLib.Variant("s", title), "xesam:artist": GLib.Variant("as", [artist])}


def get(_c, _s, _p, iface, prop):
    if prop == "Identity": return GLib.Variant("s", "Dot Player")
    if prop == "PlaybackStatus": return GLib.Variant("s", state["status"])
    if prop == "Metadata": return GLib.Variant("a{sv}", meta())
    return GLib.Variant("b", True)


def changed():
    conn.emit_signal(None, "/org/mpris/MediaPlayer2", "org.freedesktop.DBus.Properties", "PropertiesChanged",
                     GLib.Variant("(sa{sv}as)", (P, {"PlaybackStatus": GLib.Variant("s", state["status"]), "Metadata": GLib.Variant("a{sv}", meta())}, [])))


def call(_c, _s, _p, iface, method, _args, inv):
    print(method, flush=True)
    if method == "PlayPause": state["status"] = "Paused" if state["status"] == "Playing" else "Playing"
    elif method == "Play": state["status"] = "Playing"
    elif method == "Pause": state["status"] = "Paused"
    elif method == "Stop": state["status"] = "Stopped"
    elif method == "Next": state["track"] += 1
    elif method == "Previous": state["track"] = max(0, state["track"] - 1)
    inv.return_value(None)
    if iface == P: changed()


def acquired(c, _name):
    global conn
    conn = c
    for iface in Gio.DBusNodeInfo.new_for_xml(XML).interfaces:
        c.register_object("/org/mpris/MediaPlayer2", iface, call, get, None)


Gio.bus_own_name(Gio.BusType.SESSION, "org.mpris.MediaPlayer2.dotplayer", Gio.BusNameOwnerFlags.NONE,
                 acquired, lambda *_: print("ready", flush=True), lambda *_: sys.exit(1))
GLib.MainLoop().run()
