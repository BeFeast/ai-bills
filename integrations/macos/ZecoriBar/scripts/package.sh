#!/bin/bash
# Package Zecori.app for delivery, the Figori way (BeFeast/figori docs/macos-signing.md): sign a staged
# COPY with Developer ID and the hardened runtime, notarize, staple, verify with Gatekeeper, then zip.
#   scripts/package.sh release|draft <Zecori.app> <out-dir>
# release needs ZECORI_SIGNING_IDENTITY and ZECORI_NOTARY_PROFILE (an existing notarytool keychain profile).
set -euo pipefail
mode="${1:?release|draft}"; app="${2:?app}"; out="${3:?out-dir}"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
mkdir -p "$out"
stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/Zecori.app"
name="Zecori-${version}-macos-arm64"
if [[ $mode == release ]]; then
  : "${ZECORI_SIGNING_IDENTITY:?signing identity required}"; : "${ZECORI_NOTARY_PROFILE:?notary profile required}"
  codesign --force --options runtime --timestamp --sign "$ZECORI_SIGNING_IDENTITY" "$stage/Zecori.app"
  codesign --verify --deep --strict --verbose=2 "$stage/Zecori.app"
  ditto -c -k --keepParent "$stage/Zecori.app" "$stage/notarize.zip"
  xcrun notarytool submit "$stage/notarize.zip" --keychain-profile "$ZECORI_NOTARY_PROFILE" --wait --output-format json > "$out/notarization.json"
  grep -q '"status" *: *"Accepted"' "$out/notarization.json" || { cat "$out/notarization.json" >&2; exit 1; }
  xcrun stapler staple "$stage/Zecori.app"
  xcrun stapler validate "$stage/Zecori.app"
  spctl --assess --type execute --verbose=2 "$stage/Zecori.app" 2>&1 | tee "$out/gatekeeper.txt"
  status="notarized"
else
  name="${name}-DRAFT-NOT-NOTARIZED"
  status="draft (ad-hoc signed, not notarized)"
fi
ditto -c -k --keepParent "$stage/Zecori.app" "$out/$name.zip"
printf 'version %s\nstatus %s\nsource %s\n' "$version" "$status" "$(git rev-parse HEAD 2>/dev/null || echo unknown)" > "$out/PACKAGING_STATUS"
(cd "$out" && shasum -a 256 "$name.zip" PACKAGING_STATUS > SHA256SUMS && cat SHA256SUMS)
