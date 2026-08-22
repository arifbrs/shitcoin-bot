#!/usr/bin/env python3
"""
Imbal hasil round-trip KOL dari harga FILL NYATA mereka (SOL keluar/masuk ÷ token).

Lebih jujur daripada menandai dengan MC pasar: sudah termasuk slippage dan dampak harga
pembelian mereka sendiri — persis yang akan kita alami kalau menyalin.

Gerbang: arah waktu, presisi, pangkas ekor, dan pembelahan menurut lag deteksi kita
(kalau yang terlihat cepat tidak lebih baik, kecepatan tidak membeli apa pun).
"""
import json, collections, math, sys

px = {}
for l in open("logs/kol-price.jsonl"):
    try: r = json.loads(l)
    except: continue
    if r.get("priceSol") and r["priceSol"] > 0: px[r["sig"]] = r

lag = {}
import glob
for f in glob.glob("logs/kol-copy-*.jsonl"):
    for l in open(f):
        try: r = json.loads(l)
        except: continue
        if r.get("sig"): lag[r["sig"]] = r.get("detectLagSec")

by = collections.defaultdict(list)
for r in px.values(): by[(r["wallet"], r["mint"])].append(r)

trips = []
for k, evs in by.items():
    evs.sort(key=lambda x: x.get("blockTime") or 0)
    buy = next((e for e in evs if e["side"] == "buy"), None)
    if not buy: continue
    sell = next((e for e in evs if e["side"] == "sell" and (e.get("blockTime") or 0) > (buy.get("blockTime") or 0)), None)
    if not sell: continue
    trips.append((buy, sell))

print(f"harga tersedia {len(px)} · round-trip berharga {len(trips)}")
if len(trips) < 30: sys.exit("belum cukup")

def ci(x):
    n = len(x); mu = sum(x)/n
    sd = math.sqrt(sum((y-mu)**2 for y in x)/(n-1)) if n > 1 else 0
    return mu, (1.96*sd/math.sqrt(n)) if n > 1 else 0, sd

rets = [(s["priceSol"]/b["priceSol"] - 1)*100 for b, s in trips]
m, h, sd = ci(rets)
print(f"\nIMBAL HASIL KOL (fill nyata mereka): {m:+.2f}% ±{h:.2f}  ·  SD {sd:.1f}  ·  n={len(rets)}")
print(f"  GERBANG presisi: {'LULUS' if abs(m) > h else 'GAGAL — nol di dalam CI'}")
srt = sorted(rets, key=abs)
print("  GERBANG pangkas ekor:")
for k in (1, 3, 5, 10):
    r2 = srt[:-k]; print(f"    buang {k:>2} → {sum(r2)/len(r2):+.2f}%")
win = sum(1 for x in rets if x > 0)
med = sorted(rets)[len(rets)//2]
print(f"  menang {win}/{len(rets)} ({win/len(rets)*100:.0f}%) · median {med:+.2f}%")

print("\nAPAKAH KECEPATAN MEMBELI SESUATU? (dibelah menurut lag deteksi kita)")
pairs = [(lag.get(b["sig"]), r) for (b, s), r in zip(trips, rets) if isinstance(lag.get(b["sig"]), (int, float))]
if len(pairs) >= 40:
    cut = sorted(p[0] for p in pairs)[len(pairs)//2]
    fast = [r for l_, r in pairs if l_ <= cut]; slow = [r for l_, r in pairs if l_ > cut]
    mf, hf, _ = ci(fast); ms, hs, _ = ci(slow)
    print(f"  lag ≤{cut:.0f}s: {mf:+.2f}% ±{hf:.2f} (n={len(fast)})")
    print(f"  lag >{cut:.0f}s: {ms:+.2f}% ±{hs:.2f} (n={len(slow)})")
    print(f"  → {'cepat LEBIH BAIK' if mf-ms > hf+hs else 'tidak ada beda nyata'}")

print(f"\n  ONGKOS KITA: ~2,8% bolak-balik. EV bersih kalau menyalin sempurna ≈ {m-2.8:+.2f}%")
