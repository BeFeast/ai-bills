#!/bin/bash
# Build Zecori.app (arm64, macOS 14+) from this package into <out-dir>. Ad-hoc signed; package.sh
# re-signs a staged copy with Developer ID for release.
#   scripts/build-app.sh <out-dir>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="${1:?output directory}"
version="$(tr -d '[:space:]' < "$here/VERSION")"
build="$(git -C "$repo" rev-parse --short=12 HEAD 2>/dev/null || echo local)"

cd "$here"
swift build -c release --arch arm64 --product ZecoriBar
bin="$(swift build -c release --arch arm64 --show-bin-path)/ZecoriBar"

app="$out/Zecori.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/ZecoriBar"
# The hero portrait is the same cut-out mark the Omarchy widget uses.
cp "$repo/integrations/omarchy/befeast.zecori/assets/zecori-mark.png" "$app/Contents/Resources/zecori-mark.png"

# App icon from the brand avatar.
iconset="$(mktemp -d)/Zecori.iconset"; mkdir -p "$iconset"
src="$repo/public/brand/zecori-avatar-512.png"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$src" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2)); [ "$double" -le 512 ] && sips -z "$double" "$double" "$src" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
cp "$src" "$iconset/icon_512x512@2x.png"
iconutil -c icns "$iconset" -o "$app/Contents/Resources/Zecori.icns"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.befeast.zecori-bar</string>
  <key>CFBundleName</key><string>Zecori</string>
  <key>CFBundleDisplayName</key><string>Zecori</string>
  <key>CFBundleExecutable</key><string>ZecoriBar</string>
  <key>CFBundleIconFile</key><string>Zecori</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}+${build}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>BeFeast · MIT</string>
</dict></plist>
PLIST
plutil -lint "$app/Contents/Info.plist" >/dev/null
codesign --force --sign - "$app"
echo "built $app ($version+$build)"
