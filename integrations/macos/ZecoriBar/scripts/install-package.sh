#!/bin/bash
# Install an already signed/notarized package into the runner user's existing GUI session.
# Explicit operational step: never called by push builds. Keeps the previous app for rollback.
set -euo pipefail
archive="${1:?signed package zip}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
ditto -x -k "$archive" "$work"
app="$work/Zecori.app"
codesign --verify --deep --strict "$app"
spctl --assess --type execute --verbose=2 "$app"
launchctl print "gui/$(id -u)" >/dev/null

dest="$HOME/Applications/Zecori.app"
[[ -d $dest ]] || { echo 'Existing user installation not found; refusing to guess destination' >&2; exit 1; }
backup="$HOME/Library/Application Support/Zecori/Backups/$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_SHA:-local}"
mkdir -p "$backup"
ditto "$dest" "$backup/Zecori.app"
# Stage on the destination filesystem before stopping the current process.
staged=$(mktemp -d "$HOME/Applications/.zecori-update.XXXXXX")
ditto "$app" "$staged/Zecori.app"
old="$staged/previous.app"
rollback() {
  pkill -u "$(id -u)" -x ZecoriBar 2>/dev/null || true
  if [[ -d $old ]]; then
    rm -rf "$dest"
    mv "$old" "$dest"
  fi
  open "$dest"
  echo "Installation failed; previous app restored. Backup: $backup" >&2
}
trap 'rollback; rm -rf "$staged" "$work"' ERR
pkill -u "$(id -u)" -x ZecoriBar 2>/dev/null || true
for attempt in {1..20}; do
  pgrep -u "$(id -u)" -x ZecoriBar >/dev/null || break
  sleep 0.25
done
if pgrep -u "$(id -u)" -x ZecoriBar >/dev/null; then
  echo 'Existing app did not exit' >&2
  false
fi
mv "$dest" "$old"
mv "$staged/Zecori.app" "$dest"
open "$dest"
sleep 3
pgrep -u "$(id -u)" -x ZecoriBar >/dev/null
cmp "$app/Contents/MacOS/ZecoriBar" "$dest/Contents/MacOS/ZecoriBar"
trap - ERR
rm -rf "$staged"
printf 'Installed version: '
/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$dest/Contents/Info.plist"
shasum -a 256 "$dest/Contents/MacOS/ZecoriBar"
printf 'Rollback app: %s/Zecori.app\n' "$backup"
