import { useEffect, useState } from "react";
import { finite, formatCount, formatDuration, formatPercent, formatQuantity, formatUtc, numericTone } from "@/lib/terminal";

type PaperData = {
  engine: string;
  cycles: number;
  candidates: number;
  positions: Array<{ arm: string; symbol: string; token: string; ageMin: number; entryWeth: number; markWeth: number | null; pnlPct: number | null; stuck: boolean; stuckReason: string | null }>;
  closed: number;
  stuck: number;
  byArm: Record<string, { open: number; closed: number; stuck: number }>;
  rule: string;
  updatedAt: string;
};

export function PaperPanel() {
  const [d, setD] = useState<PaperData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const r = await fetch("/api/paper", { signal: controller.signal });
        if (r.status === 401) throw new Error("session-expired");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as PaperData;
        if (!Array.isArray(j.positions)) throw new Error("Format snapshot paper tidak valid.");
        if (alive) { setD(j); setError(null); }
      } catch (cause) {
        if (!alive) return;
        if (cause instanceof Error && cause.message === "session-expired") { window.location.replace("/login"); return; }
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    const t = setInterval(load, 30000);
    return () => { alive = false; controller.abort(); clearInterval(t); };
  }, [attempt]);
  const retry = () => setAttempt((value) => value + 1);

  if (!d) return <section className="terminal-panel-card" aria-label="Paper 1:1 server"><p role={error ? "alert" : "status"}>PAPER 1:1 SERVER · {error ? `galat membaca /api/paper — ${error}` : "memuat…"}</p>{error && <button type="button" className="terminal-button" onClick={retry}>Coba lagi</button>}</section>;
  const idle = d.positions.length === 0 && d.closed === 0;

  return (
    <section className="terminal-panel-card" aria-label="Paper 1:1 server">
      {error && <p className="terminal-inline-note" role="alert">Galat membaca /api/paper — {error} · menampilkan snapshot terakhir<button type="button" onClick={retry}>Coba lagi</button></p>}
      <div className="terminal-panel-summary"><span className="terminal-badge">PAPER 1:1 SERVER</span><span>Ledger engine · bukan simulasi lokal</span><span>siklus {formatCount(d.cycles)}</span><span>kandidat {formatCount(d.candidates)}</span><span>tutup {formatCount(d.closed)}</span><span>stuck {formatCount(d.stuck)}</span></div>

      {idle && (
        <p className="terminal-note">
          Snapshot engine belum memiliki posisi. Kandidat yang lolos uji beli/jual dari server: {formatCount(d.candidates)}.
        </p>
      )}

      {!idle && (
        <div className="terminal-lane-table-scroll"><table className="terminal-table terminal-lane-table">
          <thead>
            <tr>
              <th>Arm</th><th>Token</th><th>Umur</th><th>WETH masuk</th><th>Quote jual · WETH</th><th>PnL</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {d.positions.map((p) => (
              <tr key={`${p.arm}:${p.token}`}>
                <td>{p.arm ?? "—"}</td>
                <td>{p.symbol ?? "—"}</td>
                <td>{formatDuration(finite(p.ageMin) === null ? null : p.ageMin * 60)}</td>
                <td>{formatQuantity(p.entryWeth)}</td>
                <td>{formatQuantity(p.markWeth)}</td>
                <td className={numericTone(p.pnlPct)}>{formatPercent(p.pnlPct)}</td>
                <td>
                  {p.stuck ? "STUCK · " + (p.stuckReason ?? "") : "terbuka · menunggu exit sesuai aturan"}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      {Object.keys(d.byArm ?? {}).length > 0 && (
        <div className="terminal-panel-summary">
          {Object.entries(d.byArm).map(([arm, v]) => (
            <span key={arm} className="terminal-badge">
              arm {arm} · buka {formatCount(v.open)} · tutup {formatCount(v.closed)} · stuck {formatCount(v.stuck)}
            </span>
          ))}
        </div>
      )}

      <div className="terminal-panel-summary terminal-note">
        <span>{d.rule ?? "—"}</span>
        <span>diperbarui {formatUtc(Date.parse(d.updatedAt))}</span>
      </div>
    </section>
  );
}
