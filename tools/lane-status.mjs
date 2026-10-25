#!/usr/bin/env node
/**
 * LANE-STATUS (2026-10-24) — bukti HIDUP, bukan label kesehatan.
 *
 * Pelajaran audit: `*-health.json` berisi "RUNNING" walau prosesnya sudah mati berjam-jam
 * (file hanya ditulis saat sukses). Jadi status lane dihitung dari: pid hidup (kill -0),
 * usia heartbeat, dan usia artefak data. Keluar non-zero bila ada lane mati → bisa dipakai
 * watchdog/cron. Tanpa argumen: cetak ringkasan + keluar 0/1.
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const LOG = "logs";
const now = Date.now();
const ageMin = (p) => (existsSync(p) ? (now - statSync(p).mtimeMs) / 60000 : null);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let failures = 0;
const line = (ok, name, detail) => { if (!ok) failures++; console.log(`${ok ? "✓" : "✘"} ${name.padEnd(28)} ${detail}`); };

// 1) Supervisors (lock files berisi pid supervisor).
for (const [name, lockFile] of [
  ["gmgn supervisor", "gmgn-observations/supervisor.lock"],
  ["hunter supervisor", "hunter-supervisor.lock"],
]) {
  const p = join(LOG, lockFile);
  if (!existsSync(p)) { line(false, name, "lock tidak ada — tidak jalan"); continue; }
  const pid = Number(readFileSync(p, "utf8").trim());
  line(pidAlive(pid), name, `pid ${pid} ${pidAlive(pid) ? "hidup" : "MATI"}`);
}

// 2) Health files: pid dari isi + usia tulisan (bukan field status).
for (const [name, f, maxAgeMin] of [
  ["gmgn collector", "gmgn-observations/collector-health.json", 40],
  ["gmgn tracker", "gmgn-observations/tracker-health.json", 6],
]) {
  const p = join(LOG, f);
  if (!existsSync(p)) { line(false, name, "health tidak ada"); continue; }
  const h = JSON.parse(readFileSync(p, "utf8"));
  const age = ageMin(p);
  const alive = typeof h.pid === "number" && pidAlive(h.pid);
  line(alive && age != null && age <= maxAgeMin, name, `pid ${h.pid} ${alive ? "hidup" : "MATI"} · tulis ${age == null ? "?" : age.toFixed(1)}m lalu (batas ${maxAgeMin}m)`);
}

// 3) Paper engine: ledger hari ini (atau kemarin jika baru lewat tengah malam) harus segar < 15 menit.
const day = (d) => new Date(d).toISOString().slice(0, 10);
for (const off of [0, 1]) {
  const p = join(LOG, "rhpaper", `ledger-${day(now - off * 864e5)}.jsonl`);
  const a = ageMin(p);
  if (a != null) { line(a <= 15, "rhpaper engine", `ledger ${p.split("/").pop()} tulis ${a.toFixed(1)}m lalu (batas 15m)` + (a > 15 ? " — sejak 2026-10-25: RPC Robinhood diblokir DNS ISP (BLOCKED_EXTERNAL), pulih sendiri saat ISP berhenti" : "")); break; }
  if (off === 1) line(false, "rhpaper engine", "tidak ada ledger 2 hari terakhir");
}

// 3b) Pump-caller observer (riset prospektif H2): journal harus segar < 10 menit.
// BLOCKED_EXTERNAL rhpaper tidak menyentuh lane ini (Solana RPC, bukan Robinhood).
const pj = join(LOG, "pump-caller", "journal.jsonl");
const pja = ageMin(pj);
line(pja != null && pja <= 10, "pump:watch observer", pja == null ? "journal tidak ada — tidak jalan" : `journal tulis ${pja.toFixed(1)}m lalu (batas 10m)`);

// 4) Dashboard: proses server.ts hidup (pola baris perintah, bukan nama samar).
let dash = false;
try {
  const out = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" });
  dash = out.includes("tsx src/server.ts");
} catch { /* ps gagal = anggap mati */ }
line(dash, "dashboard (server.ts)", dash ? "proses ada" : "proses tidak ditemukan");

// 5) Live bridge: TIDAK dianggap wajib hidup — justru dilaporkan kalau JALAN (supervisor live-exits).
try {
  const out = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" });
  const running = out.includes("run-live-exits-supervised.sh");
  line(true, "live-exits supervisor", running ? "JALAN — pembelian otomatis tunduk gerbang LIVE_TRADING_CONFIRMED" : "tidak jalan (aman default)");
} catch { /* abaikan */ }

console.log(failures === 0 ? "SEMUA LANE OK" : `${failures} LANE BERMASALAH`);
process.exit(failures === 0 ? 0 : 1);
