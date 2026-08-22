"""
Mesin replay aturan exit, dibaca 1:1 dari papertrader.ts.

Urutan evaluasi per tick, PERSIS seperti kode hidup:
  1. CATASTROPHIC   execPnl <= -70
  2. NO_DEVELOPMENT held >= 45s DAN puncak-exec < +5%
  3. TRAIL_LOCK     puncak >= +15% → trail dari tangga; fadeTighten x0.6 bila >60s sejak puncak
  4. MAX_HOLD       held >= 120s

Exit yang TIDAK bisa direplay dari harga (DEV_DUMP, FALLBACK_STOP, STALE, FEELING) diperlakukan
EKSOGEN: dipertahankan apa adanya di baseline maupun varian, sehingga saling meniadakan saat
model dibandingkan dengan model.
"""
LADDER = [(15, 6), (40, 12), (80, 22), (150, 35), (300, 45)]
# scaleOut hidup dan WAJIB ada di baseline. Tanpa ini, model melaporkan hanya mark akhir
# sementara P&L nyata memuat tier yang sudah dibukukan di harga lebih tinggi — pada 99 dari 653
# trade selisihnya >20 poin, dengan waktu dan alasan exit yang IDENTIK. Persis jebakan yang
# dicatat memori: "lupa memasukkan ladder sekali menghasilkan +2.243 poin palsu".
TIERS = [(30, 0.40), (80, 0.30), (200, 0.15)]
MIN_KEEP = 0.15
NO_DEV_SEC, NO_DEV_PEAK = 45, 5.0
CATASTROPHIC = -70.0
FADE_AFTER_SEC, FADE_MULT = 60, 0.6
EXOGENOUS = {"DEV_DUMP", "FALLBACK_STOP", "FALLBACK_DEVDUMP", "STALE", "FEELING",
             "LIQUIDITY_GONE", "RUN_RESET", "MANUAL_CLOSE", "MANUAL_FLATTEN", "NEVER_PRICED"}

def trail_for(peak):
    t = None
    for g, tr in LADDER:
        if peak >= g: t = tr
    return t

def replay(path, actual_reason, actual_held, max_hold=120, no_dev_sec=NO_DEV_SEC,
           no_dev_peak=NO_DEV_PEAK, fade=True, ladder_mult=1.0):
    """path = [(heldSec, execPnlPct)] terurut. Kembalikan (reason, heldSec, pnlPct)."""
    peak = 0.0; peak_at = 0.0
    banked = 0.0        # P&L (poin) yang sudah dibukukan lewat tier
    remaining = 1.0     # fraksi posisi yang masih dipegang
    tier_i = 0
    def settle(pnl_now):
        return banked + remaining * pnl_now
    for held, pnl in path:
        # scale-out: tier menaik, dipicu oleh execPnl saat ini, menjual fraksi posisi ASLI
        while tier_i < len(TIERS) and pnl >= TIERS[tier_i][0]:
            frac = min(TIERS[tier_i][1], max(0.0, remaining - MIN_KEEP))
            if frac > 0:
                banked += frac * pnl
                remaining -= frac
            tier_i += 1
        if pnl > peak: peak, peak_at = pnl, held
        # exit eksogen menang bila waktunya tiba — tidak bisa dimodelkan dari harga
        if actual_reason in EXOGENOUS and held >= actual_held:
            return actual_reason, held, settle(pnl)
        if pnl <= CATASTROPHIC:
            return "CATASTROPHIC", held, settle(pnl)
        if held >= no_dev_sec and peak < no_dev_peak:
            return "NO_DEVELOPMENT", held, settle(pnl)
        tp = trail_for(peak)
        if tp is not None:
            tp *= ladder_mult
            if fade and (held - peak_at) >= FADE_AFTER_SEC: tp *= FADE_MULT
            # RASIO terhadap puncak proceeds, bukan selisih poin persen — papertrader.ts:1312
            #   execDrawdownPct = (execProceeds − peakExecProceeds) / peakExecProceeds × 100
            # Memakai selisih poin membuat trail memicu ~2x lebih mudah pada posisi yang sudah
            # naik tinggi (puncak +100% → +80% adalah −10% rasio, bukan −20 poin), dan itulah
            # yang membuat gerbang pertama gagal di 89,8% dengan kelebihan TRAIL_LOCK.
            peak_pr = 1.0 + peak / 100.0
            cur_pr = 1.0 + pnl / 100.0
            dd = ((cur_pr - peak_pr) / peak_pr) * 100.0 if peak_pr > 0 else 0.0
            if tp < 100 and dd <= -tp:
                return "TRAIL_LOCK", held, settle(pnl)
        if held >= max_hold:
            return "MAX_HOLD", held, settle(pnl)
    # Jalur habis. Kalau exit sungguhannya EKSOGEN, ia terjadi pada atau setelah sampel terakhir
    # kita — peristiwa itu diambil apa adanya, bukan dibuang. (Versi pertama menuntut
    # held >= actual_held, sehingga exit yang jatuh di antara dua sampel tidak pernah terpicu dan
    # muncul sebagai PATH_END palsu: 13 dari 653.)
    if actual_reason in EXOGENOUS and path:
        return actual_reason, path[-1][0], settle(path[-1][1])
    return ("PATH_END", path[-1][0], settle(path[-1][1])) if path else ("NO_PATH", 0, 0.0)
