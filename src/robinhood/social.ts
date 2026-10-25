/**
 * LAPISAN SOSIAL GMGN — ROBINHOOD CHAIN (2026-10-13) — `npm run rh:social`.
 *
 * Patokan operator (fomo.family): "follow top trader + alert apa yang mereka beli". Datanya GRATIS
 * di paket GMGN (terbukti: track kol/smartmoney mengembalikan 100 baris untuk chain robinhood).
 * Berkas ini HANYA membaca & meringkas — tidak ada eksekusi, tidak ada kunci.
 * Field asli (dibaca dari keluaran, bukan ditebak): transaction_hash · maker · side · amount_usd ·
 * base_token{...} · base_address · maker_info{...}.
 */
import { execFileSync } from "node:child_process";

type Row = Record<string, unknown>;

function gmgn(args: string[]): unknown | null {
  try {
    const out = execFileSync("npx", ["gmgn-cli", ...args, "--raw"], { encoding: "utf8", timeout: 60_000, maxBuffer: 2e7 });
    return JSON.parse(out) as unknown;
  } catch (e) {
    console.log("  (" + args.join(" ") + " gagal: " + String((e as Error).message).slice(0, 90) + ")");
    return null;
  }
}

function rowsOf(j: unknown): Row[] {
  if (j == null) return [];
  const o = j as Row;
  const cand = (o.list ?? o.data ?? o) as unknown;
  return Array.isArray(cand) ? (cand as Row[]) : [];
}

const str = (r: Row, k: string): string => String(r[k] ?? "?");
const usd = (r: Row): string => "$" + Number(r.amount_usd ?? 0).toFixed(0);

function symbol(r: Row): string {
  const bt = r.base_token as Row | undefined;
  const sym = (bt?.symbol as string) ?? (r.base_token_symbol as string);
  if (sym && String(sym).length) return String(sym).slice(0, 10);
  return String(r.base_address ?? "?").slice(0, 8);
}

function who(r: Row): string {
  const mi = r.maker_info as Row | undefined;
  const tag = mi ? (mi.name ?? mi.tag ?? mi.twitter_username) : undefined;
  if (tag && String(tag).length) return String(tag).slice(0, 18);
  return str(r, "maker").slice(0, 10) + "…";
}

function main(): void {
  console.log("══ LAPISAN SOSIAL — ROBINHOOD CHAIN (GMGN, gratis) ══");
  const kol = rowsOf(gmgn(["track", "kol", "--chain", "robinhood"]));
  const smart = rowsOf(gmgn(["track", "smartmoney", "--chain", "robinhood"]));
  console.log("  KOL trades: " + kol.length + " · Smart-money trades: " + smart.length);
  const pairs: Array<[string, Row[]]> = [["KOL", kol], ["SMART", smart]];
  for (const [label, rows] of pairs) {
    for (const r of rows.slice(0, 6)) {
      console.log("   " + label.padEnd(5) + " " + symbol(r).padEnd(10) + " " + str(r, "side").padEnd(4) +
        " " + usd(r).padStart(5) + " · " + who(r).padEnd(18) + " · " + str(r, "transaction_hash").slice(0, 12) + "…");
    }
  }
  console.log("\n  (Data ini untuk ALERT/discovery, bukan eksekusi. Eksekusi = keputusan terpisah.)");
}

main();
