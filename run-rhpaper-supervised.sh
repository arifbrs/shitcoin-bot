#!/usr/bin/env bash
# LANE PAPER 1:1 — 3 ARM berurutan tiap 5 menit, MESIN & BIAYA SAMA (yang berbeda hanya aturan exit).
# Tanpa uang. Satu penulis (lock di engine).
set -u
cd "$(dirname "$0")"
run_arm() {
  local arm="$1" stop="$2" take="$3" hold="$4"
  RHPAPER_ARM="$arm" RHPAPER_STOP="$stop" RHPAPER_TAKE="$take" RHPAPER_HOLD_MIN="$hold" \
    npx tsx src/rhpaper/run.ts 2>&1 | sed "s/^/[rhpaper-$arm] /"
}
while true; do
  # KALIBRASI 2026-10-22: TP/stop pada skala gerakan nyata (bukan 150–400% yang tak pernah kena).
  run_arm A 1.5 2.0 240
  run_arm B 1.0 3.0 240
  run_arm C 2.0 5.0 240
  sleep 300
done
