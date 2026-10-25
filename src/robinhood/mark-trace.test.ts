import { test, eq, assert, approx } from "../testing/harness.js";
import { nextMarkSlot, shouldCaptureNow, traceFinished, priceRetention, MARK_AFTER_SLOTS, MARK_TRACE_GIVEUP_MS } from "./mark-trace.js";

test("jejak: slot 1/3/5 menit dan berhenti setelah tiga", () => {
  eq(MARK_AFTER_SLOTS.length, 3, "tiga slot");
  eq(nextMarkSlot(0), 60_000, "slot pertama 1 menit");
  eq(nextMarkSlot(1), 180_000, "slot kedua 3 menit");
  eq(nextMarkSlot(2), 300_000, "slot ketiga 5 menit");
  eq(nextMarkSlot(3), null, "tidak ada slot keempat");
});

test("jejak: pengambilan hanya saat sudah lewat waktunya", () => {
  eq(shouldCaptureNow(0, 59_999), false, "belum 1 menit → tunggu");
  eq(shouldCaptureNow(0, 60_000), true, "tepat 1 menit → ambil");
  eq(shouldCaptureNow(1, 179_999), false, "slot kedua belum");
  eq(shouldCaptureNow(1, 180_000), true, "slot kedua tepat waktu");
  eq(shouldCaptureNow(3, 999_999), false, "semua terisi → tidak ada lagi");
});

test("jejak: selesai bila lengkap, menyerah bila kelamaan (ditandai apa adanya)", () => {
  eq(traceFinished(3, 0), true, "tiga slot → selesai");
  eq(traceFinished(1, MARK_TRACE_GIVEUP_MS + 1), true, "kelamaan → menyerah");
  eq(traceFinished(1, 120_000), false, "masih berjalan");
});

test("jejak: retensi harga menangkap mark yang lenyap", () => {
  approx(priceRetention(1.0, 1.0)!, 1, 1e-9, "harga bertahan");
  approx(priceRetention(1.0, 0.2)!, 0.2, 1e-9, "tinggal seperlima");
  eq(priceRetention(1.0, null), null, "tanpa mark → tidak dikarang");
  eq(priceRetention(0, 1), null, "harga keluar nol → tak bisa dibandingkan");
});
