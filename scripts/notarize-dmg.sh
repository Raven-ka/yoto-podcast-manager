#!/usr/bin/env bash
# Notarize + staple the .dmg itself. `tauri build` only notarizes the .app
# inside it, which leaves the .dmg as "Unnotarized Developer ID" — a
# downloaded copy then gets a Gatekeeper warning when opened.
# Run after: source scripts/release-env.local.sh && npx tauri build
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/release-env.local.sh
for dmg in src-tauri/target/release/bundle/dmg/*.dmg; do
  echo "Notarizing $dmg"
  xcrun notarytool submit "$dmg" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$dmg"
  spctl -a -vv -t open --context context:primary-signature "$dmg"
done
