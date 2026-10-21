import { test, eq } from "../testing/harness.js";
import { isAcceptable } from "./scanner.js";

const A = "0x6ebc9cebcd7dc3cacb34c65f279461eb6a35a96f";

test("scanner: tolak token yang menumpang nama aset mapan", () => {
  eq(isAcceptable("ETH", A), false, "ETH ditolak");
  eq(isAcceptable("weth", A), false, "weth ditolak");
  eq(isAcceptable("USDG", A), false, "USDG ditolak");
});

test("scanner: terima simbol wajar dengan alamat valid", () => {
  eq(isAcceptable("Kimchi", A), true, "Kimchi diterima");
  eq(isAcceptable("X", A), false, "simbol 1 huruf ditolak");
  eq(isAcceptable("OK", "bukan-alamat"), false, "alamat salah ditolak");
});
