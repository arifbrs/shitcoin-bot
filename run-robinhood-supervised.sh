#!/bin/bash
# Supervises the ROBINHOOD CHAIN (Ethereum L2, chain ID 4663) paper lane — 10 varian, risk $5/trade.
#
# Read-only by construction: tidak ada wallet, tidak ada signing, tidak ada eksekusi — semua isian
# paper. Sumber data GRATIS tanpa key: GeckoTerminal (discovery + metrik pool + OHLCV backtest)
# dan DexScreener (mark batch + sinyal promosi). Zero capital, terpisah dari lane Solana.
#
# - rh-paper  : forward test 10 varian, siklus 3 menit.
# - rh-review : laporan harian 08:00 waktu lokal + riset utk hari berikutnya (offline).
# Backtest BUKAN proses panjang — jalankan manual: `npm run rh:backtest` (atau lewat review besok).
cd "$(dirname "$0")"

supervise() {
  local name="$1"; shift
  while true; do
    "$@"
    echo "[rh-supervisor] $name exited (code $?) — restarting in 3s..."
    sleep 3
  done
}

supervise "rh-paper" npm run rh:paper &
supervise "rh-review" npm run rh:review &
wait
