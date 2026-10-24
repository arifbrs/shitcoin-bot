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

## AUDIT FORENSIK PHASE-0 (2026-10-24, sesi MASTER DIRECTIVE — bukti kunci, bukan klaim)

**Gerbang lulus**: `npm run typecheck` ✓ · `npm test` ✓ (124 kasus / 21 berkas) · `npm run gate`
✓ penuh (termasuk okx/selftest/watchdog) — exit 0.

**BUG P1 ditemukan & DIPERBAKI** — `src/robinhood/live-executor.ts` jalur JUAL: calldata
`balanceOf` memakai `token` sebagai pemilik (mestinya `BOTW`) sejak commit `7a14c75` (2026-10-21)
→ qty terbaca 0 → `LIVE_SELL ok:false` TANPA pernah mencoba. Akibat: jual otomatis mustahil;
posisi live hanya bisa keluar lewat kebetulan. Diperbaiki (pemilik = `BOTW`, dua pembacaan).

**CRASH P1 ditemukan & DIPERBAKI** — `rh:live` mana pun (termasuk `--exits-only`) crash ENOENT
membaca `logs/rh-paper-state.json` yang sudah diarsipkan (regresi migrasi engine 1:1, `1e56f87`).
Dibuktikan dengan dry-run yang gagal; kini di-guard (state lama opsional).

**GERBANG IZIN ditambah** — pembelian otomatis `rh:live --yes` kini butuh `LIVE_TRADING_CONFIRMED=yes`
di `.env` (kunci yang sama dengan sisi Solana, `control.ts`). Jualan tetap jalan. Saat ini .env = `no`
→ bridge TAHAN beli; satu baris `LIVE_PERM_BLOCK` ditulis ke ledger live. Operator mengizinkan lewat
.env, bukan lewat kode.

**Lane mati terdeteksi & dinyalakan ulang** — GMGN lane mati ±18 jam, rhpaper mati ±30 jam
(kesehatan bilang "RUNNING" tapi pid-nya tak ada — health hanya berhenti diperbarui).
Kini: `run-gmgn-supervised.sh` + `run-rhpaper-supervised.sh` hidup; health 0–1 menit;
`logs/rhpaper/ledger-2026-10-24.jsonl` menulis MARK lagi (posisi legacy tetap difreeze kebijakannya).

**Bukti live terkini (dari ledger, bukan ingatan)** — `logs/rh-live-2026-10-18..21.jsonl`:
2 `LIVE_BUY ok` ($2,5) · 1 `LIVE_SELL ok` · 289 `UNEXITABLE_BLOCK` (10-21) · **0 `LIVE_FILL`
saldo-terverifikasi**. Saldo dompet bot terukur saat audit: ≈$8,12 (ETH+WETH+USDG).

**Status jujur**: ENGINE FUNCTIONAL — PROFITABILITY NOT YET VALIDATED. Journal GMGN prospektif baru
257 baris / 66 sinyal (sejak 2026-10-23) — jauh di bawah gerbang riset (≥14 hari, ≥100 trade).
Kohort paper 1:1 memakai engine `rhpaper-units-arm-v3` dengan mark `QUOTE_ONLY_NOT_SIMULATED`.

**Sisa celah (urut prioritas)**: (1) `runSwap`/`amount`/`weiPerUsd` di live-executor = kode mati →
bersihkan; (2) rencana BELI live memuat token ganda per-arm (dedupe per token belum ada); (3)
kontinuitas lintas-hari: `rh:live` hanya membaca ledger live HARI INI → posisi live semalam tak
terlihat paginya (aturan yatim tak bekerja lintas hari); (4) `pool-swap.ts` belum dipakai live-executor
(padahal PLAN 2026-10-18 menetapkannya); (5) hunter hanya punya data 2026-10-22 (kolektor belum
dijadwalkan berkala); (6) audit besar (server.ts 3,4rb baris, trader.ts 2,8rb baris, lane OKX) belum
dibedah baris-per-baris pada sesi ini.

## TANGGAPAN AUDIT INDEPENDEN (2026-10-24, sesi kedua) — P0–P6 ditutup dengan bukti

**Tes**: 133 kasus (124 lama + 9 regresi baru) ✓ · typecheck ✓ · `npm run gate` ✓ penuh.

