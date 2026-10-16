import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { test, eq } from "../testing/harness.js";
import { makePending, evaluate, settle, loadPending, savePending, waitingOf, type PendingLimit } from "./limit-pending.js";

const base = { id: "a1", token: "0xt", armId: "v63-limit-d15-e15", cohort: "limit-entry-2026-10-13", signalMs: 1_000_000, signalPrice: 100, distPct: 15, expiryMin: 15 };

test("limit: target dihitung dari harga sinyal (15% di bawah 100 = 85)", () => {
  eq(makePending(base).targetPrice, 85, "target");
});

test("limit: harga turun ke 84 dalam masa berlaku → TERISI di harga target (85), bukan 84", () => {
  const p = makePending(base);
  const r = evaluate(p, 84, base.signalMs + 60_000);
  eq(r.action, "fill", "aksi");
  eq(r.fillPrice, 85, "harga fill = target");
});

test("limit: harga tidak pernah turun ke target tapi lewat deadline → KEDALUWARSA (tanpa posisi)", () => {
  const p = makePending(base);
  const r = evaluate(p, 90, base.signalMs + 16 * 60_000);
  eq(r.action, "expire", "aksi");
});

test("limit: harga di atas target dan belum lewat deadline → MENUNGGU", () => {
  const p = makePending(base);
  eq(evaluate(p, 99, base.signalMs + 60_000).action, "wait", "aksi");
});

test("limit: item yang sudah final tidak pernah terisi lagi (anti-dobel)", () => {
  const p = makePending(base);
  const s1 = settle([p], () => 84, base.signalMs + 60_000);
  eq(s1.filled.length, 1, "terisi sekali");
  const s2 = settle(s1.items, () => 84, base.signalMs + 120_000);
  eq(s2.filled.length, 0, "siklus berikutnya tidak mengisi lagi");
  eq(s2.items[0]!.status, "filled", "status tetap final");
});

test("limit: HARGA TIDAK TERSEDIA → menunggu (bukan mengisi, bukan mengarang)", () => {
  const p = makePending(base);
  const r = evaluate(p, null, base.signalMs + 60_000);
  eq(r.action, "wait", "aksi");
  eq(r.fillPrice, null, "tanpa harga fill");
});

test("limit: tahan restart — status terbaca sama setelah disimpan & dimuat", () => {
  const dir = mkdtempSync(join(tmpdir(), "rhlimit-"));
  const path = join(dir, "rh-limit-pending.json");
  const p = makePending(base);
  const s = settle([p], () => 84, base.signalMs + 60_000);
  savePending(path, s.items);
  const back = loadPending(path);
  eq(back.corrupt, false, "tidak korup");
  eq(back.items.length, 1, "satu item");
  eq(back.items[0]!.status, "filled", "status final bertahan");
  eq(back.items[0]!.fillPrice, 85, "harga fill bertahan");
  eq(waitingOf(back.items).length, 0, "tidak ada yang menunggu lagi");
});

test("limit: berkas rusak DITANDAI (corrupt), tidak diam-diam dianggap kosong", () => {
  const dir = mkdtempSync(join(tmpdir(), "rhlimit2-"));
  const path = join(dir, "rh-limit-pending.json");
  writeFileSync(path, "{bukan json");
  const back = loadPending(path);
  eq(back.corrupt, true, "ditandai rusak");
  eq(back.items.length, 0, "tanpa item");
});

test("limit: harga sinyal tidak masuk akal → DITOLAK, bukan diterima diam-diam", () => {
  let err = "";
  try { makePending({ ...base, signalPrice: 0 }); } catch (e) { err = (e as Error).message; }
  if (!err.includes("signalPrice")) throw new Error("seharusnya menolak signalPrice 0");
});

test("limit: hanya item 'waiting' yang dievaluasi ulang tiap siklus", () => {
  const p1 = makePending({ ...base, id: "w1" });
  const p2: PendingLimit = { ...makePending({ ...base, id: "w2" }), status: "expired", settledMs: 2, fillPrice: null };
  eq(waitingOf([p1, p2]).length, 1, "satu yang menunggu");
});

test("limit: token HILANG dari daftar harga → tetap KEDALUWARSA tepat waktu (bug 2026-10-16)", () => {
  const p = makePending(base);
  const r = evaluate(p, null, base.signalMs + 16 * 60_000);
  eq(r.action, "expire", "kedaluwarsa tanpa harga");
});

test("limit: harga tak tersedia TAPI belum deadline → menunggu (tidak mengarang)", () => {
  const p = makePending(base);
  eq(evaluate(p, null, base.signalMs + 5 * 60_000).action, "wait", "menunggu");
});

test("limit: harga ≤ target DAN sudah lewat deadline → FILL menang (bukan expire)", () => {
  const p = makePending(base);
  const r = evaluate(p, 80, base.signalMs + 20 * 60_000);
  eq(r.action, "fill", "fill menang atas waktu");
});
