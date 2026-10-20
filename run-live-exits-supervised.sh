#!/usr/bin/env bash
# JUAL OTOMATIS v42 (2026-10-18) — dipanggil berkala: menjual posisi live saat arm paper v42 menutupnya.
# HANYA KELUAR (--exits-only): tidak pernah membuka posisi baru tanpa perintah operator.
# Sumber sinyal: baris RH_CLOSE arm v42 di ledger paper (jembatan membaca itu).
cd "$(dirname "$0")" || exit 1
INTERVAL="${LIVE_EXITS_INTERVAL_SEC:-300}"
echo "[live-exits] mulai · interval ${INTERVAL}s · hanya keluar (mode exits-only)"
while true; do
  # PEMULIHAN (2026-10-19): pantau likuiditas in-range pool gilet. Selama 0 → tidak ada yang bisa
  # dijual. Begitu > 0 (ada pihak menambah likuiditas) → jembatan akan menjualnya otomatis di siklus ini.
  LIQ=$(node -e 'fetch("https://rpc.mainnet.chain.robinhood.com",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{to:"0xcc1a638e7714ecc2e8e477c1a6259d2ed37bddc4",data:"0x1a686502"},"latest"]})}).then(r=>r.json()).then(j=>console.log(BigInt(j.result||"0x0").toString())).catch(()=>console.log("?"))' 2>/dev/null)
  echo "[live-exits] $(date '+%H:%M:%S') pool gilet liquidity=$LIQ $([ "$LIQ" != "0" ] && [ "$LIQ" != "?" ] && echo '★ LIKUIDITAS MUNCUL → jual dicoba')"
  OUT=$(npm run rh:live --silent -- --strategy v42-liq25-50 --exits-only --yes 2>&1)
  echo "[live-exits] $(date '+%H:%M:%S') $(echo "$OUT" | grep -E 'rencana|jual|TOLAK|MODE|✗|✓' | head -4 | tr '\n' ' | ')"
  sleep "$INTERVAL"
done
