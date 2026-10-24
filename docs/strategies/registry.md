# REGISTRY STRATEGI & KOHORT (dibekukan sebelum pengukuran prospektif)

Aturan mutlak: ganti logika = VERSI BARU + kohort baru (sampel lama tidak pernah dilanjutkan).
Setiap entri: hipotesis, kondisi masuk/keluar, cara dipalsukan (falsification), status bukti.
Status yang sah: HYPOTHESIS / TESTING / INSUFFICIENT / REJECTED — TIDAK ADA "PROFITABLE" tanpa
bukti prospektif (≥14 hari, ≥100 trade selesai, CI tidak melewati nol).

## 1. Paper RH 1:1 — arm A/B/C (`rhpaper-units-arm-v3`)
- **Hipotesis**: token RH yang lolos gerbang dua-arah (quote beli+jual) memberi hasil net positif
  dengan exit terkalibrasi pada skala gerakan nyata.
- **Masuk**: kandidat scanner (quote beli+jual lolos, dampak <5%). Ukuran: 0,001 WETH.
- **Keluar (dibekukan 2026-10-22)**: A stop −1,5% / TP +2,0% / umur 240m · B −1,0 / +3,0 / 240m ·
  C −2,0 / +5,0 / 240m. Gas riil riwayat 1,14% putaran (asumsi, berlabel `historical-assumption`).
- **Falsifikasi**: net profit factor < 1 setelah ≥100 trade PROSPECTIVE per arm, atau rugi terpusat
  di segelintir token (konsentrasi).
- **Status**: TESTING (kohort mulai 2026-10-22; sejak 2026-10-24 setiap OPEN/CLOSE membawa
  `simFillEntry`/`simFillExit` fillmodel-v1 + setiap kandidat layak yang ditolak tercatat REJECT).
- **Anti-kebocoran**: keputusan hanya dari quote saat keputusan; likuiditas DexScreener dibaca saat
  entry dan disimpan; tak ada data masa depan.

## 2. Pengikut sinyal GMGN (tipe 12 smart-money, tipe 20 KOL) — SOL & ROBINHOOD
- **Hipotesis**: sinyal GMGN dapat dieksekusi tepat waktu dan memberi return positif pada horizon
  tetap 15m/60m/360m/1440m.
- **Temuan terukur (B2, 2026-10-24, n kecil)**: feed telat — delay observasi median 566–782 menit;
  hanya 4% (tipe-12 sol) sampai 21% (tipe-20 sol) sinyal tiba ≤5 menit. Return 1440m median
  −43%…−60%. Return 60m tipe-12 berubah tanda antar snapshot (−3,01% → +14,43% mean) — belum stabil.
- **Falsifikasi**: bila setelah ≥30 hari jendela data, return med semua horizon ≤0 dengan CI
  tidak melewati nol → REJECTED (sinyal telat = tak bisa dieksekusi; bukan strategi).
- **Status**: INSUFFICIENT (n=104 sinyal / 2 UTC-hari). Tidak ada eksekusi; journal harga saja.

## 3. Join wallet×outcome point-in-time
- **Hipotesis**: wallet dengan winrate tinggi SEBELUM trade memberi outcome lebih baik.
- **Metode**: hanya skor dengan `scoredAt ≤ tradeAt` (terukur B2: 303 dari 330 trade lolos syarat
  waktu; 27 dibuang anti-leak). Join ke outcome belum cukup sampel → INSUFFICIENT.
- **Larangan**: skor wallet terkini TIDAK BOLEH dipakai untuk menilai trade lampau (bocor masa depan).

## 4. Lowcap Hunter (tier S/A/B/C, filter ROI>300% & winrate>60% 30-hari)
- **Hipotesis**: token lowcap dengan ≥1 trader top ber-ROI tinggi lanjut naik dalam 7 hari.
- **Status**: HYPOTHESIS — kolektor berjalan per jam sejak 2026-10-24; belum ada kohort outcome.
- **Catatan jujur**: label "smart" adalah KLASIFIKASI PIHAK KETIGA, bukan perilaku terukur mandiri;
  winrate/ROI diverifikasi dari `portfolio stats` GMGN (window 30d), bukan dari label.

## 5. Lane OKX strict-paper (v6 scalp) — SOL
- **Status**: DIHENTIKAN sementara (bukan gagal terbukti) — bukan bagian gerbang 14-hari saat ini.
- **Batas jujur**: entry-overhead terukur 20–28% pada nominal kecil; lihat PLAN_PROGRESS 2026-08.

## Baseline pembanding (wajib untuk setiap eksperimen)
- B1 "beli semua kandidat yang lolos gerbang dua-arah, keluar umur 240m" (tanpa TP/stop).
- B2 "acak dari kandidat lolos" (seed tetap, prinsip A/B mc-band yang sudah ada).
- Setiap fitur baru diuji sebagai Δ vs baseline pada kohort yang sama, bukan sebagai angka berdiri sendiri.
