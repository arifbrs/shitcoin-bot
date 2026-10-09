/**
 * OKX NETCHECK — diagnosa jaringan khusus host OKX. Nol dependensi, read-only.
 *
 * KENAPA ADA (temuan 2026-10-08): seluruh lane OKX (74 endpoint terdaftar) tiba-tiba gagal
 * serentak dengan "network: fetch failed". Ternyata bukan drift OKX dan bukan bug kita:
 * ISP melakukan **DNS hijack (Internet Positif)** — web3.okx.com & www.okx.com diresolusi ke
 * internetpositif.id (36.86.63.185), bahkan lewat resolver 1.1.1.1/8.8.8.8 (port 53 dicegat).
 * Yang penting: **jalur IP-nya terbuka** — memaksa IP asli Cloudflare + SNI benar → OKX API
 * menjawab normal (HTTP 401 = minta auth, artinya endpoint hidup).
 *
 * Alat ini memverifikasi tiga lapis dan mencetak remediasinya. TIDAK mengubah apa pun.
 *   npm run okx:netcheck
 *
 * Aturan yang TIDAK boleh dilanggar: JANGAN mematikan verifikasi TLS (NODE_TLS_REJECT_UNAUTHORIZED=0)
 * untuk menembus blokir — itu melemahkan keamanan seluruh proses (termasuk jalur eksekusi).
 */
import { promises as dns } from "node:dns";
import { request } from "node:https";

const HOST = "web3.okx.com";
const HIJACK_IP = "36.86.63.185"; // internetpositif.id — halaman blokir ISP (IP bisa berganti kapan saja)
const DOH_URL = `https://cloudflare-dns.com/dns-query?name=${HOST}&type=A`;

async function systemResolve(): Promise<string[]> {
  try { return await dns.resolve4(HOST); } catch { return []; }
}

async function dohResolve(): Promise<string[]> {
  try {
    const res = await fetch(DOH_URL, { headers: { accept: "application/dns-json" } });
    const j = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
    return (j.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  } catch { return []; }
}

/** HTTPS ke IP tertentu dengan SNI/host benar — membuktikan jalur IP+SNI, terlepas dari DNS. */
function httpsViaIp(ip: string): Promise<{ status: number; body: string; tlsOk: boolean }> {
  return new Promise((resolve) => {
    const req = request(
      { host: ip, servername: HOST, headers: { Host: HOST, accept: "application/json" }, path: "/api/v6/dex/market/supported/chain", method: "GET", timeout: 12_000 },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += String(c); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: body.slice(0, 160), tlsOk: true }));
      },
    );
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout", tlsOk: false }); });
    req.on("error", (e) => resolve({ status: 0, body: e.message, tlsOk: false }));
    req.end();
  });
}

async function main(): Promise<void> {
  console.log("═══ OKX NETCHECK ═══\n");
  const sys = await systemResolve();
  const doh = await dohResolve();
  // Deteksi hijack TIDAK boleh bergantung pada satu IP sinkhole: ISP mengganti IP-nya
  // (terbukti 2026-10-08: 36.86.63.185 → 195.35.23.222 dalam hitungan jam). Yang stabil:
  // DNS sistem TIDAK beririsan dengan DNS asli (DoH) → jawabannya dipalsukan.
  const overlap = sys.some((ip) => doh.includes(ip));
  const hijacked = sys.length > 0 && doh.length > 0 && !overlap;
  console.log(`1) DNS sistem untuk ${HOST}: ${sys.length ? sys.join(", ") : "(gagal resolve)"}`);
  console.log(`   → ${hijacked ? `🔴 BERBEDA dari DNS asli${sys.includes(HIJACK_IP) ? " (mengarah ke halaman blokir Internet Positif)" : " (kemungkinan hijack ISP)"}` : sys.length && doh.length ? "🟢 cocok dengan DNS asli" : "🟡 tak bisa disimpulkan"}`);

  console.log(`\n2) DNS asli via Cloudflare DoH: ${doh.length ? doh.join(", ") : "(gagal)"}`);

  // Uji jalur IP: yang asli (DoH) DAN yang diberikan DNS sistem — tunjukkan bedanya ke pengguna.
  if (sys[0] && !overlap) {
    const viaSys = await httpsViaIp(sys[0]);
    console.log(`\n3a) Lewat IP dari DNS SISTEM (${sys[0]}): HTTP ${viaSys.status} · TLS ${viaSys.tlsOk ? "OK" : "GAGAL"}${viaSys.body ? ` · ${viaSys.body}` : ""}`);
  }
  const target = doh[0] ?? "104.18.43.174";
  const via = await httpsViaIp(target);
  const ok = via.status > 0;
  console.log(`\n3b) Lewat IP ASLI (${target}): HTTP ${via.status} · TLS ${via.tlsOk ? "OK (verifikasi aktif)" : "GAGAL"}`);
  if (ok) console.log(`   body: ${via.body}`);
  console.log(`   → ${ok ? "🟢 endpoint OKX HIDUP; hanya DNS yang diblokir" : "🔴 jalur IP juga tertutup (blokir lebih dalam dari DNS)"}`);

  console.log("\n── REMEDIASI ──────────────────────────────────────────");
  if (hijacked && ok) {
    console.log("   Blokir = DNS saja. Pilihan (urut kemudahan):");
    console.log("   a) Pin host ke IP asli (perlu sudo; IP Cloudflare bisa berubah — cek ulang dengan alat ini):");
    for (const ip of doh.slice(0, 2)) console.log(`      echo "${ip} ${HOST}" | sudo tee -a /etc/hosts`);
    console.log("   b) Pakai resolver DoH lokal (cloudflared/dnscrypt-proxy) — tahan perubahan IP.");
    console.log("   c) Paling tahan lama: jalankan lane OKX di VPS luar negeri (deploy/ sudah menyediakan plist/service).");
  } else if (!ok) {
    console.log("   Jalur IP tertutup juga → perlu VPN/proxy atau VPS luar negeri.");
  } else {
    console.log("   DNS normal — tidak ada yang perlu dilakukan.");
  }
  console.log("   JANGAN pakai NODE_TLS_REJECT_UNAUTHORIZED=0. Verifikasi TLS tetap menyala.");
}

void main();
