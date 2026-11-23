#!/usr/bin/env bash
set -eu
root=/tmp/desktop-accessibility
phase=environment
pids=()
finish() {
    status=$?
    trap - EXIT
    printf '{"phase":"%s","exitCode":%s}\n' "$phase" "$status" > "$root/session-result.json"
    for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
    sleep 1
    # Orca can remain inside an AT-SPI call after X terminates. Bound teardown.
    for pid in "${pids[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
    exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$root/speech" "$root/speech-log" "$root/orca"
export SPEECHD_ADDRESS=unix_socket:$root/speech.sock
Xvfb "$DISPLAY" -screen 0 1440x1000x24 -nolisten tcp > "$root/xvfb.log" 2>&1 &
pids+=("$!")
for attempt in $(seq 1 50); do if xdpyinfo >/dev/null 2>&1; then break; fi; sleep .1; done
xdpyinfo > "$root/display.txt"
openbox > "$root/openbox.log" 2>&1 &
pids+=("$!")
pulseaudio --daemonize=no --exit-idle-time=-1 --load='module-null-sink sink_name=review_sink' > "$root/pulseaudio.log" 2>&1 &
pids+=("$!")
for attempt in $(seq 1 50); do if pactl info >/dev/null 2>&1; then break; fi; sleep .1; done
pactl set-default-sink review_sink
printf '%s\n' 'LogLevel 5' 'DefaultLanguage "en"' 'AudioOutputMethod "pulse"' 'AddModule "espeak-ng" "sd_espeak-ng" "/etc/speech-dispatcher/modules/espeak-ng.conf"' 'DefaultModule espeak-ng' > "$root/speech/speechd.conf"
speech-dispatcher --run-single --config-dir="$root/speech" --socket-path="$root/speech.sock" --pid-file="$root/speech.pid" --log-dir="$root/speech-log" --log-level=5 --timeout=0 > "$root/speech-process.log" 2>&1 &
pids+=("$!")
printf '%s\n' '{"general":{"firstStart":false,"enableSpeech":true,"enableBraille":false,"startingProfile":["Default","default"],"activeProfile":["Default","default"]},"profiles":{"default":{"profile":["Default","default"]}},"pronunciations":{},"keybindings":{}}' > "$root/orca/user-settings.conf"
/usr/bin/python3 -c 'from gi.repository import Gio; Gio.Settings.new("org.gnome.desktop.interface").set_boolean("toolkit-accessibility", True); Gio.Settings.sync()'
cp /app/.docker/accessibility/orca-customizations.py "$root/orca/orca-customizations.py"
orca --replace --enable=speech --disable=braille --user-prefs="$root/orca" --debug-file="$root/orca-debug.log" > "$root/orca-process.log" 2>&1 &
pids+=("$!")
for attempt in $(seq 1 50); do
    if [ -S "$root/speech.sock" ] && [ -s "$root/orca-debug.log" ]; then break; fi
    sleep .1
done
test -S "$root/speech.sock"
test -s "$root/orca-debug.log"
kill -0 "${pids[4]}"
/usr/bin/python3 -c 'from gi.repository import Gio; bus=Gio.bus_get_sync(Gio.BusType.SESSION); print(bus.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress", None, None, Gio.DBusCallFlags.NONE, 5000, None).unpack())' > "$root/at-spi-bus.txt"
phase=tests
"$@"
phase=finished
