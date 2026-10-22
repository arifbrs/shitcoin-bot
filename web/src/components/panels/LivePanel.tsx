import { useEffect, useState } from "react";
import { finite, formatDuration, formatQuantity, formatUsd } from "@/lib/terminal";

type Live = {
  wallet: string;
  balances: { eth: number; weth: number; usdg: number };
  positions: Array<{ token: string; symbol?: string; notionalUsd?: number; route?: string; ageMin: number; paperHolds: boolean; reason: string }>;
  sells: Array<{ token: string; symbol?: string; ts: number }>;
  costs: { poolFeePct: number; gasPerSwapUsd: number; note: string };
};

export function LivePanel() {
  const [s, setS] = useState<Live | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let on = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const r = await fetch("/api/live", { signal: controller.signal });
        if (r.status === 401) throw new Error("session-expired");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as Live;
        if (!Array.isArray(j.positions) || !Array.isArray(j.sells)) throw new Error("Format snapshot live tidak valid.");
        if (on) { setS(j); setErr(null); }
      } catch (e) {
        if (!on) return;
        if (e instanceof Error && e.message === "session-expired") { window.location.replace("/login"); return; }
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = setInterval(load, 2000); // realtime 2s
    return () => { on = false; controller.abort(); clearInterval(t); };
  }, [attempt]);
  const retry = () => setAttempt((value) => value + 1);
  if (!s) return <section className="terminal-panel-card" aria-label="Wallet dan posisi live server"><p role={err ? "alert" : "status"}>LIVE SERVER · {err ? `galat membaca /api/live — ${err}` : "memuat…"}</p>{err && <button type="button" className="terminal-button" onClick={retry}>Coba lagi</button>}</section>;
  const open = s.positions.length;
  return (
    <section className="terminal-panel-card" aria-label="Wallet dan posisi live server">
      {err && <p className="terminal-inline-note" role="alert">Galat membaca /api/live — {err} · menampilkan snapshot terakhir<button type="button" onClick={retry}>Coba lagi</button></p>}
      <div className="terminal-panel-summary">
        <span className="terminal-badge">LIVE SERVER</span>
        <span title={s.wallet}>{s.wallet ? `${s.wallet.slice(0, 10)}…${s.wallet.slice(-4)}` : "Wallet —"}</span>
        <span>ETH {formatQuantity(s.balances?.eth)}</span>
        <span>WETH {formatQuantity(s.balances?.weth)}</span>
        <span>USDG {formatQuantity(s.balances?.usdg)}</span>
        <span>{open} posisi live · {s.sells.length} terjual</span>
      </div>
      <div className="terminal-lane-table-scroll">
        {open === 0 ? (
          <p className="terminal-note">Tidak ada posisi live terbuka.</p>
        ) : (
          <table className="terminal-table terminal-lane-table">
            <thead><tr><th>Token</th><th>Notional USD</th><th>Umur posisi</th><th>Alasan belum dijual</th></tr></thead>
            <tbody>
              {s.positions.map((p) => (
                <tr key={p.token}>
                  <td>{p.symbol ?? p.token.slice(0, 10)}</td>
                  <td>{formatUsd(p.notionalUsd)}</td>
                  <td>{formatDuration(finite(p.ageMin) === null ? null : p.ageMin * 60)}</td>
                  <td>{p.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="terminal-note">Biaya nyata: fee pool {finite(s.costs?.poolFeePct) === null ? "—" : `${(s.costs.poolFeePct * 100).toFixed(2)}%`} · gas {formatUsd(s.costs?.gasPerSwapUsd)}/swap — {s.costs?.note ?? "—"}</p>
    </section>
  );
}
