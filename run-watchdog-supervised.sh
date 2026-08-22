#!/bin/bash
# WATCHDOG — memantau kebuntuan jalur trading dan membunuh sniper agar supervisor menghidupkannya.
# Lihat src/watchdog.mjs untuk insiden yang melahirkannya (2026-08-07, bot diam 4 jam).
cd "$(dirname "$0")" || exit 1
export WATCHDOG_RUN=1
while true; do
  node src/watchdog.mjs
  echo "[watchdog-supervisor] keluar (code $?) — hidupkan lagi 10s"
  sleep 10
done
