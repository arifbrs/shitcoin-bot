# Progres Plan — Celah Data & Penutupan Bukti (diperbarui otomatis jadi laporan)

Rujukan plan: `~/.commandcode/plans/celah-data-onchain-gmgn-dexscreener.md`
Aturan mutlak: **jangan berasumsi, jangan halusinasi** — klaim hanya dengan CI tidak melewati nol +
konsentrasi aman; yang belum cukup sampel **disebut namanya**.

## Selamat datang, laporan
- **Review otomatis 08:00** (wajib): `logs/robinhood-review-<tanggal>.md` — bagian **I** memuat
  retensi harga pasca-keluar, kualitas stop, realisme keluar, arm OKX, **dan penghitung jalur baru**
  (on-chain liq / risiko ditolak / tulis-basi / jejak diselamatkan / penutupan ganda ditahan).
  Review kini juga **menyegarkan sendiri** laporan `rh:stop`, `rh:realism`, `okx:verdict`.
- **Dashboard** `http://localhost:4317/app` — kartu **"Kualitas eksekusi"** (retensi pasca-keluar).
- **Perintah laporan manual:** `npm run rh:verdict` (kohort & arm) · `npm run rh:realism` ·
  `npm run rh:stop` · `npm run okx:verdict` · `npm run rh:audit` (gerbang pembukuan).

## Status langkah
| langkah | status | bukti |
|---|---|---|
| 1.1 probe URL benar + chain 0x1237 | **SELESAI** | commit `0528c32` |
| 1.2 probe: pool RH = **V3-style** | **SELESAI** | `liquidity()`/`slot0()`/`fee()` ✓ · `getReserves()` revert · log 3 topik+160B |
| 1.3 pemantau on-chain hidup | **SELESAI** | commit `44f2c02` · 8 acuan · 12 pool dicek · 63/63 tes · saklar `RH_ONCHAIN_LIQ=0` |
| 1.4 efek terukur (jam-jaman) | **MENUNGGU DATA** | hitung `rh-onchain-liq` + banding share overshoot (`rh:stop`) & `mark_basi` (`rh:realism`) sebelum vs sesudah |
| 2.1 verifikasi dokumen GMGN trenches (chain robinhood) | **BELUM** | integrasi HANYA bila terbukti; kalau tidak → catat "tidak didukung" |
| #4 arm pra-saring DexScreener (kontrol berpasangan) | **BELUM** | data boost sudah terkumpul, belum dipakai keputusan |
| Kebersihan: env hilang di `.env.example` | **SELESAI** (45e39be) | 18 env tak terdokumentasi dicatat (nonaktif) |
| Kebersihan: klaim `sumber.ts` soal Solana Tracker | **BUKTI TIDAK DITEMUKAN** | pencarian "dipakai lane RH" di sumber.ts = 0 baris → laporan agen sebelumnya TIDAK terverifikasi; tidak ada perubahan yang bisa dilakukan. Commit 45e39be sempat MENGAKUI ini diperbaiki — koreksi dicatat di sini. |
| Penutupan bukti v42 | **MENUNGGU** | 68 dari ≈94 tutup · laju 1,00/jam → ≈26 jam |
| Penutupan bukti kohort-8 (v53/v54) | **MENUNGGU** | 4/4 tutup; ambang-n dihitung dari verdict |
| Risk (aktif, dari pengukuran) | **AKTIF** | 125 / 2000 / 168 · `rh-risk-block` = 0 · sesuaikan hanya setelah pengukuran baru |

## Hal yang TIDAK dilakukan (dan alasannya)
Memperlebar gate arm berjalan (mencampur sampel) · gRPC berbayar tanpa verifikasi harga resmi ·
memasang `GMGN_PRIVATE_KEY` untuk wallet-level tanpa keputusan operator · mengklaim hasil tanpa
CI + konsentrasi.

## Catatan jujur soal "lanjut sendiri"
Lane berjalan **24/7 tanpa sesi** dan laporan otomatis tetap terbit (review 08:00, dashboard,
audit). Namun **pekerjaan analisis/koding-ku hanya berjalan saat sesi ini aktif** — jadi langkah
1.4/2.1/#4 akan kukerjakan begitu sesi dilanjutkan, bukan saat kau tutup.

## Koreksi rekam jejak
- Commit `45e39be` mengklaim dua hal; yang BENAR hanya penambahan dokumentasi env. Klaim `sumber.ts`
  **tidak diverifikasi** (pencarian kata kunci = 0 baris) → tidak ada perubahan di berkas itu.
  Pelajaran yang sama seperti hari-hari sebelumnya: **klaim tidak boleh mendahului bukti.**

