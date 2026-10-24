#!/usr/bin/env bash
# JEMBATAN LIVE v42 (2026-10-18; kebenaran header diperbaiki audit 2026-10-24) — menjalankan
# `rh:live --mode exit-only --yes` berkala. AUDIT round-3 (A3): skrip ini kini STRUKTURAL
# exit-only — mode penuh (boleh beli) hanya lewat `npm run rh:live -- --mode full` MANUAL,
# dan tetap wajib LIVE_TRADING_CONFIRMED=yes di .env. JUAL (pengurangan risiko, posisi
# terlacak + saldo terverifikasi) selalu jalan. Lock duplikasi mencegah dua loop bersamaan.
# Lane ini TIDAK dijaga lane-guard (statusnya dilihat via tools/lane-status.mjs).
cd "$(dirname "$0")" || exit 1
INTERVAL="${LIVE_EXITS_INTERVAL_SEC:-300}"
lock=logs/live-exits-supervisor.lock
if ! ( set -C; printf '%s\n' "$$" > "$lock" ) 2>/dev/null; then
  owner=$(cat "$lock" 2>/dev/null)
  case "$owner" in ''|*[!0-9]*) echo "[live-exits] lock tidak sah; dipertahankan"; exit 1;; esac
  if kill -0 "$owner" 2>/dev/null; then echo "[live-exits] sudah jalan (pid $owner)"; exit 1; fi
  rm "$lock"
  ( set -C; printf '%s\n' "$$" > "$lock" ) 2>/dev/null || exit 1
fi
trap 'rm -f "$lock"; exit 0' INT TERM EXIT
echo "[live-exits] mulai · interval ${INTERVAL}s · mode penuh — BELI tunduk LIVE_TRADING_CONFIRMED, JUAL selalu"
while true; do
  # PEMULIHAN (2026-10-19): pantau likuiditas in-range pool gilet. Selama 0 → tidak ada yang bisa
  # dijual. Begitu > 0 (ada pihak menambah likuiditas) → jembatan akan menjualnya otomatis di siklus ini.
  LIQ=$(node -e 'fetch("https://rpc.mainnet.chain.robinhood.com",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to:"0xcc1a638e7714ecc2e8e477c1a6259d2ed37bddc4",data:"0x1a686502"},"latest"]})}).then(r=>r.json()).then(j=>console.log(BigInt(j.result||"0x0").toString())).catch(()=>console.log("?"))' 2>/dev/null)
  echo "[live-exits] $(date '+%H:%M:%S') pool gilet liquidity=$LIQ $([ "$LIQ" != "0" ] && [ "$LIQ" != "?" ] && echo '★ LIKUIDITAS MUNCUL → jual dicoba')"
  OUT=$(npm run rh:live --silent -- --mode exit-only --strategy v42-liq25-50 --usd ${LIVE_USD:-2.5} --max 1 --yes 2>&1)
  echo "[live-exits] $(date '+%H:%M:%S') $(echo "$OUT" | grep -E 'rekonsiliasi|rencana|jual|TOLAK|GERBANG|MODE|✗|✓' | head -5 | tr '\n' ' | ')"
  sleep "$INTERVAL"
done
