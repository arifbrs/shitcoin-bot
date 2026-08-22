#!/usr/bin/env python3
"""
Menjawab: bisakah agent LLM menandai, DI WAKTU MASUK, entry mana yang akan berakhir buruk?

Jodohkan verdict shadow (decisionId) dengan hasil penutupan (netExecutablePnlPct).

TIGA GERBANG WAJIB, dan gerbang 1 yang paling penting — dua kali hari ini sinyal yang
tampak besar ternyata lookahead:
  1. ARAH WAKTU — snapshot HARUS beku di waktu keputusan. Dicek lewat judgedLagSec > 0.
  2. PRESISI    — 1,96·SD/√n harus lebih kecil dari efeknya.
  3. PANGKAS EKOR — buang 1/3/5/10 efek terbesar; kalau efeknya runtuh, itu ulah segelintir.
"""
import json, glob, collections, math, sys

ver = {}
for f in sorted(glob.glob("logs/entry-shadow-*.jsonl")):
    for l in open(f):
        try: r = json.loads(l)
        except: continue
        if r.get("ok") and r.get("decisionId"): ver[r["decisionId"]] = r
res = {}
for f in sorted(glob.glob("logs/paper-trades-*.jsonl")):
    for l in open(f):
        try: r = json.loads(l)
        except: continue
        if r.get("action") == "PARTIAL" or r.get("exit") is None: continue
        if r.get("decisionId") and isinstance(r.get("netExecutablePnlPct"), (int, float)):
            res[r["decisionId"]] = r

pair = [(v, res[d]) for d, v in ver.items() if d in res]
print(f"verdict {len(ver)} · berjodoh dengan hasil {len(pair)}")
if not pair: sys.exit("belum cukup — biarkan mengumpul")

lags = [v.get("judgedLagSec") for v, _ in pair if isinstance(v.get("judgedLagSec"), (int, float))]
print(f"  jeda nilai-vs-keputusan: min {min(lags)}s (positif = snapshot beku, bukan info hidup)\n")

def ci(x):
    n = len(x); m = sum(x) / n
    sd = math.sqrt(sum((y - m) ** 2 for y in x) / (n - 1)) if n > 1 else 0
    return m, (1.96 * sd / math.sqrt(n)) if n > 1 else 0

by = collections.defaultdict(list)
for v, c in pair: by[v["outlook"]].append(c["netExecutablePnlPct"])
print(f"  {'outlook':<12} {'n':>5} {'hasil akhir':>13} {'±95%':>8}")
for k, x in sorted(by.items(), key=lambda kv: -len(kv[1])):
    m, h = ci(x); print(f"  {k:<12} {len(x):>5} {m:>+12.2f}% {h:>8.2f}")

good = by.get("good", []); bad = by.get("bad", [])
if len(good) >= 20 and len(bad) >= 20:
    mg, hg = ci(good); mb, hb = ci(bad)
    sep = mg - mb
    print(f"\n  DAYA PISAH good−bad: {sep:+.2f} poin  (±{hg+hb:.2f})")
    print(f"  → {'ADA sinyal' if sep > hg + hb else 'TIDAK terbukti'}")

# Kontrafaktual: lewati entry ber-outlook 'bad' berkeyakinan >=X.
allr = [c["netExecutablePnlPct"] for _, c in pair]
base = sum(allr) / len(allr)
print(f"\n  EV semua entry: {base:+.2f}%")
print(f"  {'ambang':<22} {'dilewati':>9} {'EV baru':>9} {'selisih':>9}")
for th in (50, 60, 70, 80):
    keep = [c["netExecutablePnlPct"] for v, c in pair
            if not (v["outlook"] == "bad" and (v.get("confidence") or 0) >= th)]
    if len(keep) < 10: continue
    m = sum(keep) / len(keep)
    print(f"  lewati bad conf>={th:<10} {len(pair)-len(keep):>9} {m:>+8.2f}% {m-base:>+9.2f}")