**Modul baru `src/robinhood/live-positions.ts` (+ `live-positions.test.ts`, 9 kasus)** — calldata
`balanceOf` murni (pemilik = DOMPET, pad 24 nol terverifikasi — tes MENANGKAP versi pertama saya
yang lupa pad), pembaca saldo yang membedakan nol vs gagal-RPC, pemuat state-paper lama fail-open
ke kosong (bukan ENOENT crash), rekonstruksi posisi lintas-hari dari SEMUA `rh-live-*.jsonl`
(positionId deterministik dari bukti entry), rekonsiliasi OPEN/CLOSED/GHOST/UNKNOWN + untracked,
perencana aksi (dedupe per token, anti-loop 287-blok, UNKNOWN/GHOST/untracked TIDAK PERNAH dijual),
`wethForUsd` (nominal dari harga terukur; harga gagal = tolak).
**live-executor.ts ditulis ulang** memakai modul itu: kode mati (`runSwap`, `send` lokal, `weiPerUsd`,
`amount`) dihapus; nominal beli dari `wethForUsd` (bukan konstanta 0,001 ETH); txHash+positionId
dicatat di LIVE_FILL/LIVE_SELL; baris RECONCILE tiap run eksekusi.

**Bukti P3 (rantai, dibaca ulang hari ini)**: beli gilet $25 = tx `0xd0422f6f…d78bc21` status `0x1`
blok 91986560 dari dompet bot ✓ · jual "ok" 2026-10-19 ternyata PARSIAL — saldo gilet saat ini
2.623.563.836.639.428.744.132.977 raw masih di dompet → **konflik ledger-vs-rantai NYATA**, kini
terdeteksi otomatis (status OPEN lagi, direncanakan jual sisa) · HOOT saldo 0 = GHOST asli (baris
VOID 10-21 mendukung) · 12 LIVE_BUY gagal + 1 LIVE_ATTEMPT (Kimchi/microduck) menjelaskan 0 LIVE_FILL:
skema LIVE_FILL baru lahir 10-21 dan semua percobaan setelahnya gagal/tak pernah terisi.

**Hasil audit 3 subagen (server / trader-Solana / OKX+supervisi) + perbaikan yang diambil**:
- `/api/live` & `/api/paper` tanpa auth (satu-satunya /api begitu) → **diberi isAuthed**, dashboard
  direstart, diverifikasi: tanpa sesi 401, dengan sesi 200.
- `control.json` non-atomik + fail-open saat korup (bisa un-pause & re-arm live diam-diam) →
  **tulis atomik + fail-closed** (korup = paused+dry-run, sejalan guardian.json).
- `run-live-exits-supervised.sh` header bohong ("HANYA KELUAR" padahal mode penuh) + tanpa lock →
  **header jujur + lock duplikasi** (mode penuh tetap sesuai permintaan operator 10-19; BELI tetap
  tertahan LIVE_TRADING_CONFIRMED=no).
- `lane-guard` menunjuk skrip OKX yang sudah pindah ke legacy/ (pkill tiap 120 detik) → **dikomentari**.
- `bot.sh` status selalu merah (PROCS berisi lane OKX yang tak pernah dinyalakan) → **entri dilepas**.
- `S2_LIVE_ENABLED` default fail-open → **default fail-closed** (mesin ini eksplisit "true", tak berubah).
- `assertNotLive` kode mati dengan pesan keamanan PALSU → **dihapus dengan catatan**.
- Kunci .env duplikat = nilai TERAKHIR menang tanpa suara (MAX_DAILY_SPEND_SOL 0.10 → 9999,
  keputusan operator 2026-08-22 dihormati) → **peringatan startup** kunci duplikat (terverifikasi muncul).

**P6**: `run-hunter-supervised.sh` baru (kolektor hunter dua chain tiap jam, lock, sedang jalan) ·
`tools/lane-status.mjs` baru — bukti HIDUP dari pid+usia heartbeat (bukan label "RUNNING");
SEMUA LANE OK exit 0 · laporan fitur dari data tersimpan: 1.505 wallet terskor, 104 sinyal 24 jam,
Δ harga 15m/60m terhitung (type 12: med 0.00% / −3.01%) — deskriptif, bukan klaim prediktif.

