/** Round-3 A5: pemulihan crash, exit parsial, ledger terpotong, EXIT_ONLY, duplikasi baris. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, eq, assert } from "../testing/harness.js";
import { loadLiveRows, reconstructPositions, reconcilePositions, planActions, positionIdFor } from "./live-positions.js";

const TOKEN = "0x156e175dd063a8ce274c50654ef40e0032b3fbcf";
const OTHER = "0x47f93d52cbec7c6d2cfc080e154002370a60daea";
const GHOST = "0x822cc93ffd030293e9842c30bbd678f530701867";
const WALLET = "0x629Ec42444A43A0E02A572587E3A49904542F4E8";

function ledger(dir: string, rows: Array<Record<string, unknown>>, opts?: { truncateTail?: boolean }): void {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (opts?.truncateTail ? "\n{\"ts\":9,\"action\":\"LIVE_F" : "\n");
  writeFileSync(join(dir, "rh-live-2026-10-24.jsonl"), body);
}

test("A5 crash-recovery: fill tercatat dua kali (append ganda setelah crash) = satu posisi, ID sama", () => {
  const row = { ts: 1000, action: "LIVE_FILL", ok: true, token: TOKEN, symbol: "AVGO", txHash: "0xabc", amountOutRaw: "5000", strategy: "v42", notionalUsd: 2.5 };
  const positions = reconstructPositions([
    { ts: 1000, day: "d", file: "f", action: "LIVE_FILL", ok: true, raw: row },
    { ts: 1000, day: "d", file: "f", action: "LIVE_FILL", ok: true, raw: row }, // hasil crash-retry
  ]);
  const p = positions.get(TOKEN)!;
  eq(p.positionId, positionIdFor(TOKEN, "0xabc", 1000, "5000"), "ID deterministik dari bukti");
  eq(p.txHash, "0xabc", "duplikat tidak membuat posisi kedua/berbeda");
  eq(positions.size, 1, "satu posisi, bukan dua");
});

test("A5 exit parsial: jual tercatat ok TETAPI saldo masih ada → status OPEN (bukan CLOSED_CONFIRMED)", () => {
  const rows: Parameters<typeof reconstructPositions>[0] = [
    { ts: 1000, day: "d", file: "f", action: "LIVE_FILL", ok: true, raw: { token: TOKEN, txHash: "0xa", amountOutRaw: "2624563836639428744132977" } },
    { ts: 2000, day: "d", file: "f", action: "LIVE_SELL", ok: true, raw: { token: TOKEN } }, // jual "ok" 10-19 (parsial, tanpa hash)
  ];
  const positions = reconstructPositions(rows);
  const { reconciled } = reconcilePositions(positions, new Map([[TOKEN, { ok: true, raw: 2623563836639428744132977n } as const]]));
  const p = reconciled[0]!;
  eq(p.status, "OPEN", "saldo >0 = TIDAK boleh CLOSED_CONFIRMED, apa pun catatan jual");
  assert(p.soldAt != null, "catatan jual tetap tersimpan untuk investigasi");
  // Rencana: posisi seperti ini tetap diusulkan keluar (paper tak memegang + umur).
  const plan = planActions({ rows, reconciled, untracked: [], paperHeldTokens: new Set<string>(), paperOpens: [], now: 999999999, maxPositionAgeMs: 24 * 3_600_000 });
  eq(plan.sells.length, 1, "sisa posisi diusulkan jual");
  eq(plan.sells[0]!.qtyRaw, "2623563836639428744132977", "qty = saldo riil yang tersisa");
});

test("A5 ledger terpotong di tengah baris: dihitung malformed, tidak crash, baris sah tetap terbaca", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-truncated-"));
  ledger(dir, [{ ts: 1000, action: "LIVE_FILL", ok: true, token: TOKEN, txHash: "0xa" }], { truncateTail: true });
  const { rows, malformed } = loadLiveRows(dir);
  eq(rows.length, 1, "baris utuh terbaca");
  eq(malformed, 1, "ekor terpotong dihitung, tidak dibungkam");
  eq(reconstructPositions(rows).size, 1, "posisi tetap terbangun dari baris sah");
});

test("A5 EXIT_ONLY: rencana beli KOSONG struktural walau sinyal segar + izin penuh; jualan tetap jalan", () => {
  const rows: Parameters<typeof reconstructPositions>[0] = [
    { ts: 1, day: "d", file: "f", action: "LIVE_FILL", ok: true, raw: { token: TOKEN, txHash: "0xa" } },
  ];
  const positions = reconstructPositions(rows);
  const { reconciled } = reconcilePositions(positions, new Map([[TOKEN, { ok: true, raw: 10n } as const]]));
  const base = { rows, reconciled, untracked: [] as Array<{ token: string; balanceRaw: bigint }>, now: 1000, maxPositionAgeMs: 24 * 3_600_000 };
  const opens = [{ token: OTHER, symbol: "ASML" }];
  const exitOnly = planActions({ ...base, paperHeldTokens: new Set<string>(), paperOpens: opens, exitOnly: true });
  eq(exitOnly.buys.length, 0, "EXIT_ONLY: nol rencana beli — ketidaksanggupan struktural");
  eq(exitOnly.sells.length, 1, "EXIT_ONLY: jualan tetap direncanakan (pengurangan risiko)");
  const full = planActions({ ...base, paperHeldTokens: new Set<string>(), paperOpens: opens, exitOnly: false });
  eq(full.buys.length, 1, "mode full: sinyal yang sama menghasilkan rencana beli");
});

test("A5 UNKNOWN/GHOST tetap tak tersentuh di mode full; untracked dilaporkan", () => {
  const pos = (token: string): { token: string; symbol: string; positionId: string; entryTs: number; entryDay: string; amountOutRaw: null; notionalUsd: number; txHash: null; evidence: "LIVE_FILL"; soldAt: null; sellTxHash: null; strategy: string } => ({ token, symbol: "T", positionId: "id-" + token.slice(2, 6), entryTs: 1, entryDay: "d", amountOutRaw: null, notionalUsd: 2.5, txHash: null, evidence: "LIVE_FILL", soldAt: null, sellTxHash: null, strategy: "s" });
  const positions = new Map([[GHOST, pos(GHOST)], [OTHER, pos(OTHER)]]);
  const balances = new Map([[GHOST, { ok: true, raw: 0n } as const], [OTHER, { ok: false, reason: "rpc down" } as const], [TOKEN, { ok: true, raw: 7n } as const]]);
  const { reconciled, untracked } = reconcilePositions(positions, balances);
  const plan = planActions({ rows: [], reconciled, untracked, paperHeldTokens: new Set<string>(), paperOpens: [], now: 1e12, maxPositionAgeMs: 24 * 3_600_000 });
  eq(plan.buys.length, 0, "tak ada beli saat status kandidat tak jelas");
  eq(plan.sells.length, 0, "UNKNOWN/GHOST tidak pernah dijual");
  assert(plan.reports.length >= 2, "GHOST + UNTRACKED dilaporkan");
});

test("A5 WALLET identitas: pemilik saldo diuji lewat readTokenBalance (regresi bug-1 sudah di live-positions.test)", () => {
  // Guard tambahan: rekonstruksi mengabaikan baris tanpa alamat sah (mencegah posisi sampah).
  const rows: Parameters<typeof reconstructPositions>[0] = [
    { ts: 1, day: "d", file: "f", action: "LIVE_FILL", ok: true, raw: { token: "bukan-alamat", txHash: "0x1" } },
    { ts: 2, day: "d", file: "f", action: "LIVE_FILL", ok: true, raw: { token: TOKEN, txHash: "0x2" } },
  ];
  eq(reconstructPositions(rows).size, 1, "baris alamat tidak sah diabaikan");
  void WALLET;
});
