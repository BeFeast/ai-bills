#!/usr/bin/env bash
# Install or update the Zecori bar widget for the current user on Omarchy.
#
#   ./install.sh [placement]      e.g. ./install.sh --section right --after omarchy.agents
#
# Copies this directory to ~/.config/omarchy/plugins/befeast.zecori, asks the
# shell to rescan its plugins and enables the widget at the given placement.
# The device token is not touched: put it in ~/.config/zecori/token (mode 0600).
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$HOME/.config/omarchy/plugins/befeast.zecori"

mkdir -p "$dest"
for file in manifest.json Panel.qml zecori-fetch README.md; do
  install -m 0644 "$src/$file" "$dest/$file"
done
chmod 0755 "$dest/zecori-fetch"
mkdir -p "$dest/assets"
install -m 0644 "$src/assets/"* "$dest/assets/"

omarchy-shell shell rescanPlugins >/dev/null
if omarchy plugin list --json 2>/dev/null | jq -e '.[] | select(.id == "befeast.zecori") | .enabled == true' >/dev/null 2>&1; then
  echo "befeast.zecori is already enabled; files updated"
else
  omarchy plugin enable befeast.zecori "$@"
fi
echo "installed to $dest"
