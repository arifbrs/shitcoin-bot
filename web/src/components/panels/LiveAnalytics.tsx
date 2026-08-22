import type { StatsResponse } from "@/types/stats";

/**
 * Live counterparts of Exit Quality and Run Ledger.
 *
 * They exist so that when live is armed there is NOT ONE simulation number left on the screen.
 * Swapping only the headline panels left these two quietly showing paper analytics beside real
 * money — the same split-attention problem as the original strip, just further down the page.
 *
 * Discovery panels (Pasar, Pipeline, Scout, Admission, Band Watch) deliberately do NOT switch:
 * they describe the launches being evaluated, which is one shared pipeline feeding both modes,
 * not a result attributable to either.
 */

/** EXIT QUALITY (live) — which exit rule is actually making or costing the money. */
export function LiveExitQuality({ data }: { data: StatsResponse | null }) {
  const rows = data?.liveBridge?.summary?.exitReasons ?? [];
  if (rows.length === 0) {
    return <p className="font-mono text-[10px] text-muted-foreground">Belum ada exit live.</p>;
  }
  const worst = Math.max(...rows.map((r) => Math.abs(r.netSol)), 1e-9);

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto font-mono text-[10px]">
      {rows.map((r) => {
        const neg = r.netSol < 0;
        return (
          <div key={r.reason} className="flex items-center gap-2 whitespace-nowrap">
            <span className="w-[150px] truncate text-muted-foreground">{r.reason}</span>
            <span className="w-[26px] text-right text-foreground">{r.n}</span>
            {/* Bar length is |P&L|, not the count: three cheap exits matter less than one
                expensive one, and a count-based bar would say the opposite. */}
            <span className="h-[4px] flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className={`block h-full rounded-full ${neg ? "bg-down" : "bg-up"}`}
                style={{ width: `${((Math.abs(r.netSol) / worst) * 100).toFixed(0)}%`, opacity: 0.7 }}
              />
            </span>
            <span className={`w-[64px] text-right font-semibold ${neg ? "text-down" : "text-up"}`}>
              {r.netSol >= 0 ? "+" : ""}{r.netSol.toFixed(5)}◎
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * EXECUTION HEALTH (live) — takes the Run Ledger slot.
 *
 * Live has no "runs": there is no float to auto-refill, so the paper ledger's whole question
 * ("is this profit or a refill?") does not exist here. The question that DOES exist and has no
 * paper counterpart is whether the plumbing is costing money — builds that were refused, sells
 * that had to be deferred, bags the sweeper had to clean up after the model had moved on.
 */
export function LiveExecHealth({ data }: { data: StatsResponse | null }) {
  const b = data?.liveBridge;
  const s = b?.summary;
  if (!s) return <p className="font-mono text-xs text-muted-foreground">Belum ada data live.</p>;

  const orphan = s.exitReasons.find((r) => r.reason === "ORPHAN_SWEEP");
  const spent = s.spentSol;
  const back = s.proceedsSol;
  const Row = ({ k, v, tone, note }: { k: string; v: string; tone?: "up" | "down" | "warn"; note?: string }) => (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className="flex items-baseline gap-1.5">
        {note && <span className="text-[8.5px] text-muted-foreground/60">{note}</span>}
        <span className={`font-semibold ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-gold" : "text-foreground"}`}>{v}</span>
      </span>
    </div>
  );

  return (
    <div className="flex h-full flex-col gap-1 font-mono text-[10px]">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-2xl tabular-nums text-foreground">{s.wins}/{s.trades}</span>
        <span className="text-muted-foreground">trade live menang</span>
      </div>

      <div className="mt-1 flex flex-col gap-[3px]">
        <Row k="modal keluar" v={`${spent.toFixed(4)}◎`} />
        <Row k="kembali" v={`${back.toFixed(4)}◎`} />
        <Row k="net" v={`${s.netSol >= 0 ? "+" : ""}${s.netSol.toFixed(5)}◎`} tone={s.netSol >= 0 ? "up" : "down"} />
      </div>

      <div className="mt-2 border-t border-border pt-1.5 text-[8.5px] tracking-widest text-muted-foreground uppercase">
        kesehatan eksekusi
      </div>
      <div className="flex flex-col gap-[3px]">
        <Row k="buy ditolak" v={String(s.buyFailed)} tone={s.buyFailed > 0 ? "warn" : undefined} note="build / slippage" />
        <Row k="sell ditunda" v={String(s.sellDeferred)} tone={s.sellDeferred > 0 ? "warn" : undefined} note="saldo tak terbaca" />
        <Row
          k="orphan sweep"
          v={orphan ? `${orphan.n} · ${orphan.netSol.toFixed(5)}◎` : "0"}
          tone={orphan ? "down" : undefined}
          note="exit live tertinggal"
        />
        <Row k="tak terisi" v={String(s.neverFilled)} note="tidak jadi posisi" />
      </div>

      <p className="mt-auto pt-1 text-[8.5px] leading-tight text-muted-foreground/50">
        Angka ini tidak punya padanan di simulasi — paper tidak pernah gagal membangun transaksi
        dan tidak pernah harus menunda jual. Di sinilah biaya pipa terlihat, terpisah dari strategi.
      </p>
    </div>
  );
}