## Perubahan konfigurasi yang disengaja (agar sesi berikutnya tidak bingung)
- **Dashboard DINYALAKAN LAGI oleh operator (2026-10-13, sore).** Catatan historis: sempat DIMATIKAN (2026-10-13). Saklar: `DASHBOARD_DISABLED=1` di `.env`.
  `bot.sh start` tidak menyalakannya, dan `tools/lane-guard.sh` **tidak lagi menjaganya** (baris guard
  dikomentari) supaya ia tidak dihidupkan ulang diam-diam. Untuk menyalakan lagi: hapus
  `DASHBOARD_DISABLED=1`, buka komentar baris `guard "dashboard"` di lane-guard, lalu `./bot.sh start`.
  Konsekuensi jujur: kartu "Kualitas eksekusi" & panel web tidak bisa diakses selama ini mati; laporan
  tetap datang lewat review 08:00 (`logs/robinhood-review-<tanggal>.md`) dan `npm run` di terminal.

## KOREKSI PENTING (2026-10-13, dari screenshot operator) — JALUR DANA EKSEKUSI

**Aku salah sebelumnya.** Wallet yang kubuat (`0x629Ec42444A43A0E02A572587E3A49904542F4E8`)
BUKAN tempat mendanai eksekusi GMGN. Yang benar (dari dialog Deposit GMGN milik operator):

- Untuk eksekusi lewat GMGN, dana masuk ke **alamat deposit GMGN** pada jaringan **Robinhood**:
  `0x4b2600ce0Ab31D16E54FA493e7FFFc94bCdBDcC2` (diverifikasi: RPC Robinhood menjawab untuk alamat ini).
- GMGN menyatakan sendiri: alamat itu **hanya menerima ETH & USDG**, **hanya lewat jaringan Robinhood**
  ("do not use other networks to avoid any loss of funds").
- Daftar jaringan di GMGN: SOL · BSC · **Robinhood** · Base · ETH · Arbitrum · Stable · Arc · X Layer · HyperEVM.
- Jadi: **wallet buatan bot hanya relevan untuk jalur langsung ke router (Opsi B)**, bukan untuk GMGN (Opsi A).
- **Hipotesis yang bisa diuji murah:** gerbang `PLAN_UPGRADE_REQUIRED` (weight 10) yang kita ukur berlaku
  untuk **API/CLI**; **web UI GMGN (wallet tertanam, model fomo.family)** mungkin bisa eksekusi tanpa paket.
  Uji: deposit kecil → swap kecil di web UI GMGN jaringan Robinhood → ukur fee/gas/slippage nyata.

Status saldo terukur (2026-10-13): alamat bot 0 ETH di RH/mainnet/Base; alamat deposit GMGN 0 ETH di RH/mainnet.

## PENGUKURAN JEMBATAN (2026-10-13) — angka nyata, bukan estimasi

- Wallet1 `0x4b2600ce0Ab31D16E54FA493e7FFFc94bCdBDeC2` (checksum sah; salinan teks dari operator).
- Kirim 0,0051 ETH (mainnet) → terima **0,005088 ETH (Robinhood chain)**; sisa mainnet 0,000589 ETH.
- Biaya kurs/jembatan ≈ 0,000012 ETH (~0,24%) · gas mainnet ≈ 0,000311 ETH (≈$0,76).
- **Estimasi gas di dialog GMGN hanya $0,016764 — nyatanya ≈$0,76 (≈45× lebih besar).** Untuk nominal kecil,
  biaya mainnet jadi porsi besar (≈6,3% dari $12,47). Sisi Robinhood sendiri murah (~0,08 gwei).
- Alat ukur siap: `npm run rh:fills` (token keluar/masuk, blok, harga efektif + pembanding harga pool V3
  di blok yang sama → fee+slippage nyata) · `npm run rh:trench -- <alamat>` (sinyal kualitas trenches).

## UJI LIVE PERTAMA (2026-10-13/16) — angka nyata, terukur dari rantai

- Beli instan di jaringan Robinhood: **0,002 ETH → 15.802,271386 XZON** (tx `0x7c3928cc09c501e4…`, blok 89474510).
- Harga efektif **1,2656408e-07 ETH/XZON** ($0,00030932). Harga mid pool (V3, blok sama): **1,2531e-07 ETH/XZON**
  → **biaya nyata = +1,00%**, yaitu **fee pool 1,00%** yang sebelumnya kita baca dari kontrak, dengan
  **slippage di luar fee = 0**. Estimasi "Auto 40%" di UI tidak terpakai.
