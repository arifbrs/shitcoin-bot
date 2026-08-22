import { useRef, useState } from "react";
import { postControl } from "@/lib/api";
import type { StatsResponse } from "@/types/stats";

/**
 * EXEC-MODE SWITCH — paper / simulasi / devnet / live.
 *
 * Deliberately a standalone component rather than JSX inside ControlDialog: the dialog renders
 * through a Radix portal, which produces ZERO static markup, so a control living inside it
 * cannot be rendered-checked at all. This one is executed for real by
 * `web/scripts/mode-switch-check.tsx` — which is how the "LIVE looks clickable when it isn't
 * permitted" class of bug gets caught before it reaches a button that spends money.
 *
 * This component only RENDERS the lock. `writeControl()` on the server enforces it, so a
 * tampered browser gains nothing by lying about `permitted`.
 */
export type Mode = "dry-run" | "simulate" | "devnet" | "live";

const MODES: Array<{ id: Mode; label: string; blurb: string }> = [
  { id: "dry-run", label: "PAPER", blurb: "tidak ada transaksi sama sekali — semuanya dihitung di dalam bot" },
  { id: "simulate", label: "SIMULASI", blurb: "transaksi nyata dibangun lalu disimulasikan ke mainnet, tidak pernah dikirim" },
  { id: "devnet", label: "DEVNET", blurb: "kirim + konfirmasi sungguhan di devnet, memakai SOL tanpa nilai" },
  { id: "live", label: "LIVE", blurb: "UANG SUNGGUHAN di mainnet" },
];

export function ModeSwitch({ data, walletFallback }: { data: StatsResponse | null; walletFallback?: string }) {
  const mode = (data?.control?.execMode ?? "dry-run") as Mode;
  const bridge = data?.liveBridge;
  // FAIL-CLOSED on the UI side too: an older server payload has no `liveBridge` at all, and
  // `undefined` must read as LOCKED, never as permitted.
  const livePermitted = bridge?.permitted === true;

  const [msg, setMsg] = useState<string | null>(null);
  const [armClick, setArmClick] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function selectMode(next: Mode) {
    if (next === mode) return;
    // Arming real money takes two clicks; leaving it takes one. Stopping must never be
    // harder than starting.
    if (next === "live") {
      if (!livePermitted) return;
      if (!armClick) {
        setArmClick(true);
        armTimer.current = setTimeout(() => setArmClick(false), 4000);
        return;
      }
      if (armTimer.current) clearTimeout(armTimer.current);
      setArmClick(false);
    }
    setMsg("mengirim…");
    postControl({ execMode: next })
      .then((st) =>
        setMsg(
          st.execMode === next
            ? `✓ mode sekarang ${st.execMode.toUpperCase()}`
            : `ditolak server — mode tetap ${st.execMode.toUpperCase()}`,
        ),
      )
      .catch((e) => setMsg(`gagal: ${e.message}`));
  }

  const active = MODES.find((m) => m.id === mode);
  const perTradeCap = data?.guardian?.caps?.maxPerTradeSol;

  return (
    <div>
      <p className="mb-2 text-[10px] tracking-widest text-muted-foreground">MODE EKSEKUSI</p>
      <div className="grid grid-cols-4 gap-1">
        {MODES.map((m) => {
          const isActive = m.id === mode;
          const isLive = m.id === "live";
          const locked = isLive && !livePermitted;
          const arming = isLive && armClick;
          const cls = locked
            ? "cursor-not-allowed border-border text-muted-foreground/40"
            : isActive && isLive
              ? "border-down bg-down/15 text-down"
              : isActive
                ? "border-gold bg-gold/10 text-gold"
                : arming
                  ? "border-down bg-down/10 text-down"
                  : "border-border text-muted-foreground hover:text-foreground";
          return (
            <button
              key={m.id}
              type="button"
              disabled={locked}
              onClick={() => selectMode(m.id)}
              title={locked ? "butuh LIVE_TRADING_CONFIRMED=yes di .env" : m.blurb}
              className={`rounded-md border px-1 py-1.5 font-mono text-[9px] tracking-[0.12em] transition-colors ${cls}`}
            >
              {arming ? "YAKIN?" : m.label}
              {locked ? " 🔒" : ""}
            </button>
          );
        })}
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">{active?.blurb}</p>

      {armClick && (
        <p className="mt-2 rounded-md border border-down/40 bg-down/5 p-2 text-[10px] leading-relaxed text-down">
          Klik LIVE sekali lagi untuk mengaktifkan. Bot akan mulai membelanjakan SOL sungguhan dari{" "}
          <span className="break-all">{bridge?.wallet || walletFallback || "wallet bot"}</span>
          {typeof perTradeCap === "number" ? `, maksimal ${perTradeCap} SOL per trade` : ""}.
        </p>
      )}

      {!livePermitted && (
        <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
          🔒 LIVE terkunci. Kuncinya sengaja tidak ada di browser: tambahkan{" "}
          <span className="text-foreground">LIVE_TRADING_CONFIRMED=yes</span> ke{" "}
          <span className="text-foreground">.env</span> lalu restart bot. Menghapus baris itu
          mencabut izin seketika.
        </p>
      )}

      {msg && <p className="mt-2 text-[10px] text-muted-foreground">{msg}</p>}

      {/* Live readout — only meaningful once the .env permission exists. */}
      {livePermitted && (
        <div className="mt-3 space-y-1 rounded-md border border-border p-2 text-[10px]">
          <div className="flex justify-between text-muted-foreground">
            <span>bridge</span>
            <span className={bridge?.armed ? "text-down" : "text-muted-foreground"}>
              {bridge?.armed ? "ARMED — uang sungguhan" : "disarmed"}
            </span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>posisi live</span>
            <span className="text-foreground">
              {bridge?.openLots ?? 0} · {(bridge?.deployedSol ?? 0).toFixed(4)} SOL
            </span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>realisasi</span>
            <span className={(bridge?.realizedSol ?? 0) >= 0 ? "text-up" : "text-down"}>
              {(bridge?.realizedSol ?? 0) >= 0 ? "+" : ""}
              {(bridge?.realizedSol ?? 0).toFixed(5)} SOL
            </span>
          </div>
          {bridge?.halted && <p className="pt-1 text-down">⛔ HALTED — {bridge.haltReason ?? "kill switch"}</p>}
          <p className="pt-1 leading-relaxed text-muted-foreground">
            Kembali ke PAPER menghentikan pembelian seketika, tapi posisi live yang masih terbuka
            tetap dijual sampai habis.
          </p>
        </div>
      )}
    </div>
  );
}
