/**
 * ANALISA TERKINI — loop analisa berkelanjutan (default tiap 12 menit). Nol panggilan API
 * (kecuali 1 query DoH ringan utk cek blokir ISP). Read-only.
 *
 * Owner (2026-10-08): "kamu pantau analisa dong jangan berhenti!" — data sudah terkumpul terus
 * (RH paper, GMGN watch), tapi lapisan INTERPRETASI masih harian (review 08:00). Proses ini
 * menutup celah itu: setiap siklus ia membaca state + log terbaru, menghitung DELTA sejak digest
 * sebelumnya, dan menulis logs/analisa-terkini.md (selalu ditimpa) + satu baris durabel ke
 * logs/analisa-<tanggal>.jsonl. Jadi "apa yang berubah" selalu terjawab, bukan menunggu besok.
 *
 * Run: npm run analisa            (sekali)
 *      npm run analisa -- --loop  (terus-menerus; dipakai supervisor)
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { observationReport } from "./gmgn-observation-report.js";

const LOOP = process.argv.includes("--loop");
const EVERY_MS = (() => { const n = Number(process.env.ANALISA_EVERY_MS); return Number.isFinite(n) && n >= 60_000 ? n : 12 * 60_000; })();
const STATE_PATH = join(config.logDir, "analisa-state.json");
const OUT_MD = join(config.logDir, "analisa-terkini.md");

interface Snap { at: number; closedTotal: number; closedPnl: number; signals: number; walletsScored: number; honeypotBlocks: number }
const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[Math.floor(p * (s.length - 1))] as number) : NaN; };
const money = (n: number): string => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`;

function rowsOf(prefix: string, todayOnly = true): Array<Record<string, unknown>> {
  const day = new Date().toISOString().slice(0, 10);
  const files = (() => {
    try { return readdirSync(config.logDir).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl") && (!todayOnly || f.includes(day))); } catch { return []; }
  })();
  const out: Array<Record<string, unknown>> = [];
  for (const f of files) {
    try {
      for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* baris terpotong */ }
      }
    } catch { /* lewati */ }
  }
  return out;
}

