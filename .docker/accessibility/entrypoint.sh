#!/usr/bin/env bash
set -eu
mkdir -p /tmp/desktop-accessibility "$XDG_RUNTIME_DIR"
chmod 700 /tmp/desktop-accessibility "$XDG_RUNTIME_DIR"
exec dbus-run-session -- bash /app/.docker/accessibility/session.sh "$@"
