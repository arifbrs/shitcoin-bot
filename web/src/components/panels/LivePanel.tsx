import { useEffect, useState } from "react";

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
  useEffect(() => {
    let on = true;
    const load = async () => {
      try {
        const r = await fetch("/api/live");
        const j = (await r.json()) as Live;
        if (on) { setS(j); setErr(null); }
      } catch (e) { if (on) setErr(e instanceof Error ? e.message : String(e)); }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => { on = false; clearInterval(t); };
  }, []);
  if (err) return <div style={{ padding: 12, border: "1px solid #444", borderRadius: 10 }}>LIVE: galat membaca /api/live — {err}</div>;
  if (!s) return <div style={{ padding: 12, border: "1px solid #444", borderRadius: 10 }}>LIVE: memuat…</div>;
  const open = s.positions.length;
  return (
    <div style={{ padding: 14, border: "1px solid #2a7", borderRadius: 12, marginBottom: 14 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ background: "#0a7", color: "#fff", padding: "2px 10px", borderRadius: 999, fontWeight: 700, letterSpacing: 0.5 }}>LIVE</span>
        <span style={{ opacity: 0.75, fontSize: 12 }}>{s.wallet.slice(0, 10)}…{s.wallet.slice(-4)}</span>
        <span>ETH {s.balances.eth.toFixed(6)}</span>
        <span>WETH {s.balances.weth.toFixed(6)}</span>
        <span>USDG {s.balances.usdg.toFixed(4)}</span>
        <span style={{ marginLeft: "auto", opacity: 0.8 }}>{open} posisi live · {s.sells.length} terjual</span>
      </div>
      <div style={{ marginTop: 10 }}>
        {open === 0 ? (
          <div style={{ opacity: 0.7 }}>Tidak ada posisi live terbuka.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead><tr style={{ textAlign: "left", opacity: 0.7 }}><th>token</th><th>notional</th><th>umur</th><th>alasan belum dijual</th></tr></thead>
            <tbody>
              {s.positions.map((p) => (
                <tr key={p.token} style={{ borderTop: "1px solid #333" }}>
                  <td style={{ padding: "4px 0" }}>{p.symbol ?? p.token.slice(0, 10)}</td>
                  <td>${Number(p.notionalUsd ?? 0).toFixed(2)}</td>
                  <td>{p.ageMin >= 60 ? (p.ageMin / 60).toFixed(1) + " jam" : p.ageMin.toFixed(0) + " menit"}</td>
                  <td style={{ color: p.paperHolds ? "#8ab" : "#fb7" }}>{p.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
        biaya nyata: fee pool {(s.costs.poolFeePct * 100).toFixed(2)}% · gas ${s.costs.gasPerSwapUsd.toFixed(4)}/swap — {s.costs.note}
      </div>
    </div>
  );
}
