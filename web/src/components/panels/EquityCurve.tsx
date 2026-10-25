import type { StatsResponse } from "@/types/stats";

/**
 * WALLET — one balance, two denominations, plus the session tape.
 *
 * The old panel drew a single smooth curve of the combined USD balance. Three things were wrong
 * with that, and all three are why this was rebuilt rather than restyled:
 *
 *  1. It compared against a number it never showed. The y-domain was [min(points), max(points)],
 *     so with the series at 783–886 and the float at 1145.73, the "▼ $293.93 vs $1145.95" headline
 *     referred to a line that was literally outside the frame.
 *  2. It hid where the money actually is. S1 is SOL-denominated (float 2 ◎) and S2 is USD-native
 *     (float $1000) — different sizes, different directions. Summing them into one line flattened
 *     the only fact worth knowing, which is which engine is losing.
 *  3. A smooth area hides the SHAPE of the loss. Whether a drawdown is a steady bleed or a few
 *     cliffs is real risk information, and interpolation erases it.
 *
 * So: dual denomination with the live rate, one row per asset measured in its OWN currency, and
 * a tape (one bar per sample) instead of a curve.
 *
 * Percentages are deliberately computed on each engine's NATIVE denomination. SOL moves on its
 * own, so pricing the SOL leg in dollars mixes trading performance with the SOL price — that is
 * not the bot's doing and must not land on its scorecard.
 */
