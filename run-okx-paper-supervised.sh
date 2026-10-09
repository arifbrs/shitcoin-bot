#!/bin/bash
# OKX STRICT-PAPER SUPERVISOR — paper trading OKX (uang kertas, TANPA risiko).
#
# Bukti tanpa-risiko (dijaga oleh kode, bukan janji): proses ini tidak mengimpor wallet/signer/
# broadcaster; ia meminta tx UNSIGNED dari OKX, mensimulasikan beli ke state mainnet saat itu,
# lalu menghitung exit virtual dari quote min-receive. Tidak ada yang bisa ditandatangani.
# State: logs/okx-strict-paper-v2-state.json · lock: logs/okx-strict-paper.lock (anti dobel-proses).
cd "$(dirname "$0")" || exit 1
while true; do
  npm run okx:paper
  echo "[okx-paper-supervisor] exit $? — restart 5s"
  sleep 5
done
