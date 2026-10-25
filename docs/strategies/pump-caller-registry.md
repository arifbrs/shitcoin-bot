# REGISTRY LANE PUMP-CALLER (pre-registrasi, 2026-10-25)
Modul: `src/research/pump-caller/` — nol-modal, read-only, tidak menandatangani apa pun.
Skrip: `pump:collect [--mint <addr>|--fixture]` · `pump:observe` · `pump:report`.
Model biaya riset: `pump-paper-cost-v1` = fee 1% + slip 1,5% per sisi (5,0pp putaran) — PARAMETER, belum terkalibrasi.

## Hipotesis (trigger DIBEKUAN — jangan di-tune dari hasil)
| ID | Trigger | Baseline pembanding |
|---|---|---|
| UNDERWATER_CALLER_REBOUND | caller HOLDING/PARTIAL_SELL dgn unrealized<0 | semua token dgn aktivitas caller |
| LARGE_BUY_SMALL_SELL_ABSORPTION | ≥1 large-buy ($500/$1000 / ≥2% likuiditas) + netflow>0 + pengikut menyusul + pembeli-awal tak cepat-jual | token dgn tape tapi tanpa large-buy |
| EARLY_INFLUENCER_CALLER_CASCADE | caller terverifikasi terdeteksi ≤5 menit pasca beli | token sama, trigger large-buy non-caller pertama |
Outcome: 1m/5m/15m/1h/6h/24h/48h dari candle 1m/1s representatif (gap/volume-0 DITOLAK, bukan diarang).
Status: INSUFFICIENT (belum ada observasi prospektif non-fixture).

## Ketergantungan data
- swap-api trades/candles (bebas-kunci) — LIVE.
- Pump.fun Developer API (home-feed, callout, user-positions/trades, mint-positions) —
  **BLOCKED_EXTERNAL**: butuh `PUMPFUN_API_KEY` (aplikasi + persetujuan operator). Tanpa kunci:
  caller timeline = missing-data eksplisit; fixture dipakai hanya utk tes (dilabel, bukan bukti pasar).
- Follower count & riwayat callout: sama (Developer API).
