/**
 * LAPISAN SOSIAL GMGN — ROBINHOOD CHAIN (2026-10-13) — `npm run rh:social`.
 *
 * Patokan operator (fomo.family): "follow top trader + alert apa yang mereka beli". Semua datanya
 * GRATIS di paket GMGN (terbukti: track kol/smartmoney mengembalikan list untuk chain robinhood).
 * Berkas ini HANYA membaca & meringkas — tidak ada eksekusi, tidak ada kunci.
 */
import { execFileSync } from "node:child_process";

function gmgn(args: string[]): unknown | null {
  try {
    const out = execFileSync("npx", ["gmgn-cli", ...args, "--raw"], { encoding: "utf8", timeout: 60_000, maxBuffer: 2e7 });
    return JSON.parse(out) as unknown;
  } catch (e) {
    console.log(`  (${args.join(" ")} gagal: ${String((e as Error).message).slice(0, 90)})`);
    return null;
  }
}

const list = (j: unknown): Array<Record<string, unknown>> => {
  if (j == null) return [];
  const o = j as Record<string, unknown>;
  const cand = (o.list ?? o.data ?? o) as unknown;
  return Array.isArray(cand) ? (cand as Array<Record<string, unknown>>) : [];
};
const s = (r: Record<string, unknown>, k: string): string => String(r[k] ?? "?");
const n = (r: Record<string, unknown>, k: string): number => Number(r[k] ?? 0);
const sym = (r: Record<string, unknown>): string => {
  const bt = r.base_token as Record<string, unknown> | undefined;
  return String((bt?.symbol as string) ?? (r.base_address as string)?.slice(0, 8) ?? "?");
};
const who = (r: Record<string, unknown>): string => {
  const mi = r.maker_info as Record<string, unknown> | undefined;
  const tag = mi && (mi.name ?? mi.tag ?? mi.twitter_username);
  return String(tag ?? s(r, "maker").slice(0, 10) + "…");
};

function main(): void {
  console.log("══ LAPISAN SOSIAL — ROBINHOOD CHAIN (GMGN, gratis) ══");
  const kol = list(gmgn(["track", "kol", "--chain", "robinhood"]));
  const smart = list(gmgn(["track", "smartmoney", "--chain", "robinhood"]));
  console.log(`  KOL trades: ${kol.length} · Smart-money trades: ${smart.length}`);
  for (const [label, rows] of [["KOL", kol], ["SMART", smart]] as Array<[string, Array<Record<string, unknown>>]>) {
    for (const r of rows.slice(0, 5)) {
      console.log(`   ${label.padEnd(5)} ${sym(r).padEnd(10)} ${s(r, "side").padEnd(4)} \$\${n(r, "amount_usd").toFixed(0).padStart(4)} · ${who(r)} · ${s(r, "transaction_hash").slice(0, 12)}…`);
    }
  }
  console.log("\n  (Data ini untuk ALERT/discovery, bukan eksekusi. Eksekusi = keputusan terpisah.)");
}

main();
