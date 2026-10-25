import { test, eq, approx, assert } from "../testing/harness.js";
import {
  computeParity,
  parityGaps,
  compensatingOpenCount,
  needsReconciledClose,
  type ParityRow,
} from "./ledger-parity.js";

const row = (over: Partial<ParityRow>): ParityRow => ({
  action: "RH_OPEN",
  variant: "v1",
  token: "TOK",
  life: 1,
  ...over,
});

const LIFE = (): number => 1;

test("paritas: buka lalu tutup = sisa nol, tidak ada selisih", () => {
  const rows = [row({}), row({ action: "RH_CLOSE" })];
  const p = computeParity(rows, new Map(), LIFE);
  const gaps = parityGaps(p);
  eq(p.residual.get("v1|TOK|1"), 0, "sisa 0");
  eq(gaps.get("v1|TOK|1") ?? 0, 0, "selisih 0");
  eq(p.counts.opens, 1, "satu open dihitung");
  eq(p.counts.closes, 1, "satu close dihitung");
});

test("paritas: posisi dipegang tanpa catatan → kurang satu, penyeimbang ditulis", () => {
  const held = new Map([["v1|TOK", 1]]);
  const p = computeParity([], held, LIFE);
  const gaps = parityGaps(p);
  eq(gaps.get("v1|TOK|1"), -1, "selisih −1");
  eq(compensatingOpenCount(-1, 1), 1, "tulis 1 OPEN penyeimbang");
});

test("paritas: residual negatif pada life lama TIDAK ditambal (anti-putar 2026-10-10)", () => {
  // OPEN-nya di-void (tidak ada di baris), CLOSE-nya tetap ada: sisa −1, dan state tidak memegang.
  const rows = [row({ action: "RH_CLOSE", life: 7 })];
  const p = computeParity(rows, new Map(), LIFE);
  const gaps = parityGaps(p);
  eq(gaps.get("v1|TOK|7"), -1, "selisih −1 terdeteksi");
  eq(compensatingOpenCount(-1, 0), 0, "tanpa posisi dipegang → JANGAN tulis apa pun");
  eq(needsReconciledClose(-1, false), false, "sisi lebih tidak perlu penjelas");
});

test("paritas: kekurangan ditambal paling banyak sejumlah yang dipegang", () => {
  eq(compensatingOpenCount(-5, 2), 2, "hanya 2 yang benar-benar hilang");
  eq(compensatingOpenCount(-3, 3), 3, "semua hilang");
  eq(compensatingOpenCount(0, 3), 0, "tidak ada kekurangan");
  eq(compensatingOpenCount(4, 0), 0, "sisi lebih bukan urusan penyeimbang OPEN");
});

test("paritas: OPEN riil yang kuncinya punya CLOSE rekonsiliasi tidak dihitung (dijelaskan)", () => {
  const rows = [
    row({ life: 3 }),
    row({ action: "RH_CLOSE", life: 3, reconciled: true }),
    row({ life: 3 }),
  ];
  const p = computeParity(rows, new Map(), () => 3);
  assert(p.reconciledCloseKeys.has("v1|TOK|3"), "kunci dianggap dijelaskan");
  eq(p.residual.get("v1|TOK|3") ?? 0, 0, "OPEN riil tidak dihitung → sisa 0");
  eq(p.counts.reconciledRows, 1, "baris rekonsiliasi dihitung terpisah");
});

test("paritas: OPEN rekonsiliasi TETAP dihitung (ia penyeimbang, bukan hiasan)", () => {
  const rows = [row({ reconciled: true })];
  const p = computeParity(rows, new Map(), LIFE);
  eq(p.residual.get("v1|TOK|1"), 1, "penyeimbang menambah sisa");
  eq(p.counts.opens, 0, "tetapi tidak dihitung sebagai open riil");
});

test("paritas: sisi lebih dijelaskan sekali, tidak berkali-kali", () => {
  const rows = [row({ life: 9 }), row({ life: 9 })];
  const p = computeParity(rows, new Map(), LIFE);
  const gaps = parityGaps(p);
  eq(gaps.get("v1|TOK|9"), 2, "dua buka tanpa tutup");
  eq(needsReconciledClose(2, false), true, "perlu satu penjelas");
  eq(needsReconciledClose(2, true), false, "sudah dijelaskan → jangan tulis lagi");
});

test("paritas: posisi dipetakan ke life BERJALAN, bukan life baris", () => {
  const held = new Map([["v1|TOK", 1]]);
  const p = computeParity([], held, () => 21);
  assert(p.held.has("v1|TOK|21"), "kunci memakai life berjalan");
  eq(p.held.has("v1|TOK|1"), false, "bukan life lama");
});

test("paritas: perhitungan bersifat idempoten (bahan sama → hasil sama)", () => {
  const rows = [
    row({ token: "A" }),
    row({ action: "RH_CLOSE", token: "A" }),
    row({ token: "B", life: 2 }),
    row({ reconciled: true, token: "C" }),
  ];
  const held = new Map([["v1|B", 1]]);
  const a = computeParity(rows, held, LIFE);
  const b = computeParity(rows, held, LIFE);
  eq(a.residual.size, b.residual.size, "jumlah kunci sama");
  for (const [k, v] of a.residual) eq(b.residual.get(k), v, `sisa kunci ${k}`);
  eq([...parityGaps(a)].length, [...parityGaps(b)].length, "jumlah selisih sama");
});

test("paritas: satu kunci tidak dipakai untuk menutupi kunci lain", () => {
  const rows = [
    row({ token: "A" }),                       // A: sisa +1
    row({ action: "RH_CLOSE", token: "B" }),   // B: sisa −1
  ];
  const p = computeParity(rows, new Map(), LIFE);
  eq(p.residual.get("v1|A|1"), 1, "A positif");
  eq(p.residual.get("v1|B|1"), -1, "B negatif");
  const gaps = parityGaps(p);
  eq(gaps.get("v1|A|1"), 1, "selisih A tetap positif");
  eq(gaps.get("v1|B|1"), -1, "selisih B tetap negatif");
});

test("paritas: baris tanpa life dianggap life-1 (warisan lama)", () => {
  const p = computeParity([row({ life: undefined })], new Map(), LIFE);
  eq(p.residual.get("v1|TOK|1"), 1, "tanpa life → life 1");
});
