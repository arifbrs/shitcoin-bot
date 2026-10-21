/**
 * LANE paper 1:1 — satu siklus per pemanggilan (supervisor yang mengulang tiap 5 menit).
 * Satu penulis (lock di engine), notional WETH, exit hanya bila quote jual ada (STUCK bila tidak).
 */
import { cycle, type Cfg } from "./engine.js";

const MAKER = process.env.RHPAPER_MAKER || process.env.BOT_WALLET || "0x629Ec42444A43A0E02A572587E3A49904542F4E8";
const cfg = {
  maker: MAKER,
  usd: Number(process.env.RHPAPER_USD ?? 2.5),
  maxPositions: Number(process.env.RHPAPER_MAX ?? 3),
  stopPct: Number(process.env.RHPAPER_STOP ?? 40),
  takePct: Number(process.env.RHPAPER_TAKE ?? 250),
  tpHoldMin: Number(process.env.RHPAPER_HOLD_MIN ?? 240),
  wethRaw: process.env.RHPAPER_WETH_RAW ?? "1000000000000000",
  arm: process.env.RHPAPER_ARM ?? "A",
} as Cfg;

const t0 = Date.now();
try {
  const r = await cycle(cfg);
  console.log(`[rhpaper] ${new Date().toISOString()} · buka ${r.opened} · tutup ${r.closed} · stuck ${r.stuck} · ${Date.now() - t0}ms`);
  for (const e of r.errors.slice(0, 5)) console.log("  ! " + e);
} catch (e) {
  console.log("[rhpaper] galat: " + String((e as Error).message).slice(0, 160));
  process.exitCode = 1;
}
