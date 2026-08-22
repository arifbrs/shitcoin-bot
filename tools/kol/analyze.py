#!/usr/bin/env python3
"""
Analisis edge KOL. Dua pertanyaan, dan yang kedua yang menentukan keputusan belanja:

  1. Kalau kita ikut KOL lewat feed GRATIS (lag median ~50-90 detik), untung atau buntung?
  2. Kalau lag itu DIHILANGKAN dengan langganan sub-detik, apakah tandanya berbalik?

Pertanyaan 2 dijawab dengan regresi imbal hasil terhadap lag feed. Kalau baris ber-lag rendah
tidak lebih baik dari baris ber-lag tinggi, membayar untuk kecepatan tidak membeli apa pun.

Kehati-hatian yang wajib (pelajaran mahal dari sinyal '+43,5 poin' yang ternyata 100% lookahead):
  - Satu mint bisa muncul berkali-kali dalam beberapa menit. Itu BUKAN observasi independen.
    Semua ringkasan dikelompokkan per mint dulu, dan CI dihitung dari n mint, bukan n baris.
  - Ekor dipangkas: satu koin yang 10x bisa mengarang edge yang tidak ada.
"""
import json, glob, collections, math, sys

rows = [json.loads(l) for f in sorted(glob.glob("logs/kol-edge-*.jsonl")) for l in open(f)]
if not rows: sys.exit("belum ada data")

# LANTAI MC — bukan pilihan estetis. Sampel pertama menghasilkan "+370%" dari koin ber-MC $190;
# pada ukuran segitu satu pembelian receh menggerakkan harga ratusan persen dan angkanya tidak
# berarti apa-apa buat kita. Bot masuk di pita 55-74 SOL (~$10-13rb), jadi hanya koin yang
# benar-benar bisa kita beli yang boleh ikut menyimpulkan.
MC_FLOOR = float(sys.argv[1]) if len(sys.argv) > 1 else 5_000.0
before = len(rows)
rows = [r for r in rows if r["mc0"] >= MC_FLOOR]
print(f"lantai MC ${MC_FLOOR:,.0f} → {before - len(rows)} baris dibuang ({len(rows)} tersisa)")
if not rows: sys.exit("tidak ada baris di atas lantai MC")

HOR = [10, 30, 120, 600]

def ci(v):
    n = len(v)
    if n < 2: return (sum(v)/max(n,1), float("nan"))
    m = sum(v)/n
    sd = math.sqrt(sum((x-m)**2 for x in v)/(n-1))
    return m, 1.96*sd/math.sqrt(n)

print(f"baris total {len(rows)} · mint unik {len({r['mint'] for r in rows})} "
      f"· wallet unik {len({r['maker'] for r in rows if r.get('maker')})}\n")

lags = sorted(r["feedLagSec"] for r in rows if r.get("feedLagSec") is not None)
if lags:
    q = lambda p: lags[int(len(lags)*p)]
    print(f"LAG FEED (detik dari trade di chain sampai kita melihatnya)")
    print(f"  p10 {q(.10)}  median {q(.50)}  p90 {q(.90)}   <10s: {sum(1 for x in lags if x<10)/len(lags)*100:.0f}%\n")

print("IMBAL HASIL KE DEPAN (dari saat KITA melihat — inilah yang bisa ditiru)")
print(f"  {'horizon':>8} {'n baris':>8} {'n mint':>7} {'median':>9} {'rata2 per-mint':>16} {'trim ekor 5':>12}")
for h in HOR:
    sel = [r for r in rows if r["horizonSec"] == h]
    if not sel: continue
    per = collections.defaultdict(list)
    for r in sel: per[r["mint"]].append(r["retPct"])
    mints = [sum(v)/len(v) for v in per.values()]          # satu suara per mint
    m, hw = ci(mints)
    srt = sorted(mints, key=abs)
    trimmed = srt[:-5] if len(srt) > 15 else srt
    tm = sum(trimmed)/len(trimmed) if trimmed else float("nan")
    med = sorted(mints)[len(mints)//2]
    print(f"  {h:>7}s {len(sel):>8} {len(mints):>7} {med:>+8.2f}% {m:>+9.2f}% ±{hw:<5.2f} {tm:>+11.2f}%")

print("\nAPAKAH KECEPATAN MEMBELI SESUATU? (imbal hasil dibelah menurut lag feed)")
for h in HOR:
    sel = [r for r in rows if r["horizonSec"] == h and r.get("feedLagSec") is not None]
    if len(sel) < 20: continue
    cut = sorted(r["feedLagSec"] for r in sel)[len(sel)//2]
    fast = [r["retPct"] for r in sel if r["feedLagSec"] <= cut]
    slow = [r["retPct"] for r in sel if r["feedLagSec"] > cut]
    if not fast or not slow: continue
    fm, fh = ci(fast); sm, sh = ci(slow)
    verdict = "cepat LEBIH BAIK" if fm - sm > fh + sh else "tidak ada beda nyata"
    print(f"  +{h:>4}s  lag≤{cut:>3}s: {fm:+7.2f}% (n={len(fast):3d})   "
          f"lag>{cut:>3}s: {sm:+7.2f}% (n={len(slow):3d})   → {verdict}")

print("\nMENURUT TAG WALLET")
tagret = collections.defaultdict(list)
for r in rows:
    if r["horizonSec"] != 30: continue
    for t in (r.get("tags") or ["(tanpa tag)"]): tagret[t].append(r["retPct"])
for t, v in sorted(tagret.items(), key=lambda kv: -len(kv[1]))[:8]:
    m, hw = ci(v)
    print(f"  {t:<18} n={len(v):>4}  +30s {m:+7.2f}% ±{hw:.2f}")
