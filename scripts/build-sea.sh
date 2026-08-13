#!/usr/bin/env bash
#
# Builds a Node single-executable (SEA) of the browser UI.
#
# Web only, by necessity: SEA injects a CommonJS bundle, and the TUI's
# dependency chain (ink → yoga-layout) uses top-level await, which cannot be
# expressed in CommonJS. Bundling the TUI here fails outright rather than
# degrading, so the binary ships `ports-web` and the TUI ships via npm.
#
# Run through the package manager (`pnpm build:sea`) so node_modules/.bin is on
# PATH.
set -euo pipefail

OUT=${OUT:-build}
NAME=${NAME:-ports-web}
VERSION=$(node -p "require('./package.json').version")
FUSE=NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

rm -rf "$OUT"
mkdir -p "$OUT"

esbuild src/web-entry.ts --bundle --platform=node --format=cjs --target=node20 \
  --define:__VERSION__="\"$VERSION\"" --outfile="$OUT/web-sea.cjs"

cat > "$OUT/sea-config.json" <<EOF
{
  "main": "$OUT/web-sea.cjs",
  "output": "$OUT/sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
EOF

node --experimental-sea-config "$OUT/sea-config.json"
cp "$(command -v node)" "$OUT/$NAME"

# macOS ships a signed `node`. The signature has to come off before injection
# and be reapplied after, or the result is killed on launch. Injection also
# needs its own Mach-O segment there.
postject_args=("$OUT/$NAME" NODE_SEA_BLOB "$OUT/sea-prep.blob" --sentinel-fuse "$FUSE")
if [[ "${OSTYPE:-}" == darwin* ]]; then
  codesign --remove-signature "$OUT/$NAME"
  postject_args+=(--macho-segment-name NODE_SEA)
fi

postject "${postject_args[@]}"

if [[ "${OSTYPE:-}" == darwin* ]]; then
  codesign --sign - "$OUT/$NAME"
fi

chmod +x "$OUT/$NAME"
rm -f "$OUT/sea-prep.blob" "$OUT/sea-config.json" "$OUT/web-sea.cjs"

echo "built $OUT/$NAME ($(du -h "$OUT/$NAME" | cut -f1)) — most of it is the embedded node runtime"
