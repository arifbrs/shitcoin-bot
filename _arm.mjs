import { existsSync, readFileSync, readdirSync } from "node:fs";
const files = readdirSync("logs/rhpaper").filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
const closes = [];
for (const f of files) for (const l of readFileSync("logs/rhpaper/" + f, "utf8").split("\n")) {
  if (!l.trim()) continue;
  try { const j = JSON.parse(l); if (j.action === "CLOSE") closes.push(j); } catch { /* lewati */ }
}
console.log("  total penutupan: " + closes.length);
const arms = [...new Set(closes.map((c) => c.arm ?? "?"))].sort();
for (const a of arms) {
  const list = closes.filter((c) => (c.arm ?? "?") === a);
  const nets = list.map((c) => Number(c.netPct ?? c.grossPct ?? 0));
  const wins = nets.filter((x) => x > 0).length;
  const avg = nets.reduce((x, y) => x + y, 0) / list.length;
  const best = Math.max(...nets), worst = Math.min(...nets);
  const held = list.map((c) => Number(c.heldMin ?? 0)).reduce((x, y) => x + y, 0) / list.length;
  const whys = {};
  for (const c of list) whys[c.why ?? "?"] = (whys[c.why ?? "?"] || 0) + 1;
  console.log("  arm " + a + " · n=" + list.length + " · winrate " + ((wins / list.length) * 100).toFixed(0) + "%" +
    " · rata2 net " + avg.toFixed(2) + "% · terbaik " + best.toFixed(2) + "% · terburuk " + worst.toFixed(2) + "%" +
    " · rata2 tahan " + held.toFixed(0) + " mnt");
  console.log("      alasan keluar: " + Object.entries(whys).map(([k, v]) => k + "=" + v).join(" · "));
}
const tokAgg = {};
for (const c of closes) { const k = c.symbol ?? "?"; (tokAgg[k] ??= []).push(Number(c.netPct ?? 0)); }
console.log("  per token (rata2 net): " + Object.entries(tokAgg).map(([k, v]) => k + " " + (v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) + "% (n=" + v.length + ")").join(" · "));
