# PAKET KEPUTUSAN OPERATOR — PENARIKAN SOL (withdraw) · 2026-10-24

Status keputusan: **MENUNGGU KEPUTUSAN OPERATOR**. Tidak ada perilaku dana yang diubah tanpa
persetujuan eksplisit. Selama menunggu, status keamanan withdraw = **RISIKO TERBUKA** — bukan PASS.

## 1. Perilaku yang TERDEPLOY hari ini (fakta, bukan rencana)
- Endpoint: `POST /api/wallet/withdraw` (dashboard, `src/server.ts`) + CLI `npm run wallet withdraw`.
- Gerbang aktif: sesi dashboard (password → cookie 12 jam). **TIDAK ADA** gerbang lain:
  tanpa allowlist, tanpa plafon, tanpa re-auth, tanpa cek guardian/pause, tanpa `LIVE_TRADING_CONFIRMED`.
- Dengan `WITHDRAW_MODE` tidak diisi → mode **legacy**: sesi sah dapat menarik ke ALAMAT MANA PUN,
  jumlah berapa pun termasuk `amount:"all"` (sisa saldo − buffer fee).
- Proteksi yang ADA sejak round-3/4 (selalu aktif, bukan opsional): validasi alamat Solana,
  penolakan NaN/≤0/melebihi-saldo, penolakan Origin-mismatch bila browser mengirim Origin,
  audit trail `withdraw-audit` untuk SETIAP percobaan (diterima/ditolak/gagal) di `logs/events-*.jsonl`.

## 2. Risiko bila legacy dipertahankan
- Satu cookie (atau password di mesin yang sama) = penarikan penuh satu-langkah; tidak bisa dibatalkan.
- CSRF residual: peramban modern menghormati SameSite=Strict; klien usang/ekstensi = risiko sisa.
  Header Origin TIDAK dikirim oleh klien non-peramban → pemeriksaan origin dilewati untuk mereka
  (desain: agar CLI operator tetap jalan) — berarti skrip di mesin yang sama tak dibatasi origin.
- Replay: tidak ada nonce; permintaan sama yang dikirim dua kali = dua penarikan (mitigasi tersedia:
  plafon harian di mode non-legacy).
- Blas-radius: saldo dompet saat audit ≈ 0,02 SOL — kecil, tetapi jalurnya tetap terbuka penuh.

## 3. Opsi A — `WITHDRAW_MODE=deny` (default-deny disarankan)
- Semua penarikan ditolak di server (`applyWithdrawMode`); exit 400 + baris audit.
- Menarik dana tetap mungkin lewat CLI operator (`npm run wallet withdraw`) — manusia di mesin,
  bukan peramban. Rollback: hapus env → kembali legacy.
- Risiko sisa: CLI tetap tanpa allowlist (diterima: keputusan per-invocation oleh operator).

## 4. Opsi B — `WITHDRAW_MODE=policy`
- WAJIB `WITHDRAW_ALLOWLIST` (daftar alamat; tanpa itu → fail-closed, semua ditolak).
- Opsional `WITHDRAW_MAX_SOL` (plafon per tx; `all` dibatasi plafon) dan
  `WITHDRAW_DAILY_MAX_SOL` (total SENT per hari UTC, dibaca dari baris audit — anti-replay praktis).
- Origin-mismatch tetap ditolak; Origin-absen diperbolehkan (CLI) — KONSEKUENSI dinyatakan.

## 5. Kontrol tujuan yang diwajibkan (mode policy)
- Alamat harus base58 sah 32–44 char; harus ada di allowlist (pembandingan persis string).
- Nilai env tak-sah (alamat rusak, plafon non-angka) → endpoint menolak dengan pesan, bukan diam.

## 6. Rencana pengujian & rollback
- Semua mode + cap teruji otomatis (`src/robinhood/round3b.test.ts`, `round4.test.ts`):
  deny memblokir keputusan-sah pun; policy tanpa allowlist fail-closed; cap harian menjumlah
  baris SENT; NaN ditolak; env rusak ditolak.
- Rollback: hapus `WITHDRAW_MODE` (+ opsional lain) dari `.env` dan restart dashboard —
  perilaku kembali persis legacy (terverifikasi oleh tes default).

## 7. Rekomendasi
Pilih **deny** sekarang (satu baris env), pindah ke **policy + allowlist + WITHDRAW_DAILY_MAX_SOL**
begitu alamat tujuan tepercaya ditetapkan. Keduanya butuh persetujuan Anda — jawab dengan satu kata:
"deny", "policy + <alamat>", atau "biarkan legacy (saya paham risikonya)".
