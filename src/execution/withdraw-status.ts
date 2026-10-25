/**
 * STATUS WITHDRAW (FINAL) — `npm run withdraw:status`. Read-only, nol eksekusi, tanpa rahasia.
 * Menjawab persis: mode apa yang ter-deploy, apakah policy siap, apa yang masih ditunggu operator.
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { withdrawModeFromEnv, isSolanaAddress } from "./withdraw-gate.js";

const env = process.env as Record<string, string | undefined>;
const mode = withdrawModeFromEnv(env);
const allowlist = (env.WITHDRAW_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const lines: string[] = ["═══ STATUS WITHDRAW (read-only) ═══"];
if (typeof mode !== "string") {
  lines.push(`WITHDRAW_MODE tidak sah: ${(mode as { error: string }).error} — perbaiki .env`);
} else {
  lines.push(`mode ter-deploy : ${mode}${mode === "legacy" ? "  ← RISIKO TERBUKA: sesi sah bisa tarik ke mana pun, tanpa plafon" : ""}`);
  lines.push(`allowlist       : ${allowlist.length === 0 ? "(kosong)" : `${allowlist.length} alamat terkonfigurasi (disembunyikan)`}${allowlist.length && !allowlist.every(isSolanaAddress) ? "  ⚠ ADA ALAMAT TIDAK SAH" : ""}`);
  lines.push(`plafon per-tx   : ${env.WITHDRAW_MAX_SOL ?? "(tidak diset)"}`);
  lines.push(`plafon harian   : ${env.WITHDRAW_DAILY_MAX_SOL ?? "(tidak diset)"}`);
  if (mode === "policy" && allowlist.length === 0) lines.push("⚠ policy TANPA allowlist = fail-closed: SEMUA penarikan ditolak (perilaku benar, konfigurasi belum selesai)");
  if (mode === "legacy") lines.push("aktivasi policy : salin deploy/withdraw-policy.env.template ke .env (isi alamat tepercaya) + restart dashboard; rollback = hapus baris");
}
const auditFile = `logs/events-${new Date().toISOString().slice(0, 10)}.jsonl`;
lines.push(`audit hari ini  : ${existsSync(auditFile) ? `${readFileSync(auditFile, "utf8").split("\n").filter((l) => l.includes('"withdraw-audit"')).length} percobaan tercatat` : "belum ada percobaan"}`);
console.log(lines.join("\n"));
