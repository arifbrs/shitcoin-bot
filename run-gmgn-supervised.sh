#!/bin/bash
# GMGN LANE — proxy + pantauan penuh + laporan harian. Read-only, zero capital.
#
# Dipisah dari run-research-supervised.sh (2026-10-07, keputusan owner: "fokus penuh ke
# Robinhood + GMGN", seluruh lane Solana dimatikan). Proses scout/outcome/paper Solana TIDAK
# dijalankan lagi; GMGN tetap hidup karena sinyal + kualitas wallet-nya jadi bahan riset lane
# Robinhood. Proxy harus naik lebih dulu: ia satu-satunya proses yang bicara ke GMGN.
cd "$(dirname "$0")"

supervise() {
  local name="$1"; shift
  while true; do
    "$@"
    echo "[gmgn-supervisor] $name exited (code $?) — restarting in 3s..."
    sleep 3
  done
}

supervise "gmgn-proxy" npm run gmgn:proxy &
sleep 3
supervise "gmgn-full-watch" npm run gmgn:full-watch &
supervise "gmgn-report" npm run gmgn:report -- --daily &
wait
