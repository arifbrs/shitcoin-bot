import { existsSync, readFileSync } from "node:fs";
const d = new Date().toISOString().slice(0, 10);

console.log("══ HUNTER (" + d + ") ══");
const hf = "logs/hunter/gmgnimportall-" + d + ".json";
if (!existsSync(hf)) console.log("  (belum ada)");
else {
  const j = JSON.parse(readFileSync(hf, "utf8"));
  const tiers = ["S", "A", "B", "C"].map((t) => t + "=" + j.tokens.filter((x) => x.tier === t).length).join(" ");
  console.log("  token lolos filter: " + j.tokens.length + " · tier " + tiers);
  for (const t of j.tokens.slice(0, 6)) console.log("   " + String(t.token.symbol).padEnd(9) + " mcap $" + t.token.mcapUsd.toFixed(0) + " · liq $" + t.token.liquidityUsd.toFixed(0) + " · tier " + t.tier);
  if (j.variants) console.log("  varian: " + Object.entries(j.variants).map(([k, a]) => k + "=" + a.filter((x) => x.smart > 0).length + " token").join(" · "));
}

console.log("══ PAPER 1:1 ══");
try {
  const r = await fetch("http://127.0.0.1:4317/api/paper");
  const j = await r.json();
  console.log("  siklus " + j.cycles + " · kandidat " + j.candidates + " · posisi " + j.positions.length + " · tutup " + j.closed + " · stuck " + j.stuck);
  for (const p of j.positions) console.log("   " + p.arm + " " + String(p.symbol).padEnd(8) + " PnL " + (p.pnlPct === null ? "tanpa quote" : p.pnlPct.toFixed(2) + "%"));
} catch { console.log("  (dashboard tak terbaca)"); }

console.log("══ LIVE ══");
const lf = "logs/rh-live-" + d + ".jsonl";
if (!existsSync(lf)) console.log("  (belum ada aksi)");
else {
  const rows = readFileSync(lf, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const c = {};
  for (const r of rows) c[r.action] = (c[r.action] || 0) + 1;
  console.log("  " + JSON.stringify(c));
  const fills = rows.filter((r) => r.action === "LIVE_FILL" || r.action === "LIVE_BUY");
  console.log("  pembelian: " + (fills.map((f) => f.symbol).join(", ") || "(belum ada)"));
}
