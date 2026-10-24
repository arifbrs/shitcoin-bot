/** Round-4: invariant akuntansi, konversi desimal terverifikasi, mode withdraw, arsip→restart→rekonsiliasi. */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, eq, assert } from "../testing/harness.js";
import { classificationInvariant, human } from "./reconcile-report.js";
import { withdrawModeFromEnv, applyWithdrawMode, withdrawnTodaySol } from "../execution/withdraw-gate.js";
import { loadLiveRows } from "./live-positions.js";
import { archiveTree, sha256File, NEVER_ARCHIVE } from "../../tools/archive-lib.mjs";
import { createHash } from "node:crypto";

const TOKEN = "0x156e175dd063a8ce274c50654ef40e0032b3fbcf";
const DEST = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

test("R4 invariant klasifikasi: 311 baris = 1+308+0+1+1 (kasus nyata) — dan selisih apa pun merah", () => {
  eq(classificationInvariant({ VERIFIED: 1, INFERRED: 308, UNKNOWN: 0, FALSE_POSITIVE: 1, ADMIN: 1 }, 311).ok, true, "kasus nyata 2026-10-24");
  eq(classificationInvariant({ VERIFIED: 1, INFERRED: 309, UNKNOWN: 0, FALSE_POSITIVE: 0, ADMIN: 0 }, 311).ok, false, "310 ≠ 311 harus merah (temuan auditor)");
  eq(classificationInvariant({ VERIFIED: 0, INFERRED: 0, UNKNOWN: 0, FALSE_POSITIVE: 0, ADMIN: 0 }, 0).ok, true, "kosong = cocok");
});

test("R4 konversi desimal TERVERIFIKASI: integer → string eksak; null desimal = tahan konversi", () => {
  eq(human(10588733587462950n, 18), "10588733587462950 raw = 0.010588733587462950 (desimal 18 terverifikasi dari kontrak)", "WETH keluar — angka kanonik");
  eq(human(2623563836639428744132977n, 18), "2623563836639428744132977 raw = 2623563.836639428744132977 (desimal 18 terverifikasi dari kontrak)", "saldo gilet kini");
  eq(human(10n ** 21n, 18), "1000000000000000000000 raw = 1000.000000000000000000 (desimal 18 terverifikasi dari kontrak)", "selisih = 1.000 token, BUKAN 1.000.000");
  assert(human(10n ** 21n, null).includes("desimal tak terverifikasi"), "tanpa decimals dari kontrak → konversi DITAHAN, bukan dibagi 1e18 paksa");
});

test("R4 withdraw mode: deny/policy/legacy eksplisit; legacy = perilaku lama (jawaban jujur: HARI INI BISA jalan)", () => {
  eq(withdrawModeFromEnv({}), "legacy", "default = legacy sampai operator menyetujui perubahan");
  eq(withdrawModeFromEnv({ WITHDRAW_MODE: "deny" }), "deny", "deny");
  assert(typeof withdrawModeFromEnv({ WITHDRAW_MODE: "banana" }) === "object", "nilai asing ditolak");
  const okDecision = { ok: true, amountSol: 1 } as const;
  const d1 = applyWithdrawMode("deny", okDecision, { allowlist: [DEST], maxSol: null, origin: null, expectedOrigin: null });
  assert(!d1.ok && d1.reason.includes("deny"), "deny memblokir keputusan yang sudah sah pun");
  const d2 = applyWithdrawMode("policy", okDecision, { allowlist: [], maxSol: null, origin: null, expectedOrigin: null });
  assert(!d2.ok && d2.reason.includes("fail-closed"), "policy tanpa allowlist = fail-closed");
  const d3 = applyWithdrawMode("policy", okDecision, { allowlist: [DEST], maxSol: null, origin: null, expectedOrigin: null });
  assert(d3.ok, "policy dengan allowlist lolos");
  const d4 = applyWithdrawMode("legacy", okDecision, { allowlist: [], maxSol: null, origin: null, expectedOrigin: null });
  assert(d4.ok, "legacy = perilaku lama utuh (tidak diubah tanpa otorisasi)");
});

