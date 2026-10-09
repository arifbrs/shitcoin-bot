/**
 * SHADOW ENTRY JUDGE — apakah agent LLM berguna di keputusan MASUK?
 *
 * Kenapa dipindah ke sini. Sebagai penjaga EXIT dia terbukti nol pengaruh: relay makan 11-16
 * detik sementara MAX_HOLD menutup di 60 detik, jadi 69 dari 138 verdict tiba SESUDAH posisi
 * ditutup (median jeda 1 detik). Kontrafaktual yang sudah dibersihkan dari lookahead memberi
 * -0,58 poin +/-0,66 pada n=127 — sudah cukup data, dan jawabannya "tidak menolong".
 * Di keputusan masuk tidak ada tekanan 60 detik itu; 11 detik terlambat tidak berarti apa-apa
 * karena kita hanya menilai, bukan mengejar harga.
 *
 * DUA HAL YANG MEMBUAT UJI INI SAH, dan keduanya gampang dirusak tanpa sadar:
 *
 *  1. NOL KEBOCORAN. Prompt HANYA berisi snapshot kandidat yang dibekukan di `decisions-*.jsonl`
 *     pada saat keputusan. Tidak ada harga sesudahnya, tidak ada puncak, tidak ada hasil. Kalau
 *     nanti ada yang menambahkan field ke prompt, pastikan field itu ADA di snapshot — bukan
 *     dihitung belakangan.
 *  2. NOL PENGARUH. Proses ini terpisah, hanya MEMBACA log, dan tidak pernah menulis perintah.
 *     Tidak disebut file TS mana pun, jadi di luar codeFingerprint: cohort tidak reset dan
 *     keputusan trading tidak berubah satu pun.
 *
 * Menjawabnya nanti: jodohkan `decisionId` dengan `netExecutablePnlPct` di paper-trades.
 * Pertanyaannya: bisakah agent menandai, DI WAKTU MASUK, entry mana yang akan berakhir buruk?
 */
import { readFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = "logs";
const POLL_MS = Number(process.env.ENTRY_SHADOW_POLL_MS ?? 30_000);
// Satu per satu, dan pelan. Relay ini juga dipakai agent exit yang masih hidup; pengamat
// tidak boleh merebut jatahnya. 133 entry/hari = 1 tiap 11 menit, jadi tidak perlu buru-buru.
const GAP_MS = Number(process.env.ENTRY_SHADOW_GAP_MS ?? 4_000);

const env = Object.fromEntries(readFileSync(".env", "utf8").split("\n")
  .filter(l => l.includes("=") && !l.startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
// Kunci SENDIRI, terpisah dari agent hidup. Agent exit dimatikan dengan mengosongkan
// FEELING_LLM_KEY (feelingEnabled = url && key), dan pengukuran shadow tidak boleh ikut mati
// karenanya — justru shadow yang masih punya pertanyaan terbuka.
const URL_ = env.SHADOW_LLM_URL || env.FEELING_LLM_URL || "https://api.hcnsec.cn";
const KEY = env.SHADOW_LLM_KEY || env.FEELING_LLM_KEY;
const MODELS = (env.FEELING_LLM_MODELS || "step-3.5-flash,auto").split(",").map(s => s.trim());
if (!KEY) { console.error("[entry-shadow] SHADOW_LLM_KEY kosong"); process.exit(1); }

const say = m => console.log(`[entry-shadow] ${new Date().toISOString()} ${m}`);
const out = row => {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(join(LOG_DIR, `entry-shadow-${new Date().toISOString().slice(0, 10)}.jsonl`),
    JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
};

/**
 * decisionId yang selesai — supaya restart tidak menilai ulang dan membakar relay.
 *
 * "Selesai" berarti SUKSES, bukan sekadar pernah dicoba. Versi pertama menandai selesai
 * SEBELUM memanggil relay, jadi satu kegagalan menghanguskan entry itu selamanya. Terbukti
 * saat internet putus 24 menit (2026-08-11 16:36-17:00): 9 entry tercatat ok=false dan tidak
 * akan pernah dinilai ulang. Sekarang kegagalan boleh diulang sampai MAX_TRY, lalu menyerah —
 * kalau tidak, entry yang memang tidak bisa dinilai akan dicoba selamanya.
 */
const MAX_TRY = 3;
const done = new Set();
const tries = new Map();
function loadDone() {
  for (const f of readdirSync(LOG_DIR).filter(f => f.startsWith("entry-shadow-"))) {
    for (const l of readFileSync(join(LOG_DIR, f), "utf8").split("\n")) {
      if (!l) continue;
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (!r.decisionId) continue;
      if (r.ok) { done.add(r.decisionId); tries.delete(r.decisionId); continue; }
      const n = (tries.get(r.decisionId) ?? 0) + 1;
      tries.set(r.decisionId, n);
      if (n >= MAX_TRY) done.add(r.decisionId);
    }
  }
}

/**
 * HANYA field yang beku di waktu keputusan. Menambah apa pun di luar snapshot = kebocoran.
 *
 * REVISI v2 (2026-08-12) setelah menilai 2.654 entry. Versi pertama mengirim 17 field, tapi
 * pengukuran cakupannya menunjukkan sebagian besar tidak membawa informasi:
 *   isMayhemMode  100% terisi, 1 nilai unik  → nol informasi
 *   authorityUnknown  8% terisi, 1 nilai     → nol informasi
 *   setupVerdict/setupConfidence  2 nilai     → nyaris nol
 * Model menjawab "uncertain" pada 75% kasus dengan keyakinan 20-40. Itu BUKAN kebodohan model —
 * itu kalibrasi jujur atas masukan yang memang kosong.
 *
 * DIBUANG JUGA: rawScore dan gateScore. Keduanya TERBUKTI TERBALIK (makin gerbang menyukai koin,
 * makin buruk hasilnya) — memberi model sinyal yang menyesatkan lalu menyalahkannya karena
 * tersesat adalah uji yang tidak adil. `scoreParts` dikirim menggantikannya: komponen mentahnya,
 * bukan agregat yang sudah tercemar, sehingga model bisa menimbang sendiri.
 *
 * DITAMBAH: rasio turunan yang tidak bisa dilihat model dari angka mentah — devInitialBuySol
 * relatif terhadap MC (seberapa besar porsi dev), dan jarak MC dari garis peluncuran 30 SOL
 * (seberapa banyak orang lain sudah membeli).
 */
function brief(c, gate) {
  const lb = c.launchBundle ?? {};
  const mc = typeof c.marketCapSol === "number" ? c.marketCapSol : null;
  const dev = typeof c.devInitialBuySol === "number" ? c.devInitialBuySol : null;
  return {
    symbol: c.symbol, name: c.name,
    marketCapSol: mc,
    // Seberapa jauh di atas garis peluncuran (27,96 SOL MC = vSol 30) — proksi "berapa banyak
    // orang lain sudah masuk", satu-satunya sinyal entry yang terbukti punya daya pisah.
    mcAboveLaunchSol: mc != null ? Number((mc - 27.96).toFixed(2)) : null,
    devInitialBuySol: dev,
    devShareOfMcPct: mc && dev != null && mc > 0 ? Number(((dev / mc) * 100).toFixed(1)) : null,
    holders: c.holders,
    themeCrowd: c.themeCrowd, themeWord: c.themeWord,
    isCashbackCoin: c.isCashbackCoin,
    bundledShare: lb.bundledShare, sameSlotMax: lb.sameSlotMax,
    earlyTxs: lb.earlyTxs, verifiedBuys: lb.verifiedBuys,
    scoreParts: c.scoreParts ?? null,
  };
}

const PROMPT = `Kamu menilai SATU koin pump.fun yang baru diluncurkan, pada detik pembelian.
Bot membeli 0.15 SOL dan HARUS keluar dalam 60 detik. Biaya bolak-balik sekitar 2.8%.
Sebaran nyata: sekitar 55% trade berakhir rugi, ekor pemenang tebal (5% menembus +100%).

Data DI BAWAH ini adalah SATU-SATUNYA yang tersedia saat keputusan. Tidak ada harga sesudahnya.
Peluncuran pump.fun SELALU mulai di MC 27,96 SOL, jadi mcAboveLaunchSol = seberapa banyak
sudah dibeli orang lain. scoreParts adalah komponen mentah pemeriksaan keamanan.

Jawab HANYA JSON:
{"outlook":"good"|"bad"|"uncertain","confidence":0-100,"reason":"<=25 kata"}
"good" = kamu memperkirakan hasil bersih POSITIF dalam 60 detik.
"bad"  = kamu memperkirakan rugi. "uncertain" = tidak bisa dibedakan dari lemparan koin.
Jujur pakai "uncertain" kalau memang tidak ada sinyal — menebak-nebak merusak pengukuran.

DATA:
`;

async function judge(rec) {
  const b = brief(rec.candidate ?? {}, rec.gate);
  const body = m => JSON.stringify({ model: m, temperature: 0.3, max_tokens: 700,
    messages: [{ role: "user", content: PROMPT + JSON.stringify(b, null, 1) }],
    response_format: { type: "json_object" } });
  for (let a = 0; a < MODELS.length; a++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30_000);
    try {
      const res = await fetch(`${URL_}/v1/chat/completions`, { method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: body(MODELS[a]), signal: ctl.signal });
      if (!res.ok) continue;
      const j = await res.json();
      const msg = j.choices?.[0]?.message;
      const text = msg?.content || msg?.reasoning_content || msg?.reasoning || "";
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const p = JSON.parse(m[0]);
      if (!p.outlook) continue;
      return { outlook: String(p.outlook).toLowerCase(), confidence: Number(p.confidence) || 0,
               reason: String(p.reason ?? "").slice(0, 200), model: MODELS[a] };
    } catch { /* coba model berikutnya */ } finally { clearTimeout(t); }
  }
  return null;
}

async function sweep() {
  const day = new Date().toISOString().slice(0, 10);
  const f = join(LOG_DIR, `decisions-${day}.jsonl`);
  if (!existsSync(f)) return;
  const pend = [];
  for (const l of readFileSync(f, "utf8").split("\n")) {
    if (!l || !l.includes('"PAPER_BUY"')) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.action !== "PAPER_BUY" || !r.decisionId || done.has(r.decisionId)) continue;
    pend.push(r);   // TIDAK ditandai selesai di sini — hanya setelah relay benar-benar menjawab
  }
  if (!pend.length) return;
  say(`${pend.length} entry baru untuk dinilai`);
  for (const r of pend) {
    const v = await judge(r);
    const n = (tries.get(r.decisionId) ?? 0) + (v ? 0 : 1);
    if (v) { done.add(r.decisionId); tries.delete(r.decisionId); }
    else { tries.set(r.decisionId, n); if (n >= MAX_TRY) done.add(r.decisionId); }
    out({ decisionId: r.decisionId, mint: r.candidate?.mint, symbol: r.candidate?.symbol,
          attempt: n, gaveUp: !v && n >= MAX_TRY,
          cfg: r.cfg, decidedAt: r.ts,
          // Selisih ini membuktikan penilaian memakai snapshot beku, bukan info hidup.
          judgedLagSec: r.ts ? Math.round((Date.now() - Date.parse(r.ts)) / 1000) : null,
          ok: Boolean(v), ...(v ?? {}), snapshot: brief(r.candidate ?? {}, r.gate) });
    if (v) say(`${r.candidate?.symbol ?? "?"} → ${v.outlook} (${v.confidence}) ${v.reason.slice(0, 60)}`);
    await new Promise(res => setTimeout(res, GAP_MS));
  }
}

loadDone();
say(`mulai · ${done.size} sudah dinilai sebelumnya · poll ${POLL_MS / 1000}s · SHADOW, nol pengaruh`);
void sweep();
setInterval(() => void sweep(), POLL_MS);
