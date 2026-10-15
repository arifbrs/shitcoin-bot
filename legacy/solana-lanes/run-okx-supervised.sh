#!/bin/bash
# OKX SUPERVISOR — lane observasi read-only OKX OnchainOS (trenches/scout/radar/observatory).
# 2026-10-08: blokir DNS ISP hilang (uji live: 55/56 endpoint menjawab) → lane ini dinyalakan
# kembali. TIDAK menandatangani, TIDAK broadcast, tidak menyentuh bot trading.
cd "$(dirname "$0")" || exit 1
while true; do
  npm run okx:lane
  echo "[okx-supervisor] exit $? — restart 5s"
  sleep 5
done
