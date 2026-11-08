#!/bin/sh
# Start the menu bar app when you log in (on), or stop doing so (off).
# Run: sh menubar/login.sh on|off
set -e
LABEL=local.whatsmyagentdoing.menubar
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="${WMAD_MENUBAR_DEST:-$HOME/Applications}/WMADMenuBar.app"
case "$1" in
  on)
    [ -d "$APP" ] || { echo "Build it first: sh menubar/build.sh"; exit 1; }
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/open</string><string>-a</string><string>$APP</string></array>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
PL
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "on: starts at login ($PLIST)" ;;
  off)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "off" ;;
  *) echo "usage: sh menubar/login.sh on|off"; exit 1 ;;
esac