**MASIH TERBUKA (butuh keputusan operator)**: (1) `/api/wallet/withdraw` = jalur drain satu-cookie
tanpa allowlist/cap — by-design "uangku kembali", direkomendasikan allowlist `WITHDRAW_ALLOWLIST`
env + cap; DIUBAH tanpa izin = pelanggaran aturan "fund-moving changes butuh otorisasi eksplisit";
(2) race penulis control.json lintas-proses (atomik ✓, lock belum); (3) S2: exit terkunci saat
disarm + `s2MirrorFlatten` tanpa pemanggil (lane mati; perlu desain ulang sebelum hidup lagi);
(4) retensi log (logs/ 3,9 GB, okx-strict-paper-v2.jsonl 279 MB tanpa rotasi); (5) pool-swap helper
belum disambung ke live-executor; (6) validator status tetap: PROFITABILITY NOT YET VALIDATED.

## ROUND-3 AUDIT (2026-10-24, sesi ketiga) — Track A + Track B

**Tes**: 151 kasus / 25 berkas ✓ · typecheck ✓ · `npm run gate` ✓ penuh.

**A1 withdraw (additive, default OFF)**: `src/execution/withdraw-gate.ts` — validasi tujuan/jumlah
(NaN kini ditolak eksplisit, temuan F9), origin mismatch (CSRF) ditolak, `WITHDRAW_ALLOWLIST` +
`WITHDRAW_MAX_SOL` opsional; SETIAP percobaan (ditolak/terkirim/gagal) diaudit ke events. Env tidak
diisi = perilaku lama utuh. 6 tes.

**A2 konfigurasi**: `src/util/env-audit.ts` (murni, teruji) — duplikat kunci keamanan .env kini
(1) berwarna peringatan startup, (2) `config.securityDupKeys`, (3) MENOLAK arming live di
control.ts dan mode full live-executor sampai operator membereskan .env. Nilai cap operator TIDAK
diubah (9999 tetap nilai efektif — keputusan operator 2026-08-22 dihormati; implikasi finansial:
breaker harian MATI; dipaparkan di laporan).

**A3 mode eksekusi**: `rh:live --mode exit-only|full` (default exit-only, nilai asing ditolak).
EXIT_ONLY = rencana beli STRUKTURAL tidak dibangun di dalam `planActions()` — tak bisa dibolongi
env/izin/tunai. Supervisor live-exits kini mengirim `--mode exit-only`. Tes: exit-only = 0 beli
walau sinyal segar + izin; full = rencana muncul; banana = TOLAK.

**A4 rekonsiliasi kanonik**: `npm run rh:reconcile` → `logs/rh-reconciliation-<tanggal>.md/.json`
+ history jsonl. Hasil terukur (tx `0xd0422f6f…d78bc21`, receipt 0x1 blok 91986560):
WETH keluar 10.588.733.587.462.950 raw (= 0,01058873 ETH ≈ **$25** — klaim $25 BENAR; angka $2,5
adalah HOOT 10-20), gilet masuk 2.624.563.836.639.428.744.132.977 raw; saldo kini
2.623.563.836.639.428.744.132.977 → jual 10-19 terbukti PARSIAL tepat 1.000.000 gilet (tanpa hash —
INFERRED; tidak ada riwayat transfer lain). HOOT: beli $2,5 INFERRED (tanpa hash), saldo 0 → fill
nol vs hilang = UNKNOWN, jujur dilabel. Tidak ada posisi dilabel CLOSED_CONFIRMED tanpa bukti.

**A5 tes tambahan (13 baru)**: crash-recovery (fill ganda = satu posisi, ID sama), exit parsial
(status OPEN dipertahankan, bukan CLOSED), ledger terpotong (malformed dihitung), EXIT_ONLY,
UNKNOWN/GHOST tak tersentuh, alamat tidak sah diabaikan; control.json korup = fail-closed
(`CONTROL_DIR` untuk pengujian), tulis atomik.

**A6 operasi**: tracker GMGN menulis `tracker-log.jsonl` per poll (akuntansi interval hilang tahan
lama); `tools/archive-logs.mjs` (kompres, JANGAN hapus) — 203 berkas → 943 MB hemat (3,9 GB → 3,0 GB),
bukti utuh di `logs/archive/` (68 MB .gz); `npm run logs:archive`. Lane-status: SEMUA OK dengan pid hidup.

