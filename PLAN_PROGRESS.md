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