test("R4 plafon harian: total SENT hari ini dari baris audit; baris rusak dihitung nol", () => {
  const text = [
    JSON.stringify({ type: "withdraw-audit", outcome: "SENT", sentSol: 0.01 }),
    JSON.stringify({ type: "withdraw-audit", outcome: "SENT", sentSol: 0.02 }),
    JSON.stringify({ type: "withdraw-audit", outcome: "REJECTED" }),
    "BARIS RUSAK",
  ].join("\n");
  eq(withdrawnTodaySol(text), 0.03, "0,01 + 0,02 = 0,03");
  eq(withdrawnTodaySol(""), 0, "kosong = 0");
});

test("R4 arsip → restart → rekonstruksi: rh-live TIDAK diarsipkan; .gz byte-exact + manifest sha256", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r4-archive-"));
  mkdirSync(join(dir, "sub"), { recursive: true });
  // Ledger live HARI INI (dilindungi) + berkas lama (diprotok karena ARCHIVE_DAYS dipaksa 0).
  const ledgerRows = [
    { ts: 1000, action: "LIVE_FILL", ok: true, token: TOKEN, symbol: "T", txHash: "0xa", amountOutRaw: "1000" },
    { ts: 2000, action: "LIVE_SELL", ok: true, token: TOKEN },
  ];
  writeFileSync(join(dir, "rh-live-2026-01-01.jsonl"), ledgerRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(dir, "sub", "old-events.jsonl"), "x".repeat(4096) + "\n");
  const srcSha = sha256File(join(dir, "sub", "old-events.jsonl"));

  const { manifests, candidates } = await archiveTree(dir, { days: 0, run: true });
  eq(candidates.filter((c: { path: string }) => /rh-live/.test(c.path)).length, 0, "rh-live tidak pernah jadi kandidat arsip");
  assert(existsSync(join(dir, "rh-live-2026-01-01.jsonl")), "ledger live TETAP DI TEMPAT setelah arsip");
  assert(existsSync(join(dir, "sub", "old-events.jsonl")) === false, "berkas lama dipindah ke .gz");
  const m = manifests.find((x: { ok?: boolean }) => x.ok !== false);
  assert(m, "manifest ada");
  eq(m!.sha256, srcSha, "sha256 manifest = sha256 sumber (byte-exact)");
  const roundtrip = gunzipSync(readFileSync(join(dir, "archive", "old-events.jsonl.gz"))).toString();
  eq(createHash("sha256").update(roundtrip).digest("hex"), srcSha, "dekompresi = sumber byte-per-byte");
  eq(m!.bytes, 4097, "ukuran sumber tercatat");

  // RESTART → rekonstruksi posisi dari ledger yang dilindungi tetap utuh.
  const { rows } = loadLiveRows(dir);
  eq(rows.length, 2, "loadLiveRows tetap membaca ledger live setelah proses arsip");
});

test("R4 arsip terputus: tujuan bentrok → sumber dipertahankan, tidak ada rekaman hilang", async () => {
  assert((NEVER_ARCHIVE as RegExp[]).some((re: RegExp) => re.test("rh-live-2026-10-24.jsonl")), "pola proteksi ledger live aktif");
  const dir = mkdtempSync(join(tmpdir(), "r4-archive-dup-"));
  mkdirSync(join(dir, "archive"), { recursive: true });
  writeFileSync(join(dir, "old.jsonl"), "data\n");
  writeFileSync(join(dir, "archive", "old.jsonl.gz"), "bukan-gzip-asli"); // tujuan sudah ada (sisa arsip terputus)
  const { manifests } = await archiveTree(dir, { days: 0, run: true });
  assert(manifests.some((x: { ok?: boolean; reason?: string }) => x.ok === false && String(x.reason).includes("sudah ada")), "tujuan bentrok → lewati, sumber utuh");
  assert(existsSync(join(dir, "old.jsonl")), "sumber TIDAK dihapus saat arsip bermasalah");
});
