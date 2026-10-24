#!/usr/bin/env node
/**
 * PELUNCUR LANE TERDETACH (FINAL) — `node deploy/start-lanes-detached.mjs`.
 * Akar masalah: lane yang di-nohup dari sesi terminal/agen tetap dalam process-group sesi itu;
 * saat sesi berakhir, killpg membunuh SEMUA lane serentak (outage 10-24). setsid tidak ada di
 * macOS; launchctl submit diblokir TCC (folder Documents). Solusi: spawn Node `detached:true`
 * = sesi proses BARU (PGID sendiri) + unref — kebal killpg sesi, TCC mewarisi konteks pemanggil.
 * Idempoten: proses supervisor yang masih hidup tidak diluncurkan ulang.
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const LANES = [
  ["gmgn", "run-gmgn-supervised.sh"],
  ["rhpaper", "run-rhpaper-supervised.sh"],
  ["hunter", "run-hunter-supervised.sh"],
  ["dash", "run-dashboard-supervised.sh"],
];

const running = (pattern) => {
  try { return execSync(`pgrep -f "${pattern}"`, { encoding: "utf8" }).trim().length > 0; } catch { return false; }
};

for (const [name, script] of LANES) {
  if (running(script)) { console.log(`  ${name}: sudah jalan — lewati`); continue; }
  const out = openSync(join(REPO, "logs", `lc-${name}.out`), "a");
  const err = openSync(join(REPO, "logs", `lc-${name}.err`), "a");
  const child = spawn("/bin/bash", [join(REPO, script)], { detached: true, stdio: ["ignore", out, err], cwd: REPO });
  child.unref();
  console.log(`  ${name}: diluncurkan terdetach (pid ${child.pid}, PGID baru)`);
}
console.log("verifikasi: node tools/lane-status.mjs");
