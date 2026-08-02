#!/usr/bin/env bash
set -euo pipefail

NODE="$(command -v node || echo "$HOME/.local/bin/node")"
PLIST="$HOME/Library/LaunchAgents/com.carlitos.portboard.plist"
LABEL="com.carlitos.portboard"
SERVER="$(cd "$(dirname "$0")" && pwd)/server.js"
LOG="$HOME/Library/Logs/portboard.log"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE}</string>
        <string>${SERVER}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG}</string>
    <key>StandardErrorPath</key>
    <string>${LOG}</string>
</dict>
</plist>
EOF

# Reload safely: remove any existing instance, then bootstrap the new one.
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
if ! launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
    echo "bootstrap failed, falling back to launchctl load -w" >&2
    launchctl load -w "$PLIST"
fi

echo "portboard installed and running."
echo "  http://localhost:7777"
echo "  http://$(hostname -s).local:7777"
