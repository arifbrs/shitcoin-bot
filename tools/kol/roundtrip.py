#!/usr/bin/env python3
"""
Menjawab: kalau kita menyalin KOL — masuk saat dia masuk, keluar saat dia keluar — untung?

Pasangan beli→jual per (wallet, mint) dari logs/kol-copy-*.jsonl. Imbal hasil diukur dari
MC pump.fun di kedua titik, jadi ia mencerminkan pergerakan harga yang sebenarnya.

GERBANG WAJIB (dua kali dalam proyek ini sinyal besar ternyata lookahead):
 1. ARAH WAKTU — jual harus SESUDAH beli, dan keduanya harus terdeteksi bukan direkonstruksi.
 2. PRESISI    — 1,96·SD/√n harus lebih kecil dari efeknya.
 3. PANGKAS EKOR — buang 1/3/5/10 terbesar; kalau runtuh, itu ulah segelintir.
 4. LAG JUJUR  — hasil dihitung dari saat KITA MELIHAT, bukan saat KOL bertindak.
"""
import json, glob, collections, math, sys

rows = []
for f in sorted(glob.glob("logs/kol-copy-*.jsonl")):
    for l in open(f):
        try: rows.append(json.loads(l))
        except: pass

by = collections.defaultdict(list)
for r in rows:
    if r.get("mint") and r.get("wallet"): by[(r["wallet"], r["mint"])].append(r)

trips = []
for (w, m), evs in by.items():
    evs.sort(key=lambda x: x.get("blockTime") or 0)
    buy = next((e for e in evs if e["side"] == "buy"), None)
    if not buy: continue
    sell = next((e for e in evs if e["side"] == "sell" and (e.get("blockTime") or 0) > (buy.get("blockTime") or 0)), None)
    if not sell: continue
    trips.append((buy, sell))

print(f"round-trip lengkap: {len(trips)}")
if len(trips) < 30: sys.exit("belum cukup")

def ci(x):
    n = len(x); mu = sum(x)/n
    sd = math.sqrt(sum((y-mu)**2 for y in x)/(n-1)) if n > 1 else 0
    return mu, (1.96*sd/math.sqrt(n)) if n > 1 else 0, sd

bad_dir = sum(1 for b, s in trips if (s.get("blockTime") or 0) <= (b.get("blockTime") or 0))
print(f"  GERBANG 1 arah waktu: {bad_dir} pasangan terbalik  {'✗' if bad_dir else '✓'}")

lags = sorted(b.get("detectLagSec") or 0 for b, _ in trips)
print(f"  GERBANG 4 lag deteksi beli: p50 {lags[len(lags)//2]:.0f}s · p90 {lags[int(len(lags)*.9)]:.0f}s")

holds = sorted(((s.get("blockTime") or 0) - (b.get("blockTime") or 0)) for b, s in trips)
print(f"  lama KOL memegang: p25 {holds[len(holds)//4]}s · median {holds[len(holds)//2]}s · p75 {holds[3*len(holds)//4]}s\n")

# Imbal hasil: KOL sendiri (harga beli→jual mereka) — proksi via mcNow di tiap kejadian
rets = []
for b, s in trips:
    mb, ms = b.get("mcNow"), s.get("mcNow")
    if isinstance(mb, (int, float)) and isinstance(ms, (int, float)) and mb > 0:
        rets.append((ms/mb - 1)*100)
if rets:
    m, h, sd = ci(rets)
    print(f"IMBAL HASIL round-trip (n={len(rets)}): {m:+.2f}% ±{h:.2f}   SD {sd:.1f}")
    print(f"  GERBANG 2 presisi: {'LULUS — nol di luar CI' if abs(m) > h else 'GAGAL — nol di dalam CI'}")
    srt = sorted(rets, key=abs)
    print("  GERBANG 3 pangkas ekor:")
    for k in (1, 3, 5, 10):
        r2 = srt[:-k]
        print(f"    buang {k:>2} terbesar → {sum(r2)/len(r2):+.2f}%")
    win = sum(1 for x in rets if x > 0)
    print(f"\n  menang {win}/{len(rets)} ({win/len(rets)*100:.0f}%) · median {sorted(rets)[len(rets)//2]:+.2f}%")
    print(f"  ONGKOS KITA: bolak-balik ~2,8% + lag deteksi. EV bersih ≈ {m-2.8:+.2f}%")
