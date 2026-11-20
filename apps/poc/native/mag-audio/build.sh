#!/bin/sh
# Builds the meeting audio helper (macOS 14.2+), ad-hoc signed, into build/mag-audio; skipped when up to date or not on macOS.
set -e
[ "$(uname)" = Darwin ] || exit 0
cd "$(dirname "$0")"
out=build/mag-audio
[ -x "$out" ] && [ "$out" -nt main.swift ] && [ "$out" -nt Info.plist ] && exit 0
mkdir -p build
xcrun swiftc -O -target "$(uname -m)-apple-macos14.2" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist \
  main.swift -o "$out"
codesign -s - -f -i dev.mag.audio "$out"
