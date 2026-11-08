#!/bin/sh
# Builds the menu bar app with the Command Line Tools' swiftc (no Xcode needed)
# and puts it in ~/Applications. Run: sh menubar/build.sh
set -e
cd "$(dirname "$0")"
OUT="${WMAD_MENUBAR_DEST:-$HOME/Applications}/WMADMenuBar.app"
mkdir -p build
swiftc -O -swift-version 5 -target arm64-apple-macos14.0 -framework AppKit WMADMenuBar.swift -o build/WMADMenuBar
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS"
cp Info.plist "$OUT/Contents/Info.plist"
cp build/WMADMenuBar "$OUT/Contents/MacOS/WMADMenuBar"
codesign --force --sign - "$OUT" >/dev/null 2>&1 || true
echo "built: $OUT"