**B2 studi sinyal** (`npm run gmgn:signal-study` → logs/gmgn-signal-study-<tanggal>.md): reproduksi +
kontrol. Temuan utama: feed telat (delay median 566–782 menit; ≤5m hanya 4–21%) → mayoritas sinyal
TIDAK BISA dieksekusi riil; return 1440m median −43%…−60%; C1 dedupe-token membuat makin negatif;
C4 join wallet point-in-time: 303/330 trade lolos syarat waktu (27 dibuang anti-leak), outcome
belum cukup sampel → INSUFFICIENT. Hasil negatif TIDAK dioptimalkan; n kecil dinyatakan.

**B3 model fill** (`src/rhpaper/fillmodel.ts` v1, teruji): likuiditas/harga tak diketahui → TIDAK
ADA fill; pangsa likuiditas >2% → tolak; dampak ≥5% → tolak; slippage latensi 0,5% (asumsi berlabel).
Engine paper membaca likuiditas DexScreener saat scan (1 panggilan batch) dan mencatat
`simFillEntry`/`simFillExit` + `fillModelVersion` di ledger — ADDITIVE: keputusan TP/stop tak diubah.

**B4/B5**: `docs/strategies/registry.md` — 5 strategi + baseline pembanding, versi dibekukan,
kriteria falsifikasi eksplisit. Engine kini menulis baris REJECT untuk tiap kandidat layak yang
ditolak (dasar evaluasi tanpa pilih-kasar). Supervisor paper = runner forward-test nol-modal yang
terbukti hidup lintas sesi (ledger 10-22→10-24 berlanjut tanpa sesi AI).

## ROUND-4 AUDIT (2026-10-24, sesi keempat) — KOREKSI MATEMATIKA (commit 9fac9bc)

**Tiga kesalahan laporan saya diakui & dikoreksi dari sumber** (bukan dari ingatan):
1. WETH keluar = `105887335874462950` (laporan) SALAH KETIK; data kanonik & rantai = `10588733587462950`
   raw = 0,01058873358746295 WETH ≈ $25 (dibaca ulang dari receipt + transfer decode).
2. decimals gilet = **18 (dibaca dari kontrak)** → selisih saldo 10^21 raw = **1.000 gilet**,
   bukan 1.000.000. Konversi kini menunggu decimals() per token; tanpa itu konversi DITAHAN.
3. Jual 10-19 = **FALSE_POSITIVE**: riwayat eth_getLogs menunjukkan satu-satunya keluar non-nol
   adalah 1.000 gilet pada 2026-10-18T20:01:01Z (tx 0x3fb3fe31…bf4971b — uji kontrak helper, bukan
   jualan). Akar: verifikasi pool-swap hanya menolak 0→0 → **diperbaiki: wajib delta saldo keluar**.

**Invariant klasifikasi**: 311 = VERIFIED 1 + INFERRED 308 + UNKNOWN 0 + FALSE_POSITIVE 1 + ADMIN 1 ✓
(311 baris; 1 ADMIN = baris tanpa alamat token). INVARIANT saldo-vs-riwayat gilet: COCOK ✓.

**Security jujur**: dengan tanpa konfigurasi, sesi dashboard sah MASIH BISA menarik ke mana pun
(mode legacy dipertahankan sampai operator menyetujui perubahan jalur dana). Default-deny siap &
teruji: `WITHDRAW_MODE=deny|policy|legacy` + `WITHDRAW_DAILY_MAX_SOL`; rollback = hapus env.

**Arsip**: rh-live-*.jsonl dilindungi; manifest sha256; verifikasi dekompresi sebelum unlink;
tes arsip→restart→rekonstruksi LULUS (posisi terbuka tetap punya sumber).

**Sinyal**: dekomposisi delay = usia-saat-request med 761 m vs antrean lokal 0,5 s → telat di sisi
provider (truncation/semantik trigger = UNKNOWN). Return 1440m tipe-12 sol: med −60,3%, CI95 mean
[−63,98, −36,70] — CI di luar nol pada n=23 (2 hari, korelasi token → belum inferensi final).

**Kohort**: keputusan engine v3 TIDAK berubah sejak 10-22 (diff = ledger enrichment saja); overlay
fillmodel-v1 = baris baru sejak 10-24; keduanya dilaporkan TERPISAH oleh `rh:cohort-stats`
(PF, break-even winrate, CI bootstrap per arm × kohort).

