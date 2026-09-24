#!/bin/bash
# Install or update Zecori.app (menu bar) for the current user — no sudo, no Homebrew.
# The notarized build is fetched from the OK Labs Forgejo package registry by IP (github.com and
# internal names are unreliable from a corporate VPN), checked against its sha256, verified with
# Gatekeeper and installed to ~/Applications. An existing device token is reused: the Omarchy-style
# file ~/.config/zecori/token, or the one already pasted into the CodexBar Zecori plugin.
set -euo pipefail
VERSION=__VERSION__
ZIP_SHA=__ZIP_SHA__
BASE="${ZECORI_PACKAGES:-http://10.10.0.27:3000/api/packages/BeFeast/generic/zecori-bar}"
name="Zecori-${VERSION}-macos-arm64.zip"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

echo "1/4 Downloading Zecori ${VERSION}…"
curl -fL --progress-bar --connect-timeout 10 -o "$work/$name" "$BASE/$VERSION/$name"
echo "$ZIP_SHA  $work/$name" | shasum -a 256 -c - >/dev/null || { echo "Checksum mismatch; nothing was installed." >&2; exit 1; }

echo "2/4 Checking the Apple signature…"
ditto -x -k "$work/$name" "$work/x"
spctl --assess --type execute -vv "$work/x/Zecori.app" 2>&1 | sed 's/^/   /'

echo "3/4 Installing to ~/Applications/Zecori.app…"
if pgrep -xq ZecoriBar; then osascript -e 'quit app "Zecori"' 2>/dev/null || pkill -x ZecoriBar || true; sleep 1; fi
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/Zecori.app"
ditto "$work/x/Zecori.app" "$HOME/Applications/Zecori.app"

echo "4/4 Device token…"
tokenfile="$HOME/.config/zecori/token"
if [ -s "$tokenfile" ]; then
  echo "   using $tokenfile"
elif [ -f "$HOME/.config/codexbar/config.json" ] && command -v jq >/dev/null; then
  value=$(jq -r '.providers[]? | select(.id=="zecori") | .pluginSecrets.DEVICE_TOKEN // empty' "$HOME/.config/codexbar/config.json" 2>/dev/null || true)
  if [ -n "$value" ]; then
    (umask 077; mkdir -p "$HOME/.config/zecori"; printf '%s\n' "$value" > "$tokenfile")
    echo "   copied from the CodexBar Zecori plugin"
  else
    echo "   none found: Zecori opens Settings, paste the token there"
  fi
else
  echo "   none found: Zecori opens Settings, paste the token there"
fi

open "$HOME/Applications/Zecori.app"
echo
echo "Done. Zecori is in the menu bar (the Z coin). Right click it for Settings; turn on Launch at login there."