export function EquityCurve({ data }: { data: StatsResponse }) {
  const c = data.combined;
  const legacy = data.paper?.legacy;
  const paper = data.strategy2Primary?.paper;

  // LIVE + on-chain read failed → UNKNOWN. The old fallback rendered $0.00 with an all-red
  // tape, which told the owner their funded wallet was empty. Say "unreadable" instead.
  //
  // URUTAN PENTING (2026-10-09): pemeriksaan ini HARUS lebih dulu dari penjaga `!paper` di bawah.
  // Dulu ia berada setelahnya, sehingga begitu lane S2 dimatikan (2026-10-07) panel jatuh ke pesan
  // "Strategy 2 belum jalan" dan pesan "saldo tidak terbaca" TIDAK PERNAH muncul — pemeriksa
  // `live saldo null` karena itu mustahil hijau. Fakta terpenting (dompet tak terbaca) tidak boleh
  // bisa disembunyikan oleh kondisi lane lain yang tak berhubungan.
  const s1 = c?.s1;
  const unreadable = c != null && (s1 == null || s1.balanceSol == null || s1.floatSol == null);
  if (unreadable) {
    return (
      <div className="flex h-full flex-col justify-center gap-1.5">
        <p className="font-mono text-[13px] text-muted-foreground">saldo tidak terbaca</p>
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground/60">
          Bacaan on-chain gagal sebentar (RPC). Uang TIDAK hilang — dompet tetap terbaca begitu
          salah satu endpoint menjawab. Panel ini tidak akan pernah menampilkan nol palsu untuk
          saldo yang tidak diketahui.
        </p>
      </div>
    );
  }
  if (!paper || !c) return <p className="font-mono text-xs text-muted-foreground">Strategy 2 belum jalan.</p>;
  // Lokal SETELAH penjaga: penyempitan tipe tidak bertahan lewat akses properti berulang, dan angka
  // saldo yang tak terbaca tidak boleh bocor diam-diam ke perhitungan (maka tetap diperiksa lagi).
  const s1Sol = c.s1?.balanceSol ?? null;
  const s1Float = c.s1?.floatSol ?? null;

  const rate = c.solUsd;
  const totalUsd = c.totalUsd ?? 0;
  const floatUsd = c.floatUsd ?? 0;
  const gap = totalUsd - floatUsd;
  const gapPct = floatUsd > 0 ? (gap / floatUsd) * 100 : 0;

  // Native-denomination performance, per engine.
  const s1Pct = s1Float != null && s1Float > 0 && s1Sol != null ? (s1Sol / s1Float - 1) * 100 : 0;
  const s2Pct = c.s2.floatUsd > 0 ? (c.s2.balanceUsd / c.s2.floatUsd - 1) * 100 : 0;
  const s1Share = totalUsd > 0 ? ((c.s1.balanceUsd ?? 0) / totalUsd) * 100 : 0;

  // TAPE — deviation from the first sample of this run, one bar per sample. Downsampled to a
  // fixed count so bar width stays legible however long the run gets.
  const eq = (c.equity ?? []).map((e) => e.bal);
  const N = Math.min(eq.length, 76);
  const samples = N > 0 ? Array.from({ length: N }, (_, i) => eq[Math.floor((i * eq.length) / N)]!) : [];
  const base = samples[0] ?? 0;
  const dev = samples.map((v) => v - base);

  // Zero sits where zero actually falls in the range, not at a fixed midline.
  //
  // With the midline pinned to 50%, a run that never traded above its starting point left the
  // whole top half of the panel empty — measured on the live screenshot, roughly half the tile
  // was dead space. Placing the line proportionally uses the full height while keeping ONE
  // scale for both directions: separate up/down scales would fill the box too, but a +$5 bar
  // and a −$5 bar would then draw at different heights, which is a lie about the data.
  const PLOT_H = 96;                 // 2 units of breathing room top and bottom
  const TOP = 2;
  const maxUp = Math.max(0, ...dev);
  const maxDown = Math.max(0, ...dev.map((d) => -d));
  const span = maxUp + maxDown;
  // A run that has not moved at all (or has a single sample) has no range to place zero within.
  // Pinning the line to the middle is the honest reading of "flat"; the proportional formula
  // would drop it to the very top and read as "everything is below the start", which is wrong.
  const flat = span < 1e-9;
  const zeroY = flat ? TOP + PLOT_H / 2 : TOP + (maxUp / span) * PLOT_H;
  const unit = flat ? 0 : PLOT_H / span;   // one scale, both directions

  const money = (v: number, d = 2): string => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(d)}`;
  const pct = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;

  const AssetRow = ({ sym, accent, native, quote, dp, share, wl }: {
    sym: string; accent: string; native: string; quote: string; dp: number; share: number; wl: string;
  }) => (
    <div className="flex h-[22px] items-center gap-2">
      <span className="w-8 font-mono text-[9px] tracking-widest" style={{ color: accent }}>{sym}</span>
      <span className="w-[92px] font-mono text-[11.5px] tabular-nums text-foreground">{native}</span>
      <span className="w-[70px] font-mono text-[9.5px] tabular-nums text-muted-foreground/60">{quote}</span>
      <span className={`w-[48px] font-mono text-[10px] tabular-nums ${dp >= 0 ? "text-up" : "text-down"}`}>{pct(dp)}</span>
      <span className="h-[4px] flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full opacity-60" style={{ width: `${share.toFixed(0)}%`, background: accent }} />
      </span>
      <span className="w-[62px] text-right font-mono text-[9px] tabular-nums text-muted-foreground/60">{wl}</span>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-end gap-2.5">
        <span className="font-sans text-[26px] font-semibold leading-none tabular-nums">{money(totalUsd)}</span>
        {rate != null && rate > 0 && (
          <span className="pb-px font-mono text-[13px] tabular-nums text-muted-foreground">{(totalUsd / rate).toFixed(4)} ◎</span>
        )}
        <span className="flex-1" />
        <span className={`pb-0.5 font-mono text-[10px] tabular-nums ${gap >= 0 ? "text-up" : "text-down"}`}>
          {money(gap)} · {pct(gapPct)}
        </span>
      </div>

      <p className="mb-2 mt-0.5 font-mono text-[9.5px] tabular-nums text-muted-foreground/60">
        {rate != null && rate > 0 ? <>1 ◎ = {money(rate)} · </> : <>kurs SOL tidak tersedia · </>}
        float {money(floatUsd)}
        {rate != null && rate > 0 && <> / {(floatUsd / rate).toFixed(4)} ◎</>}
      </p>

      {/*
        Baris dari rezim pembukuan LAMA. Sejak 2026-08-25 P&L paper dibukukan pada laju yang
        benar-benar cair; baris sebelum itu tidak. Menjumlahkan keduanya menghasilkan angka yang
        bukan apa-apa, jadi angka di atas hanya memuat rezim yang sedang berlaku — dan baris ini
        ada supaya "kenapa cum P&L-ku berubah?" punya jawaban di layar, bukan di commit log.
      */}
      {/*
        Kualifikasi "executable only" ditulis oleh simulasi buy, yang tidak berjalan pada mode
        ini — jadi angka di atas memuat SEMUA trade, bukan hanya yang terbukti mendarat. Tanpa
        baris ini panel akan diam-diam mengganti arti angkanya sendiri.
      */}
      {data.paper?.execStageUnresolved && (
        <p className="mb-2 -mt-1 font-mono text-[9px] tabular-nums text-muted-foreground/50"
           title="execStage tetap 'pending' karena simulasi buy hanya berjalan pada execMode simulate. Angka memuat semua trade, bukan hanya yang terbukti dapat dieksekusi.">
          semua trade dihitung — bukti "dapat dieksekusi" tidak dikumpulkan pada mode ini
        </p>
      )}
      {legacy != null && legacy.closed > 0 && (
        <p
          className="mb-2 -mt-1 font-mono text-[9px] tabular-nums text-muted-foreground/50"
          title="Trade lama dibukukan sebelum koreksi eksekusi terpasang. Angka di atas sengaja tidak menjumlahkannya."
        >
          {legacy.closed.toLocaleString("id-ID")} trade lama ({legacy.realizedSol >= 0 ? "+" : "−"}
          {Math.abs(legacy.realizedSol).toFixed(2)} ◎) tidak dijumlah — pembukuan berbeda
        </p>
      )}

      <AssetRow
        sym="SOL" accent="var(--hud-gold)"
        native={s1Sol != null ? `${s1Sol.toFixed(4)} ◎` : "—"}
        quote={c.s1?.balanceUsd != null ? `≈ ${money(c.s1.balanceUsd)}` : "—"}
        dp={s1Pct} share={s1Share} wl={`${c.s1?.wins ?? 0}W/${c.s1?.losses ?? 0}L`}
      />
      <AssetRow
        sym="USD" accent="var(--hud-scout)"
        native={money(c.s2.balanceUsd)}
        quote={rate != null && rate > 0 ? `= ${(c.s2.balanceUsd / rate).toFixed(3)} ◎` : "—"}
        dp={s2Pct} share={100 - s1Share} wl={`${c.s2.wins}W/${c.s2.losses}L`}
      />

      {/* Tape: bars, not a curve — clustering and cliff depth stay visible. */}
      <div className="mt-1.5 min-h-0 flex-1">
        <svg width="100%" height="100%" preserveAspectRatio="none" viewBox={`0 0 ${Math.max(N, 1)} 100`}>
          <line x1="0" y1={zeroY.toFixed(2)} x2={Math.max(N, 1)} y2={zeroY} stroke="var(--hud-line)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
          {dev.map((d, i) => {
            const h = Math.abs(d) * unit;
            const up = d >= 0;
            return (
              <rect
                key={i} x={i + 0.12} width={0.76}
                y={up ? zeroY - h : zeroY} height={Math.max(h, 0.6)}
                fill={up ? "var(--hud-up)" : "var(--hud-down)"}
                opacity={0.35 + 0.55 * (Math.abs(d) / (Math.max(maxUp, maxDown) || 1))}
              />
            );
          })}
        </svg>
      </div>

      <p className="mt-1 font-mono text-[8.5px] leading-tight text-muted-foreground/50">
        {N} sampel sejak {money(base)} · %-nya diukur pada denominasi asli tiap mesin, jadi harga SOL tidak mencemari rapor bot
      </p>
    </div>
  );
}
