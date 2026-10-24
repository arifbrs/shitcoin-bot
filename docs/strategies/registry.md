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
  di segelintir token (konsentrasi). **Matematika break-even (round-5, teruji analitik)**: threshold
  dievaluasi pada netPct (SUDAH memuat gas + fee quote — dibuktikan stop-exits real mengelompok di
  −1,5..−1,7); drag inkremental = overlay latensi 1,0 pp → BE=(SL+d)/(TP+SL): **A 71,4% · B 50,0% ·
  C 42,9%**; d=2,6 pp (ganda-hitung) = MUSTAHIL untuk A/B. Gas = wei ABSOLUT (1,14% hanya di
  0,001 ETH; skala 1/ukuran).
- **Status**: TESTING (kohort mulai 2026-10-22; sejak 2026-10-24 setiap OPEN/CLOSE membawa
  `simFillEntry`/`simFillExit` fillmodel-v1 + setiap kandidat layak yang ditolak tercatat REJECT).
- **Anti-kebocoran**: keputusan hanya dari quote saat keputusan; likuiditas DexScreener dibaca saat
  entry dan disimpan; tak ada data masa depan.

### Batas kohort & versi (round-4 #6) — WAJIB dipisah saat analisis
- **Kohort keputusan** (`rhpaper-units-arm-v3`): TIDAK berubah sejak 2026-10-22 — `shouldExit`,
  `quotePnl`, ambang TP/stop, dan urutan siklus identik (bukti: diff commit round-3/4 hanya
  menambah baris ledger, kolom `liquidityUsd`, dan REJECT; TIDAK menyentuh logika keputusan).
- **Overlay akuntansi** (`rhpaper-fillmodel-v1`, operasional 2026-10-24): baris ledger yang membawa
  `fillModelVersion` = kohort overlay; baris tanpa itu = kohort QUOTE-ONLY. `npm run rh:cohort-stats`
  melaporkan keduanya TERPISAH dan tidak pernah menggabungkan. Mark harga/quote lama TIDAK pernah
  diberi label ulang menjadi fill; overlay hanya di baris baru sejak versinya aktif.
- Implikasi: perbandingan lintas-batas hanya boleh pada METRIK KEPUTUSAN (netPct quote), bukan
  metrik overlay; metrik overlay dibandingkan hanya dalam kohortnya sendiri.

## 2. Pengikut sinyal GMGN (tipe 12 smart-money, tipe 20 KOL) — SOL & ROBINHOOD
- **Hipotesis**: sinyal GMGN dapat dieksekusi tepat waktu dan memberi return positif pada horizon
  tetap 15m/60m/360m/1440m.
- **Temuan terukur (B2, direvisi round-4, n kecil)**: delay total median 566–782 menit, dan
  DEKOMPOSISI menunjukkan hampir SEMUA delay adalah USIA-SAAT-REQUEST (med ≈761 m; antrean lokal
  med 0,5 s) — keterlambatan ada di sisi provider/daftar-bergerak-lambat, bukan polling lokal
  (siklus kita 15 m). Artinya: pipa KITA tak bisa bertindak tepat waktu untuk 96% sinyal; apakah
  GMGN menerbitkan kejadian tua atau memakai semantik trigger berbeda = UNKNOWN (perlu sampel mentah
  untuk dipastikan). Return 1440m median −43%…−60%, CI95 mean [−64, −37] (tipe-12 sol, n=23) —
  CI TIDAK melewati nol, tetapi 2 UTC-hari & token berkorelasi = belum inferensi final.
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

## 6. REGISTRI HIPOTESIS EDGE (round-7 P5) — masing-masing falsifiable, status empiris eksplisit

| # | Mekanisme teramati | Data & timestamp | Coverage kini | Keputusan masuk/keluar | Status bukti |
|---|---|---|---|---|---|
| H-A | Sinyal GMGN SEGAR (usia ≤15m) mengikuti pergerakan lanjutan yang bisa dieksekusi | journal: observedAt/triggerAt + mark 15m/60m | n=12 (≤5m) + 15 (5–15m) — 2 UTC-hari | entry @ mark0 ≤5m toleransi; exit horizon tetap 15m/60m | **INSUFFICIENT** (C5; 15m med −6,0% vs +3,9% antar-bucket, CI melewati nol) |
| H-B | Likuiditas pool menentukan kapasitas keluar (2% rule fillmodel) | scanner candidates: liquidityUsd (DexScreener, saat scan) | 24/29 kandidat 10-24 punya likuiditas; p10 $3,1k · p50 $102,7k | notional $2,5 → lolos 2% rule di likuiditas ≥ ~$118 | **TERUKUR, netral**: semua kandidat berkeliuditas lolos di ukuran ini; penghalang nyata = likuiditas TIDAK TERCATAT (model menolak fail-closed) |
| H-C | Skor wallet SEBELUM trade memprediksi outcome | walletQuality.scoredAt ≤ tradeAt (anti-leak) | 303/330 trade lolos syarat waktu; outcome join <30 | — | **INSUFFICIENT** (C4) |
| H-D | Akselerasi transaksi & buy/sell imbalance memprediksi lanjutan | belum dikumpulkan (butuh feed trade per token) | 0 | — | **PENDING DATA** |
| H-E | Filter risiko pra-entry (top10-holder, honeypot, tax) mengurangi hasil buruk | GMGN security (ada di enrich lane) | kandidat RH belum diperkaya security | gate sebelum entry | **PENDING DATA** |

Aturan: label "smart money"/winrate wallet TIDAK dipakai sebagai bukti (klasifikasi pihak ketiga /
bocor masa depan); tidak ada optimasi parameter retrospektif; hipotesis hanya naik status setelah
n & coverage memenuhi ambang yang ditetapkan SEBELUM pengukuran.
