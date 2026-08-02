#!/usr/bin/env bash
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.carlitos.portboard.plist"
LABEL="com.carlitos.portboard"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "$PLIST"

echo "portboard uninstalled: launch agent stopped and plist removed."
