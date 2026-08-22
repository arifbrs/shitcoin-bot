"""Merakit jalur penuh: tick (entry→exit) + sampel pasca-exit (exit→horizon)."""
import json, glob, collections, pickle

ticks = collections.defaultdict(list)      # tradeId -> [(heldSec, execPnlPct, peakPct)]
for f in sorted(glob.glob('logs/ticks-2026-08-*.jsonl')):
    for ln in open(f, errors='ignore'):
        if '"unpriced"' in ln: continue
        try: r = json.loads(ln)
        except: continue
        tid = r.get('tradeId')
        if tid and isinstance(r.get('heldSec'), (int, float)) and isinstance(r.get('execPnlPct'), (int, float)):
            ticks[tid].append((r['heldSec'], r['execPnlPct'], r.get('peakPct'), r.get('vSol')))

post = collections.defaultdict(list)       # tradeId -> [(secSinceExit, pctVsExit)]
for f in sorted(glob.glob('logs/post-exit-2026-08-*.jsonl')):
    for ln in open(f, errors='ignore'):
        try: r = json.loads(ln)
        except: continue
        if r.get('type') != 'sample': continue
        tid = r.get('tradeId')
        if tid and isinstance(r.get('secSinceExit'), (int, float)) and isinstance(r.get('pctVsExit'), (int, float)):
            post[tid].append((r['secSinceExit'], r['pctVsExit']))

closes = {}                                # tradeId -> record CLOSE
opens = {}
for f in sorted(glob.glob('logs/paper-trades-2026-08-*.jsonl')):
    for ln in open(f, errors='ignore'):
        try: r = json.loads(ln)
        except: continue
        tid = r.get('tradeId')
        if not tid: continue
        if r.get('action') == 'CLOSE': closes[tid] = r
        elif r.get('action') == 'OPEN': opens[tid] = r

for d in (ticks, post):
    for k in d: d[k].sort()

both = [t for t in closes if t in ticks and t in post and len(ticks[t]) >= 3]
print(f"  CLOSE: {len(closes)} · punya tick: {sum(1 for t in closes if t in ticks)} · punya pasca-exit: {sum(1 for t in closes if t in post)}")
print(f"  LENGKAP (tick>=3 + pasca-exit): {len(both)}")

cfg = collections.Counter(closes[t].get('cfg') for t in both)
print(f"  per cohort: {dict(cfg.most_common(5))}")
hor = sorted(max(s for s, _ in post[t]) for t in both)
print(f"  horizon pasca-exit: median {hor[len(hor)//2]:.0f}s · p90 {hor[int(.9*len(hor))]:.0f}s · maks {max(hor):.0f}s")
pickle.dump({'ticks': dict(ticks), 'post': dict(post), 'closes': closes, 'opens': opens, 'both': both},
            open('/tmp/sim.pkl', 'wb'))
print("  → /tmp/sim.pkl")
