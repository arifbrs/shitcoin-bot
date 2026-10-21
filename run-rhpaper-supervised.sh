#!/usr/bin/env bash
# LANE PAPER 1:1 — satu siklus tiap 5 menit. Satu penulis (lock di engine). Tanpa uang.
set -u
cd "$(dirname "$0")"
while true; do
  npx tsx src/rhpaper/run.ts 2>&1 | sed "s/^/[rhpaper-lane] /"
  sleep 300
done
