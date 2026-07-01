#!/usr/bin/env bash
# Convert the kie.ai-generated 6.5MB PNGs to ~60KB 800px-wide webps.
# Idempotent — re-running just re-encodes (cheap, ~50ms each).
set -euo pipefail

DIR="$(cd "$(dirname "$0")/../src/assets/hermes-art/file-types" && pwd)"
echo "[webp] dir: $DIR"

count=0
for png in "$DIR"/*.png; do
  [ -f "$png" ] || continue
  webp="${png%.png}.webp"
  ffmpeg -y -i "$png" -vf "scale=800:-1" -quality 82 -compression_level 6 "$webp" 2>/dev/null
  size_png=$(stat -f%z "$png")
  size_webp=$(stat -f%z "$webp")
  ratio=$(echo "scale=1; $size_png / $size_webp" | bc)
  printf "  ✓ %-12s %4dKB → %3dKB  (%sx smaller)\n" "$(basename "$webp")" "$((size_png/1024))" "$((size_webp/1024))" "$ratio"
  count=$((count+1))
done

echo "[webp] $count files converted."