- Gas nyata: **202.910 unit × 0,0218 gwei = 0,00000442 ETH (≈$0,0108)** — jauh di bawah estimasi apa pun.
- Order limit 0,002 ETH (buy_low, limit 0,00017672) berdiri; terlihat & terkelola lewat API (berat 1–5, gratis).
- Kesimpulan validitas: **model paper kita benar soal fee (1%)**; yang belum ia modelkan: gas nyata (kecil) dan
  slippage eksekusi (terukur 0 pada trade kecil ini).

## UJI LIVE — SISI KELUAR (blok 89477299, tx 0xaf3a30a6da37b991…)

- Jual **7.901,135693 XZON → 0,000957 ETH** ($2,3389); gas 0,00000421 ETH (≈$0,0103).
- Harga jual efektif **1,2112220e-07 ETH/XZON**; mid pool blok sama **1,2248092e-07 WETH/XZON**
  → **biaya keluar 1,12%** (fee 1,00% + slippage 0,12%).
- **TOTAL BIAYA PUTARAN (masuk+keluar) ≈ 2,13%** — angka nyata pertama untuk model kita
  (sebelumnya hanya fee 1% diasumsikan per sisi, kini terukur), gas putaran ≈$0,021.
- Catatan jujur: harga mid bergerak 1,2529699e-07 → 1,2248092e-07 (−2,25%) selama jeda,
  jadi separuh yang dijual terealisasi ≈−4,3% vs harga belinya — itu **gerak pasar, bukan biaya**.

## TEMUAN ROUTER (2026-10-18) — Universal Router, bukan ABI misterius

Dipindai 250 blok (91992964–91993213): **6 transaksi ke router `0xaf9d6fa019328d8cf8598d0d5be22cc6622b09f1`,
semuanya memakai selector `0x3593564c`** = `execute(bytes commands, bytes[] inputs, uint256 deadline)`
milik **Uniswap Universal Router** (ABI publik). Bedah calldata contoh (16 kata):
  deadline (0x6ad51430) · commands length 1 (byte 0x00 = V3_SWAP_EXACT_IN) · inputs: 1 struct 224 byte
  (recipient, amountIn, amountOutMin, path, payerIsUser).
Implikasi: jalur "router sendiri" TIDAK butuh dekode ABI non-standar — cukup pakai ABI Universal Router
publik + path V3 dengan fee 10000 (1,00% — sudah terverifikasi di kontrak pool). Catatan: Universal Router
versi baru memakai Permit2 untuk transfer ERC-20; itu bagian yang harus diuji (approve langsung vs permit).
Sample calldata tersimpan di docs/onchain/router-calls-sample.json (6 tx) untuk pass berikutnya.

## JALUR POOL LANGSUNG — TERBUKTI DI RANTAI (2026-10-18)

Kontrak: **0xb7c640835f6250e06990cc6d9b14d3ca8554a005** (deploy tx 0xf03c0fae…, gas $0,0220)
Sumber: contracts/RhSwapHelper.sol · artefak: contracts/RhSwapHelper.json (solc 0.8.37)
Swap pertama: **1.000 gilet → 0,00000404 WETH** (tx 0x3fb3fe31…, gas $0,0064) — persis harga pool.

Tiga fakta teknis yang WAJIB diingat saat menyambung jembatan live:
1. **Fee pool RH = 100 (0,01%)** — bukan 10000. `fee()` V3 menyatakan seperseratus basis poin.
2. **Arah `sqrtPriceLimitX96`**: `zeroForOne=false` (harga NAIK, mis. jual token1) → limit harus
   **DI ATAS** harga sekarang; `zeroForOne=true` → limit **DI BAWAH**. Salah sisi = galat "SPL".
3. **Helper butuh izin**: token input harus di-approve ke helper (sekali per token). Untuk beli,
   ETH harus di-wrap dulu → WETH → approve → helper.swapExactIn.
4. Router `0xaf9d…` (Universal Router) **ber-whitelist** — "Invalid token" untuk gilet; jadi jalur pool
   langsung yang dipakai untuk semesta luas, bukan router.

Sisa penyambungan jembatan: di live-executor.ts ganti panggilan OKX → pool-swap helper (wrap→approve→
swapExactIn), plus pencarian pool (GMGN `biggest_pool_address` → baca token0/token1/fee di rantai).
