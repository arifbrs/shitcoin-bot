# CATATAN KERUGIAN — 2026-10-19

## L-1: Posisi live gilet — $25 tidak bisa dicairkan (biaya uji eksekusi)

- **Nominal**: $25 (0,010589 ETH) → 2.623.563,836639 gilet (wallet bot 0x629Ec…2F4E8)
- **Kapan**: pembelian live pertama lewat OKX (wrap→approve→swap), 19/10/2026 01:35.
- **Sebab (terukur, bukan dugaan)**:
  1. Pool satu-satunya (factory 0x1f7d7550…2efa): **WETH fee 100 → liquidity in-range = 0**
     (tidak ada pool lain: fee 500/3000/10000 tidak ada, pasangan USDG tidak ada).
  2. OKX menolak menjual: `51006 Input value is too low` (tak menilai token).
  3. Universal Router menolak: `Invalid token` (whitelist).
  4. DexScreener: 0 pair. → **tidak ada pembeli di mana pun.**
- **Akar kesalahan proses (milik asisten)**: entry dilakukan **sebelum** membuktikan jalur KELUAR.
  Yang diuji lebih dulu hanya jalur beli (OKX) + biaya. Urutan yang benar: buktikan bisa keluar → baru entry.
- **Perbaikan yang sudah terpasang**:
  - `bf2f9fa`: gerbang "BISA KELUAR" — quote jual wajib > 0 sebelum entry (kalau gagal: UNEXITABLE_BLOCK).
  - Loop `live-exits` memantau `liquidity()` pool setiap siklus; **bila likuiditas muncul, posisi dijual otomatis**
    (pemulihan sebagian/sepenuhnya jika ada pihak menambah likuiditas).
- **Status**: posisi tetap ditampilkan di panel LIVE sebagai "tidak bisa keluar" (tidak disembunyikan).
- **Uang yang tidak terpengaruh**: ETH (sisa) + USDG di wallet bot — terpisah dari posisi ini.
