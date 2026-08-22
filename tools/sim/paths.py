"""Merakit jalur penuh entry→jauh-sesudah-exit dan menyediakannya ke replay."""
import pickle

def build(sim, cfgs=None):
    ticks, post, closes = sim['ticks'], sim['post'], sim['closes']
    out = []
    for tid in sim['both']:
        c = closes[tid]
        if cfgs and c.get('cfg') not in cfgs: continue
        exit_pnl = c.get('pnlPct')
        if not isinstance(exit_pnl, (int, float)): continue
        tk = [(h, p) for h, p, _, _ in ticks[tid]]
        if not tk: continue
        held_exit = max(h for h, _ in tk)
        # Sesudah exit: pctVsExit adalah % TERHADAP HARGA EXIT. P&L kalau kita menahan =
        # gabungan multiplikatif dari P&L saat exit dengan gerakan sesudahnya.
        base = 1.0 + exit_pnl / 100.0
        tail = [(held_exit + s, (base * (1.0 + q / 100.0) - 1.0) * 100.0) for s, q in post[tid] if s > 0]
        out.append({'tid': tid, 'cfg': c.get('cfg'), 'reason': c.get('reason'),
                    'held': c.get('heldSec') or held_exit, 'pnl': exit_pnl,
                    'path': tk, 'full': tk + tail,
                    'horizon': max([s for s, _ in post[tid]] or [0])})
    return out
