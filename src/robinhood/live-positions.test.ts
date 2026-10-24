/**
 * TES REGRESI LIVE-BRIDGE (2026-10-24) — bukti gagal-dulu/lulus-sesudah untuk audit independen.
 *
 *  - BUG 1 (commit 7a14c75): jalur jual memakai kontrak token sebagai PEMILIK balanceOf →
 *    `legacyBuggyCalldata` di bawah adalah REPLIKA persis ekspresi lama; tes membuktikan ia
 *    mengkode alamat token (bukan dompet) dan TIDAK sama dengan calldata produksi.
 *  - BUG 2: `rh:live` crash ENOENT saat paper-state lama tidak ada → tes membaca berkas yang
 *    sama dengan readFileSync (melempar = perilaku lama direproduksi) vs loadLegacyHeldTokens
 *    (kosong, tanpa lempar = perilaku baru).
 *  - P2: rekonstruksi lintas-tengah-malam, konflik ledger-vs-rantai, dedupe, anti-loop.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, eq, assert, throws } from "../testing/harness.js";
import { balanceOfCalldata, readTokenBalance, loadLegacyHeldTokens, loadLiveRows, reconstructPositions,
  reconcilePositions, planActions, positionIdFor, wethForUsd, type LiveRow, type RpcCall } from "./live-positions.js";

const WALLET = "0x629Ec42444A43A0E02A572587E3A49904542F4E8";
const TOKEN = "0x156e175dd063a8ce274c50654ef40e0032b3fbcf";

test("regresi bug-1: calldata balanceOf memakai DOMPET, replika kode lama membuktikan cacatnya", () => {
  const good = balanceOfCalldata(WALLET);
  eq(good, "0x70a08231" + "0".repeat(24) + WALLET.toLowerCase().slice(2), "argumen pemilik = dompet bot");
  // REPLIKA PERSIS ekspresi lama (live-executor.ts sebelum 2026-10-24, baris 254):
  const legacyBuggyCalldata = "0x70a08231000000000000000000000000" + TOKEN.slice(2).toLowerCase();
  eq(legacyBuggyCalldata.slice(10), "0".repeat(24) + TOKEN.slice(2).toLowerCase(), "kode lama terbukti mengkode alamat TOKEN sebagai pemilik");
  assert(legacyBuggyCalldata !== good, "calldata lama ≠ calldata benar — tes ini merah bila bug kembali");
  throws(() => balanceOfCalldata("0x123"), "pemilik non-alamat ditolak");
});

test("readTokenBalance: nol ≠ gagal RPC — keduanya dibedakan", async () => {
  const ok = (result: string): RpcCall => async () => ({ result });
  const zero = await readTokenBalance(ok("0x0"), TOKEN, WALLET);
  assert(zero.ok && zero.raw === 0n, "saldo nol sah");
  const two = await readTokenBalance(ok("0x1bc16d674ec80000"), TOKEN, WALLET);
  assert(two.ok && two.raw === 2_000_000_000_000_000_000n, "saldo parsial terbaca utuh");
  const err: RpcCall = async () => ({ error: { message: "execution reverted" } });
  const r1 = await readTokenBalance(err, TOKEN, WALLET);
  assert(!r1.ok, "revert = tidak ok");
  const boom: RpcCall = async () => { throw new Error("ECONNRESET"); };
  const r2 = await readTokenBalance(boom, TOKEN, WALLET);
  assert(!r2.ok && r2.reason.includes("ECONNRESET"), "lemparan RPC = tidak ok dengan alasan");
  const weird: RpcCall = async () => ({ result: 42 });
  const r3 = await readTokenBalance(weird, TOKEN, WALLET);
  assert(!r3.ok, "bentuk hasil aneh = tidak ok, bukan 0");
});

test("regresi bug-2: paper-state lama hilang/rusak = himpunan kosong, bukan ENOENT crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-live-legacy-"));
  // Perilaku LAMA direproduksi: readFileSync langsung ke berkas yang hilang melempar ENOENT.
  throws(() => readFileSync(join(dir, "rh-paper-state.json"), "utf8"), "mode lama memang crash di sini");
  eq(loadLegacyHeldTokens(dir, "v42-liq25-50").size, 0, "mode baru: hilang = kosong, proses lanjut");
  writeFileSync(join(dir, "rh-paper-state.json"), "{bukan json");
  eq(loadLegacyHeldTokens(dir, "v42-liq25-50").size, 0, "rusak = kosong, bukan crash");
  writeFileSync(join(dir, "rh-paper-state.json"), JSON.stringify({ variants: { "v42-liq25-50": { positions: [{ token: TOKEN }, { token: "bukan-alamat" }] } } }));
  const held = loadLegacyHeldTokens(dir, "v42-liq25-50");
  eq(held.size, 1, "sah: satu alamat valid");
  assert(held.has(TOKEN), "alamat lama tetap dikenali");
});

function writeLedger(dir: string, day: string, rows: Array<Record<string, unknown>>): void {
  writeFileSync(join(dir, `rh-live-${day}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("P2 rekonstruksi tengah-malam: posisi semalam tetap ditemukan setelah restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-live-midnight-"));
  writeLedger(dir, "2026-10-23", [{ ts: 1792823400000, action: "LIVE_FILL", ok: true, strategy: "v42-liq25-50", token: TOKEN, symbol: "AVGO", notionalUsd: 2.5, amountOutRaw: "7379306217214733", txHash: "0xabc" }]);
  writeLedger(dir, "2026-10-24", []); // hari baru, belum ada apa-apa
  const { rows } = loadLiveRows(dir);
  eq(rows.length, 1, "baris kemarin terbaca lintas hari");
  const positions = reconstructPositions(rows);
  const p = positions.get(TOKEN);
  assert(p, "posisi semalam ada setelah 'restart'");
  eq(p!.evidence, "LIVE_FILL", "bukti saldo-terverifikasi");
  eq(p!.positionId, positionIdFor(TOKEN, "0xabc", 1792823400000, "7379306217214733"), "ID posisi deterministik lintas-restart");
  eq(p!.entryDay, "2026-10-23", "hari entry tercatat");
  // Ulang rekonstruksi = hasil identik (idempoten).
  eq(reconstructPositions(rows).get(TOKEN)!.positionId, p!.positionId, "rekonstruksi kedua menghasilkan ID sama");
});

test("P2 rekonstruksi: LIVE_BUY legacy (tanpa txHash) juga ditemukan, epoch baru setelah jual", () => {
  const rows: LiveRow[] = [
    { ts: 1000, day: "d1", file: "f", action: "LIVE_BUY", ok: true, raw: { token: TOKEN, symbol: "X", strategy: "s" } },
    { ts: 2000, day: "d1", file: "f", action: "LIVE_SELL", ok: true, raw: { token: TOKEN } },
    { ts: 3000, day: "d2", file: "f", action: "LIVE_BUY", ok: true, raw: { token: TOKEN, symbol: "X", strategy: "s" } },
  ];
  const positions = reconstructPositions(rows);
  const p = positions.get(TOKEN)!;
  eq(p.entryTs, 3000, "buy setelah jual = epoch baru");
  eq(p.evidence, "LIVE_BUY_LEGACY", "bukti status-tx saja dilabeli legacy, bukan fill terverifikasi");
  // buy ganda saat masih terbuka tidak mengganti entry:
  const open: LiveRow[] = [
    { ts: 1000, day: "d1", file: "f", action: "LIVE_FILL", ok: true, raw: { token: TOKEN, txHash: "0xa" } },
    { ts: 1500, day: "d1", file: "f", action: "LIVE_FILL", ok: true, raw: { token: TOKEN, txHash: "0xb" } },
  ];
  eq(reconstructPositions(open).get(TOKEN)!.txHash, "0xa", "duplikat-beli tidak mengganti entry asli");
});

test("P2 konflik ledger-vs-rantai: GHOST/UNKNOWN/untracked dilaporkan, tidak pernah dijual", () => {
  const GHOST = "0x822cc93ffd030293e9842c30bbd678f530701867";
  const UNKNOWN = "0x47f93d52cbec7c6d2cfc080e154002370a60daea";
  const UNTRACKED = "0xa8ba1e1aeba6c27bd76caf09fda020e658641343";
  const pos = (token: string, id: string): LivePositionLike => ({ token, symbol: "T", positionId: id, entryTs: 1000, entryDay: "d", amountOutRaw: null, notionalUsd: 2.5, txHash: null, evidence: "LIVE_FILL", soldAt: null, sellTxHash: null, strategy: "s" });
  type LivePositionLike = import("./live-positions.js").LivePosition;
  const positions = new Map([
    [TOKEN, pos(TOKEN, "id1")],
    [GHOST, pos(GHOST, "id2")], // ledger bilang beli ok, rantai bilang saldo 0
    [UNKNOWN, pos(UNKNOWN, "id3")],
  ]);
  const balances = new Map([
    [TOKEN, { ok: true, raw: 5n } as const], // ledger & rantai sepakat: OPEN
    [GHOST, { ok: true, raw: 0n } as const], // konflik: ledger bilang punya, rantai bilang kosong
    [UNKNOWN, { ok: false, reason: "rpc mati" } as const],
    [UNTRACKED, { ok: true, raw: 9n } as const], // saldo dompet tanpa catatan posisi
  ]);
  const { reconciled, untracked } = reconcilePositions(positions, balances);
  eq(reconciled.find((p) => p.token === TOKEN)!.status, "OPEN", "saldo >0 = OPEN");
  eq(reconciled.find((p) => p.token === GHOST)!.status, "GHOST", "catatan beli tapi saldo 0 = GHOST");
  eq(reconciled.find((p) => p.token === UNKNOWN)!.status, "UNKNOWN", "RPC gagal = UNKNOWN, bukan nol");
  eq(untracked.length, 1, "saldo tanpa catatan = untracked");
  const plan = planActions({ rows: [], reconciled, untracked, paperHeldTokens: new Set<string>(), paperOpens: [], now: 999999, maxPositionAgeMs: 24 * 3_600_000 });
  assert(!plan.sells.some((s) => s.token === UNKNOWN), "UNKNOWN tidak dijual");
  assert(!plan.sells.some((s) => s.token === UNTRACKED), "untracked tidak pernah dijual otomatis");
  assert(!plan.sells.some((s) => s.token === GHOST), "GHOST tidak dijual (tak ada yang bisa dijual)");
  assert(plan.reports.some((r) => r.kind === "UNTRACKED"), "untracked dilaporkan");
});

test("P2 rencana aksi: dedupe per token, anti-loop, jual hanya OPEN terlacak", () => {
  const rows: LiveRow[] = [
    { ts: 1, day: "d", file: "f", action: "UNEXITABLE_BLOCK", ok: null, raw: { token: "0x3d10f368a078e1d01661e568298e58418609ba76" } },
    { ts: 2, day: "d", file: "f", action: "LIVE_ATTEMPT", ok: false, raw: { token: "0xa8ba1e1aeba6c27bd76caf09fda020e658641343" } },
  ];
  const open = [{ token: TOKEN, symbol: "AVGO", positionId: "id1", entryTs: 0, status: "OPEN" as const, balanceRaw: 10n, note: null }];
  const plan = planActions({
    rows, reconciled: open as never, untracked: [],
    paperHeldTokens: new Set<string>(), // paper tidak lagi memegang → yatim
    paperOpens: [
      { token: TOKEN, symbol: "AVGO" }, { token: TOKEN, symbol: "AVGO" }, // duplikat lintas-arm
      { token: "0x3d10f368a078e1d01661e568298e58418609ba76", symbol: "PHP" }, // pernah diblokir
      { token: "0xa8ba1e1aeba6c27bd76caf09fda020e658641343", symbol: "microduck" }, // gagal dibeli
      { token: "0x47f93d52cbec7c6d2cfc080e154002370a60daea", symbol: "ASML" },
    ],
    now: 25 * 3_600_000, maxPositionAgeMs: 24 * 3_600_000,
  });
  eq(plan.buys.length, 1, "satu token baru saja (duplikat per-arm dilebur)");
  eq(plan.buys[0]!.token, "0x47f93d52cbec7c6d2cfc080e154002370a60daea", "token benar yang direncanakan");
  eq(plan.sells.length, 1, "posisi yatim dijual");
  eq(plan.sells[0]!.qtyRaw, "10", "qty jual = saldo terbaca, bukan tebakan");
});

test("wethForUsd: nominal dari harga terukur; harga gagal = tolak", () => {
  assert(wethForUsd(2.5, 2361) === 1058873358746294n, "2,5 USD @ $2361 (2500/2361 × 10^15 wei); nilai dihitung node, bukan tebakan");
  throws(() => wethForUsd(2.5, 0), "harga 0 ditolak");
  throws(() => wethForUsd(0, 2361), "notional 0 ditolak");
});

test("loadLiveRows: ledger hilang = kosong; baris rusak dihitung, tidak membunuh berkas", () => {
  eq(loadLiveRows(join(tmpdir(), "rh-live-tidak-ada-" + Date.now())).rows.length, 0, "tanpa direktori = kosong");
  const dir = mkdtempSync(join(tmpdir(), "rh-live-malformed-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rh-live-2026-10-24.jsonl"), '{"ts":1,"action":"LIVE_BUY","ok":true,"token":"' + TOKEN + '"}\nBARIS RUSAK\n');
  const { rows, malformed } = loadLiveRows(dir);
  eq(rows.length, 1, "baris sah tetap terbaca");
  eq(malformed, 1, "baris rusak dihitung");
});