157 tes / 26 berkas ✓ · typecheck ✓ · gate ✓ · lane SEMUA OK.

## ROUND-5 AUDIT (2026-10-24, sesi kelima) — MATEMATIKA BREAK-EVEN & KEBENARAN FILL (commit b952cc2)

**Koreksi kontradiksi break-even (laporan saya sebelumnya salah):** angka "drag 2,6% → BE 72%"
TIDAK konsisten — 72% hanya mengikuti d=1,02 pp. Investigasi implementasi membuktikan:
- TP/stop dievaluasi pada netPct yang SUDAH memuat gas + fee/dampak DUA kaki quote (bukti data:
  stop-exits arm A n=8 netPct −1,51..−1,74 mengelompok di threshold −1,5; bukan −2,64/−4,1).
- Rumus benar: **BE=(SL+d)/(TP+SL)** dengan d = drag INKREMENTAL di luar dasar threshold =
  overlay latensi fillmodel 1,0 pp → **A 71,4% · B 50,0% · C 42,9%**; d=2,6 (ganda-hitung) →
  MUSTAHIL untuk A/B (dilabel null + TIDAK LAYAK, bukan "117%").
- Gas = wei ABSOLUT: 1,14% hanya pada 0,001 ETH; skala 1/ukuran (0,01 ETH → 0,114%).
- Latensi 0,5% diterapkan SEKALI per kaki; tidak ada komponen yang dihitung dua kali
  (breakeven.test.ts: 8 kasus analitik termasuk kasus mustahil).

**Kebenaran fill per-transaksi**: tx-truth.ts — fill = receipt sukses + Transfer token-out KE dompet
pada tx ITU. Tes adversarial: sukses-0/0, output ke dompet lain, token-lain (saldo naik tapi bukan
fill), receipt gagal, multi-hop, duel saldo-vs-tx. live-executor kini mewajibkan fillProof + delta
saldo (keduanya) sebelum LIVE_FILL/LIVE_SELL ok:true.

**Withdraw**: status TETAP RISIKO TERBUKA (legacy = sesi sah bisa tarik ke mana pun) —
docs/withdrawal-decision-pack.md; deny/policy siap & teruji, aktif hanya dengan keputusan operator.

**Kohort v2**: 1.253 CLOSE → 6 trade unik arm-A PROSPECTIVE quote-only (sisanya LEGACY), Σnet
arm-A PROSPECTIVE quote-only −9,80% (8 → dikoreksi hitung unik), MDD/ekspektasi CI95/biaya gas
14,28e15 wei/modal $3.202,50/REJECT 291 — JSON machine-readable. TIDAK ADA verdict strategi (n kecil).

**Sinyal**: usia p10/p50/p90 = 9,6m/752m/1047m; 10/56 sinyal ≤15m → segmen segar ADA; klaim
"tidak bisa dieksekusi" dibatasi ke mayoritas (bukan seluruh feed). ft:progress: gerbang 14h/100t
12,4%/0-12% per arm; downtime 29,86 jam (7 hari) tercatat eksplisit.

171 tes / 28 berkas ✓ · typecheck ✓ · gate ✓ · lane SEMUA OK. PROFITABILITY NOT YET VALIDATED.

## ROUND-6 AUDIT (2026-10-24, sesi keenam) — INTEGRITAS KUANTITATIF (commit c356979)

**Koreksi ketiga (laporan, bukan kode)**: tabel BE round-5 saya salah 3 sel — fungsi produksi
benar sejak awal. `benchmarkTable()` kini SATU-SATUNYA sumber angka (tes mengunci: 71,428571 /
INFEASIBLE / 53,500000 / 90,000000 / 44,857143 / 65,714286 = persis ekspektasi auditor);
laporan menyalin keluaran verbatim, dilarang mengetik tangan.

**TEMUAN MATERIAL BARU (dari rh:ledger-audit)**: ledger punya DUA BASIS akuntansi —
- v0 (1.207 baris, ≤10-23, tanpa measurementVersion): netPct == grossPct PERSIS → gas TIDAK pernah
  dipotong. Klaim round-5 "threshold sudah memuat gas" HANYA sah untuk v3; untuk v0 BE=(SL+d+gas)/(TP+SL).
