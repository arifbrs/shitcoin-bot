#!/usr/bin/env bash
# JUAL OTOMATIS v42 (2026-10-18) — dipanggil berkala: menjual posisi live saat arm paper v42 menutupnya.
# HANYA KELUAR (--exits-only): tidak pernah membuka posisi baru tanpa perintah operator.
# Sumber sinyal: baris RH_CLOSE arm v42 di ledger paper (jembatan membaca itu).
cd "$(dirname "$0")" || exit 1
INTERVAL="${LIVE_EXITS_INTERVAL_SEC:-300}"
echo "[live-exits] mulai · interval ${INTERVAL}s · hanya keluar (mode exits-only)"
while true; do
  OUT=$(npm run rh:live --silent -- --strategy v42-liq25-50 --exits-only --yes 2>&1)
  echo "[live-exits] $(date '+%H:%M:%S') $(echo "$OUT" | grep -E 'rencana|jual|TOLAK|MODE|✗|✓' | head -4 | tr '\n' ' | ')"
  sleep "$INTERVAL"
done
