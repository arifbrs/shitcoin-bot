/**
 * GERBANG WITHDRAW (round-3 A1) — pengerasan ADDITIF, default OFF (perilaku lama utuh sampai
 * operator mengisi env). Keputusan desain tetap milik operator: modul ini tidak mengubah
 * perilaku aktif tanpa otorisasi; ia hanya membuat pilihan itu BISA diterapkan dengan aman.
 *
 * Env (semua opsional):
 *   WITHDRAW_ALLOWLIST=0x..,0x..  — tujuan di luar daftar DITOLAK (kosong = tanpa allowlist)
 *   WITHDRAW_MAX_SOL=0.05         — plafon per penarikan (kosong = tanpa plafon; "all" tetap boleh)
 *
 * Pemeriksaan yang SELALU aktif (tidak butuh env): alamat tujuan sah, jumlah finite > 0,
 * jumlah ≤ saldo − fee. Kasus NaN lama lolos dua guard (temuan F9) — kini ditolak eksplisit.
 */
export const SOL_DECIMALS = 9;

export interface WithdrawRequest { destination: string; amount: number | "all"; balanceSol: number; feeSol: number }
export interface WithdrawPolicy { allowlist: string[]; maxSol: number | null; origin: string | null; expectedOrigin: string | null }

export type WithdrawDecision = { ok: true; amountSol: number } | { ok: false; reason: string };

/** Alamat Solana base58 (ed25519 pubkey = 32 byte → 43–44 karakter base58 tanpa 0/O/I/l). */
export function isSolanaAddress(v: unknown): v is string {
  return typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}

export function validateWithdraw(req: WithdrawRequest, policy: WithdrawPolicy): WithdrawDecision {
  // ORIGIN: hanya ditolak bila browser mengirim Origin DAN ia tidak cocok dengan host request
  // (CSRF lintas-origin). Klien tanpa Origin header (curl/CLI operator) tetap jalan.
  if (policy.origin != null && policy.expectedOrigin != null && policy.origin !== policy.expectedOrigin) {
    return { ok: false, reason: `origin tidak cocok: ${policy.origin} ≠ ${policy.expectedOrigin}` };
  }
  if (!isSolanaAddress(req.destination)) return { ok: false, reason: "alamat tujuan bukan pubkey Solana yang sah" };
  if (policy.allowlist.length > 0 && !policy.allowlist.includes(req.destination)) {
    return { ok: false, reason: "tujuan di luar WITHDRAW_ALLOWLIST" };
  }
  if (!Number.isFinite(req.balanceSol) || req.balanceSol < 0) return { ok: false, reason: "saldo dompet tidak terbaca — TOLAK (fail-closed)" };
  if (!Number.isFinite(req.feeSol) || req.feeSol < 0) return { ok: false, reason: "estimasi fee tidak valid — TOLAK (fail-closed)" };
  const spendable = req.balanceSol - req.feeSol;
  if (spendable <= 0) return { ok: false, reason: "saldo tidak menutup fee" };
  const amountSol = req.amount === "all" ? spendable : req.amount;
  if (!Number.isFinite(amountSol) || amountSol <= 0) return { ok: false, reason: "jumlah tidak valid (NaN/≤0 ditolak eksplisit — temuan F9)" };
  if (amountSol > spendable) return { ok: false, reason: `jumlah ${amountSol} > spendable ${spendable}` };
  if (policy.maxSol != null && amountSol > policy.maxSol) return { ok: false, reason: `jumlah ${amountSol} > plafon WITHDRAW_MAX_SOL ${policy.maxSol}` };
  return { ok: true, amountSol };
}

/** Bangun policy dari env — nilai tak-sah DITOLAK dengan jelas, bukan didiamkan. */
export function withdrawPolicyFromEnv(env: Record<string, string | undefined>, origin: string | null, expectedOrigin: string | null): WithdrawPolicy | { error: string } {
  let maxSol: number | null = null;
  const rawMax = env.WITHDRAW_MAX_SOL?.trim();
  if (rawMax) {
    const n = Number(rawMax);
    if (!Number.isFinite(n) || n <= 0) return { error: `WITHDRAW_MAX_SOL tidak sah: ${rawMax}` };
    maxSol = n;
  }
  const allowlist = (env.WITHDRAW_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of allowlist) if (!isSolanaAddress(a)) return { error: `WITHDRAW_ALLOWLIST memuat alamat tidak sah: ${a}` };
  return { allowlist, maxSol, origin, expectedOrigin };
}

/**
 * MODE (round-4 A4-audit): kebenaran eksplisit tentang apa yang bisa jalan HARI INI.
 *   "deny"   → SEMUA withdraw ditolak. Default-deny sesungguhnya.
 *   "policy" → wajib allowlist terisi (fail-closed bila kosong); plafon & harian tetap opsional.
 *   "legacy" → perilaku lama: auth cookie saja; tanpa allowlist/plafon, withdraw MANA PUN bisa
 *              jalan. INI DEFAULT SAAT INI — dipilih agar tidak mengubah jalur dana tanpa
 *              otorisasi operator (aturan auditor). Operator memindahkan default ke "deny"/"policy"
 *              lewat SATU env; rollback = hapus env.
 */
export type WithdrawMode = "deny" | "policy" | "legacy";
export function withdrawModeFromEnv(env: Record<string, string | undefined>): WithdrawMode | { error: string } {
  const raw = (env.WITHDRAW_MODE ?? "legacy").trim();
  if (raw === "deny" || raw === "policy" || raw === "legacy") return raw;
  return { error: `WITHDRAW_MODE tidak sah: ${raw} (deny|policy|legacy)` };
}

export function applyWithdrawMode(mode: WithdrawMode, decision: WithdrawDecision, policy: WithdrawPolicy): WithdrawDecision {
  if (mode === "deny") return { ok: false, reason: "WITHDRAW_MODE=deny — semua penarikan ditolak (default-deny)" };
  if (mode === "policy" && policy.allowlist.length === 0) {
    return { ok: false, reason: "WITHDRAW_MODE=policy tanpa WITHDRAW_ALLOWLIST — fail-closed (isi allowlist atau pindah mode)" };
  }
  return decision;
}

/** Plafon harian opsional: total SENT hari ini (dari baris audit withdraw-audit) + rencana. */
export function withdrawnTodaySol(auditRowsText: string): number {
  let sum = 0;
  for (const line of auditRowsText.split("\n")) {
    if (!line.includes('"withdraw-audit"') || !line.includes('"SENT"')) continue;
    try {
      const row = JSON.parse(line) as { sentSol?: number };
      if (typeof row.sentSol === "number" && Number.isFinite(row.sentSol) && row.sentSol > 0) sum += row.sentSol;
    } catch { /* baris rusak dihitung nol — audit bukan sumber dana */ }
  }
  return sum;
}