- v3 (48 baris, 10-24+): netPct = gross − gas(11,4e12) via quotePnl bigint.
Rekonsiliasi: 1.253 baris → 0 mismatch terhadap basis versinya masing-masing ✓. cohort-stats kini
memilah per versi dan TIDAK PERNAH mencampur; overlay latensi = satu definisi (fillmodel.
latencyOverlayPct = 0,9975 pp eksak, bukan aproksimasi 1,0); baris v3 pakai jalur fillOutRaw model.

**tx-truth diperluas + 4 tes adversarial baru**: native-out (butuh bukti saldo — dilabel), fee-on-
transfer (log = batas atas; partial <98% ekspektasi ditandai), log rusak dilewati-terhitung,
multi-hop dijumlahkan, determinisme lintas-path.

**Kejujuran forward-test**: coverage 7 hari = 28,78% (satu gap 29,86 jam 10-23→10-24); 88 observasi
sinyal hilang dalam gap — 14 hari kalender BUKAN forward-test 14 hari (dicatat di ft:progress).

**Sinyal segar vs basa (C5)**: ≤5m n=12 (15m: med −6,04%) · 5–15m n=15 (med +3,88%) · >60m n=79 —
DESKRIPTIF; tidak ada klaim profit/worthless dari n sekecil ini.

**Withdraw**: antrean seri (race audit plafon ditutup); pemisahan izin dashboard-vs-CLI didokumen-
kan; status TETAP legacy = RISIKO TERBUKA menunggu keputusan operator (paket keputusan siap).

178 tes / 28 berkas ✓ · typecheck ✓ · gate ✓ · lane SEMUA OK. PROFITABILITY NOT YET VALIDATED.

## ROUND-7 AUDIT (2026-10-24, sesi ketujuh) — COVERAGE JUJUR & ALJABAR LATENSI (commit 3723e30)

**Koreksi coverage (denominator round-6 salah)**: 28,78% adalah rasio atas SPAN ledger (42,35 jam),
bukan 168 jam. Rekonsiliasi eksak 7 hari: aktif 12,48 + OUTAGE 29,86 (10-23T04:28→10-24T10:20) +
BEFORE_COHORT 125,65 (sebelum kohort 10-22T19:47) = 168,0 jam ✓. Dua angka dilabel:
availabilityPctTrailing7d = **7,43%** (168j penuh) · availabilityPctCohortSpan = **29,48%**.
GMGN tracker: 1,34% (log baru ada sejak restart 10-24). 88 observasi sinyal hilang di OUTAGE.
→ Klaim "forward-test 14 hari" dilarang sampai coverage nyata.

**Aljabar latensi dikunci**: dua kaki masing-masing ×(1−l) sekali → putaran (1−l)² = overlay eksak
0,9975 pp (fillmodel.latencyOverlayPct, satu definisi). Jalur fillOutRaw-tunggal round-6 = undercount
(~0,5 pp terlalu optimis) — dibetulkan. Kesamaan lintas-modul dites (overlay ≡ komposit).

**Pilahan akuntansi saling-lepas**: v0=1207 · v3-quote=44 · v3-fillmodel=4 → 1255 = total ✓
(fillmodel NESTED di dalam v3). Baris v0: PnL asli = gross; normalisasi biaya = HIPOTETIS.

**Sim state classification (temuan jujur)**: kohort fillmodel-v1 kini = 3 CLOSE dengan **0 sim
trade layak** — entry likuiditas tak tercatat → model menolak fail-closed (simNoEntry/simUnexitable
dilaporkan terpisah, bukan dijadikan rugi sim). Kapasitas keluar (H-B): 24/29 kandidat punya
likuiditas (p10 $3,1k · p50 $102,7k) — semua lolos 2% rule di notional $2,5.

**ft:daily**: rekaman harian machine-readable (coverage flags, eligible/accepted/rejected, PF/MDD,
sensitivitas BE, versi strategi, kualitas data) — semuanya dari fungsi produksi.

**Hipotesis edge (registri H-A..H-E)**: H-A INSUFFICIENT (n segar 27) · H-B terukur netral ·
H-C INSUFFICIENT · H-D/E PENDING DATA. TIDAK ADA klaim edge; hasil negatif dipertahankan.

180 tes / 28 berkas ✓ · typecheck ✓ · gate ✓ · ledger-audit exit 0 · lane SEMUA OK.
PROFITABILITY NOT YET VALIDATED.