async function okxBlocked(): Promise<string> {
  try {
    const sys = await (await import("node:dns")).promises.resolve4("web3.okx.com");
    const dohRes = await fetch("https://cloudflare-dns.com/dns-query?name=web3.okx.com&type=A", { headers: { accept: "application/dns-json" } });
    const j = (await dohRes.json()) as { Answer?: Array<{ type: number; data: string }> };
    const real = (j.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
    if (!sys.length || !real.length) return "tak bisa disimpulkan";
    return sys.some((ip) => real.includes(ip)) ? "normal" : `DNS HIJACK aktif (sistem ${sys[0]} vs asli ${real[0]}) — lane OKX mati; remediasi: npm run okx:netcheck`;
  } catch { return "tak bisa diperiksa"; }
}

async function digest(): Promise<void> {
  const now = Date.now();
  const prev: Snap | null = existsSync(STATE_PATH) ? (JSON.parse(readFileSync(STATE_PATH, "utf8")) as Snap) : null;
  const lines: string[] = [];
  const say = (s = ""): void => { lines.push(s); console.log(s); };
  const stamp = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

  // ── LANE ROBINHOOD ─────────────────────────────────────────
  const rh = existsSync(join(config.logDir, "rh-paper-state.json"))
    ? (JSON.parse(readFileSync(join(config.logDir, "rh-paper-state.json"), "utf8")) as {
        cohort?: string; cycles?: number;
        variants?: Record<string, { equityUsd?: number; life?: number; lifeHistory?: Array<{ endEquityUsd: number }>; positions?: Array<{ notionalUsd?: number; lastMarkAt?: number }>; bankruptAt?: number; trades?: number; wins?: number; losses?: number }>;
      })
    : null;
  const closes = rowsOf("rh-paper-").filter((r) => r["action"] === "RH_CLOSE");
  const closedPnl = closes.reduce((a, r) => a + (typeof r["pnlUsd"] === "number" ? r["pnlUsd"] : 0), 0);
  const last2h = closes.filter((r) => now - (Date.parse(String(r["ts"] ?? "")) || 0) <= 7_200_000);
  const last2hPnl = last2h.reduce((a, r) => a + (typeof r["pnlUsd"] === "number" ? r["pnlUsd"] : 0), 0);
  const exits: Record<string, number> = {};
  for (const r of last2h) exits[String(r["reason"] ?? "?")] = (exits[String(r["reason"] ?? "?")] ?? 0) + 1;

  // ── LANE GMGN ──────────────────────────────────────────────
  // DUA stream: `events-` (gmgn-full-watch: sinyal, trade terpantau) DAN `rh-events-` (lane RH:
  // honeypot-block, rug-signal enrich). Sebelum ini hanya `events-` yang dibaca, sehingga blokir
  // honeypot & flag rug tampak selalu 0 — bagian ringkasan yang justru paling penting.
  const ev = [...rowsOf("events-", false), ...rowsOf("rh-events-", false)];
  const signals = ev.filter((r) => r["type"] === "gmgn-signal");
  const signals2h = signals.filter((r) => now - (Date.parse(String(r["ts"] ?? "")) || 0) <= 7_200_000);
  const byType: Record<number, number> = {};
  for (const s of signals2h) { const t = Number(s["signalType"] ?? 0); byType[t] = (byType[t] ?? 0) + 1; }
  const hpBlocks = ev.filter((r) => r["type"] === "rh-honeypot-block" || r["type"] === "gmgn-honeypot-block");
  const watched = ev.filter((r) => r["type"] === "gmgn-watched-trade" && now - (Date.parse(String(r["ts"] ?? "")) || 0) <= 7_200_000);
  const enrich = ev.filter((r) => r["type"] === "rh-gmgn-enrich");
  const flags: Record<string, number> = {};
  for (const e of enrich) for (const f of (e["flags"] as string[] | undefined) ?? []) flags[f] = (flags[f] ?? 0) + 1;
  const wq = existsSync(join(config.logDir, "gmgn-full-watch-state.json"))
    ? Object.keys((JSON.parse(readFileSync(join(config.logDir, "gmgn-full-watch-state.json"), "utf8")) as { walletQuality?: Record<string, unknown> }).walletQuality ?? {}).length
    : 0;
  let quota429 = 0;
  try {
    const out = readFileSync(join(config.logDir, "gmgn-supervisor.out"), "utf8");
    quota429 = out.split("\n").slice(-400).filter((l) => l.includes("429")).length;
  } catch { /* belum ada */ }
  const latestCycleAt = Math.max(0, ...ev.filter((r) => r["type"] === "gmgn-full-cycle").map((r) => Date.parse(String(r["ts"] ?? "")) || 0));

  // ── DELTA sejak digest sebelumnya ──────────────────────────
  const dClosed = closes.length - (prev?.closedTotal ?? closes.length);
  const dPnl = closedPnl - (prev?.closedPnl ?? closedPnl);
  const dSignals = signals.length - (prev?.signals ?? signals.length);
  const dWallets = wq - (prev?.walletsScored ?? wq);
  const dBlocks = hpBlocks.length - (prev?.honeypotBlocks ?? hpBlocks.length);
  const agoMin = prev ? Math.max(1, Math.round((now - prev.at) / 60_000)) : 0;

  say(`═══ ANALISA TERKINI ${stamp} — kohort ${rh?.cohort ?? "?"} · siklus ${rh?.cycles ?? 0} ═══`);
  say(prev
    ? `Δ sejak ${agoMin} menit lalu: ${dClosed >= 0 ? "+" : ""}${dClosed} trade tutup (${money(dPnl)}) · ${dSignals >= 0 ? "+" : ""}${dSignals} sinyal GMGN · ${dWallets >= 0 ? "+" : ""}${dWallets} wallet diskor${dBlocks ? ` · ${dBlocks} honeypot diblokir` : ""}`
    : "(digest pertama — delta akan muncul mulai siklus berikutnya)");

  say("\n── LANE ROBINHOOD (10 varian, risk $5/trade)");
  if (!rh?.variants) say("  state belum ada");
  else {
    const entries = Object.entries(rh.variants);
    const bankrupt = entries.filter(([, v]) => v.bankruptAt != null);
    const lives = entries.filter(([, v]) => (v.life ?? 1) > 1);
    const openAll = entries.flatMap(([, v]) => v.positions ?? []);
    const stale = openAll.filter((p) => now - (p.lastMarkAt ?? 0) > 10 * 60_000).length;
    const exposureOver = entries.filter(([, v]) => (v.positions ?? []).reduce((a, p) => a + (p.notionalUsd ?? 0), 0) > Math.max(v.equityUsd ?? 0, 0.01));
    const eqNow = entries.reduce((a, [, v]) => a + (v.equityUsd ?? 0), 0);
    const eqCum = entries.reduce((a, [, v]) => a + (v.equityUsd ?? 0) - 100 + (v.lifeHistory ?? []).reduce((b, l) => b + (l.endEquityUsd - 100), 0), 0);
    say(`  equity life-berjalan Σ $${eqNow.toFixed(2)} · kumulatif semua life Σ ${money(eqCum)}`);
    say(`  bankrut & menunggu/restart: ${bankrupt.length ? bankrupt.map(([id, v]) => `${id}(life ${v.life})`).join(", ") : "tidak ada"} · sudah pernah restart: ${lives.map(([id]) => id).join(", ") || "—"}`);
    say(`  posisi terbuka ${openAll.length} · mark basi >10m: ${stale} · exposure > equity: ${exposureOver.length ? exposureOver.map(([id, v]) => `${id} ($${(v.positions ?? []).reduce((a, p) => a + (p.notionalUsd ?? 0), 0).toFixed(0)} > $${(v.equityUsd ?? 0).toFixed(0)})`).join(", ") : "tidak ada"}`);
    say(`  2 jam terakhir: ${last2h.length} tutup (${last2h.filter((r) => (r["pnlUsd"] as number) >= 0).length}W/${last2h.filter((r) => (r["pnlUsd"] as number) < 0).length}L, ${money(last2hPnl)}) · exit ${Object.entries(exits).map(([k, n]) => `${k}=${n}`).join(" ") || "—"}`);
  }

  say("\n── LANE GMGN (sinyal, wallet, rug-signal)");
  say(`  sinyal 2 jam: ${signals2h.length} (${Object.entries(byType).map(([t, n]) => `t${t}=${n}`).join(" ") || "—"}) · trade terpantau: ${watched.length} · honeypot diblokir total: ${hpBlocks.length}`);
  say(`  wallet diskor: ${wq} · token diperkaya (rug-signal): ${new Set(enrich.map((e) => e["token"])).size} · flag terkumpul: ${Object.entries(flags).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f, n]) => `${f}(${n})`).join(" ") || "—"}`);
  say(`  siklus GMGN terakhir: ${latestCycleAt ? new Date(latestCycleAt).toISOString() + ` (${((now - latestCycleAt) / 60_000).toFixed(0)}m lalu)` : "belum ada"}${!latestCycleAt || now - latestCycleAt > 30 * 60_000 ? " — STALE, jangan anggap monitoring sehat" : ""}`);
  say(`  log GMGN: ${quota429} baris 429 di 400 baris terakhir; nol 429 TIDAK membuktikan kuota longgar atau proses aktif.`);
  for (const line of observationReport(now)) say(line);

  say("\n── LANE DEXSCREENER (13 endpoint, siklus 5 menit)");
  {
    const dx = [...rowsOf("events-")].filter((r) => String(r["type"] ?? "").startsWith("dex-"));
    const c24 = dx.filter((r) => now - (Date.parse(String(r["ts"] ?? "")) || 0) <= 86_400_000);
    const byType: Record<string, number> = {};
    for (const r of c24) byType[String(r["type"])] = (byType[String(r["type"])] ?? 0) + 1;
    const lastCycle = dx.filter((r) => r["type"] === "dex-cycle").slice(-1)[0];
    const st = existsSync(join(config.logDir, "dex-full-state.json"))
      ? (JSON.parse(readFileSync(join(config.logDir, "dex-full-state.json"), "utf8")) as { watch?: Record<string, unknown> })
      : null;
    say(`  event 24 jam: ${Object.entries(byType).map(([t, n]) => `${t.replace("dex-", "")}=${n}`).join(" ") || "—"}`);
    if (lastCycle) say(`  siklus terakhir: ${lastCycle["calls"]} call ${((Number(lastCycle["ms"]) || 0) / 1000).toFixed(1)}s · watchlist ${lastCycle["watch"]} token`);
    if (st?.watch) say(`  watchlist tersimpan: ${Object.keys(st.watch).length} token (snapshot terakhir di state, bukan event)`);
  }

  say("\n── LANE OKX (strict-paper uang kertas + observasi)");
  {
    const statePath = join(config.logDir, "okx-strict-paper-v2-state.json");
    if (!existsSync(statePath)) say("  strict-paper: state belum ada");
    else {
      const sp = JSON.parse(readFileSync(statePath, "utf8")) as {
        positions?: Record<string, { status?: string; policyVersion?: number; source?: string }>;
        budget?: { premiumUsed?: number; basicUsed?: number };
        primed?: { scanner?: boolean; ranking?: boolean; signal?: boolean; trackers?: string[] };
        updatedAt?: string;
      };
      const pos = Object.values(sp.positions ?? {});
      const open = pos.filter((p) => p.status === "OPEN");
      const closed = pos.filter((p) => p.status === "CLOSED");
      const staleMin = Math.round((now - (Date.parse(sp.updatedAt ?? "") || now)) / 60_000);
      say(`  posisi: ${open.length} terbuka / ${closed.length} tertutup (v${open[0]?.policyVersion ?? "?"}) · state terakhir ditulis ${staleMin}m lalu`);
      say(`  budget: premium ${sp.budget?.premiumUsed ?? 0}/10000 · basic ${sp.budget?.basicUsed ?? 0}/25000 · primed scan=${sp.primed?.scanner ? "✓" : "✗"} rank=${sp.primed?.ranking ? "✓" : "✗"} signal=${sp.primed?.signal ? "✓" : "✗"} tracker=${sp.primed?.trackers?.length ?? 0} wallet`);
    }
    const ledger = join(config.logDir, "okx-strict-paper-v2.jsonl");
    if (existsSync(ledger)) {
      const tail = readFileSync(ledger, "utf8").slice(-200_000).split("\n").filter(Boolean);
      const kinds: Record<string, number> = {};
      for (const l of tail) { try { const r = JSON.parse(l) as { type?: string }; kinds[String(r.type)] = (kinds[String(r.type)] ?? 0) + 1; } catch { /* baris terpotong */ } }
      say(`  ledger (${tail.length} baris terakhir, hash-chain): ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}=${n}`).join(" ") || "—"}`);
    }
    const okxEv = [...rowsOf("events-")].filter((r) => String(r["type"] ?? "").startsWith("okx-"));
    const okx24 = okxEv.filter((r) => now - (Date.parse(String(r["ts"] ?? "")) || 0) <= 86_400_000);
    const evKinds: Record<string, number> = {};
    for (const r of okx24) evKinds[String(r["type"]).replace("okx-", "")] = (evKinds[String(r["type"]).replace("okx-", "")] ?? 0) + 1;
    say(`  observasi 24 jam: ${Object.entries(evKinds).map(([k, n]) => `${k}=${n}`).join(" ") || "—"}`);
  }

  say("\n── JARINGAN");
  const okx = await okxBlocked();
  say(`  OKX: ${okx}`);

  say(`\n(next digest ~${Math.round(EVERY_MS / 60_000)} menit lagi · file ini selalu ditimpa: ${OUT_MD})`);

  try { writeFileSync(OUT_MD, lines.join("\n") + "\n"); } catch { /* best-effort */ }
  try {
    appendFileSync(join(config.logDir, `analisa-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify({
      ts: new Date().toISOString(), closedTotal: closes.length, closedPnl: Number(closedPnl.toFixed(2)),
      signals: signals.length, walletsScored: wq, honeypotBlocks: hpBlocks.length,
      rhEquityLife: rh ? Object.values(rh.variants ?? {}).reduce((a, v) => a + (v.equityUsd ?? 0), 0) : null,
    }) + "\n");
  } catch { /* best-effort */ }
  try { writeFileSync(STATE_PATH, JSON.stringify({ at: now, closedTotal: closes.length, closedPnl, signals: signals.length, walletsScored: wq, honeypotBlocks: hpBlocks.length })); } catch { /* best-effort */ }
}

async function main(): Promise<void> {
  console.log(`[analisa] digest tiap ${Math.round(EVERY_MS / 60_000)} menit${LOOP ? " (loop)" : ""}. Read-only, nol API (1 DoH cek jaringan).`);
  await digest().catch((e) => console.warn(`[analisa] gagal: ${(e as Error).message}`));
  if (!LOOP) return;
  setInterval(() => void digest().catch((e) => console.warn(`[analisa] gagal: ${(e as Error).message}`)), EVERY_MS);
}

void main();
