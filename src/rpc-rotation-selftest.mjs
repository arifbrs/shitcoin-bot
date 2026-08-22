// Meniru persis logika pemilihan pool di onchain.ts
let rrCursor = 0;
const mk = (h, benched = 0, maxBatch = 100) => ({ h, benchedUntil: benched, maxBatch, calls: 0 });
function pick(endpoints, now, needBatch = 0) {
  const capable = endpoints.filter(e => e.maxBatch >= needBatch);
  let pool = capable.filter(e => e.benchedUntil <= now);
  if (!pool.length) {
    const from = capable.length ? capable : endpoints;
    pool = [from.reduce((a, b) => (a.benchedUntil <= b.benchedUntil ? a : b))];
  } else if (pool.length > 1) {
    const start = rrCursor++ % pool.length;
    pool = pool.slice(start).concat(pool.slice(0, start));
  }
  return pool;
}
const line = (t, ok) => console.log(`  ${ok ? "✓" : "✗"} ${t}`);
let fail = 0; const A = (t, ok) => { if (!ok) fail++; line(t, ok); };

// 1. tiga endpoint sehat → beban merata
rrCursor = 0;
let eps = [mk("helius-A"), mk("helius-B"), mk("quicknode")];
for (let i = 0; i < 300; i++) pick(eps, 0)[0].calls++;
const spread = eps.map(e => e.calls);
A(`3 sehat → merata ${spread.join("/")}`, Math.max(...spread) - Math.min(...spread) <= 1);

// 2. satu di-bench → hanya dua sisanya dipakai, yang di-bench tidak pernah pertama
rrCursor = 0;
eps = [mk("helius-A"), mk("helius-B"), mk("quicknode", 9e9)];
for (let i = 0; i < 200; i++) pick(eps, 0)[0].calls++;
A(`quicknode di-bench → tidak pernah dipilih (${eps[2].calls} panggilan)`, eps[2].calls === 0);
A(`dua sisanya tetap merata ${eps[0].calls}/${eps[1].calls}`, Math.abs(eps[0].calls - eps[1].calls) <= 1);

// 3. failover utuh: tiap pilihan tetap memuat SEMUA endpoint sehat
rrCursor = 0;
eps = [mk("a"), mk("b"), mk("c")];
let allOk = true;
for (let i = 0; i < 30; i++) if (pick(eps, 0).length !== 3) allOk = false;
A("urutan diputar tapi semua endpoint sehat tetap ikut (failover utuh)", allOk);

// 4. semua di-bench → tetap pakai yang cooldown-nya paling cepat habis
rrCursor = 0;
eps = [mk("a", 5000), mk("b", 1000), mk("c", 9000)];
const p = pick(eps, 0);
A(`semua di-bench → pilih yang paling cepat pulih (${p[0].h})`, p.length === 1 && p[0].h === "b");

// 5. batas batch dihormati: getMultipleAccounts 100 tidak boleh ke endpoint 5-akun
rrCursor = 0;
eps = [mk("quicknode", 0, 5), mk("helius-A", 0, 100), mk("helius-B", 0, 100)];
let batchOk = true;
for (let i = 0; i < 40; i++) if (pick(eps, 0, 100).some(e => e.maxBatch < 100)) batchOk = false;
A("batch 100 tidak pernah dikirim ke endpoint 5-akun", batchOk);

// 6. cursor tidak meluap jadi indeks negatif setelah pemakaian panjang
rrCursor = Number.MAX_SAFE_INTEGER - 3;
eps = [mk("a"), mk("b")];
let idxOk = true;
for (let i = 0; i < 10; i++) if (!pick(eps, 0)[0]) idxOk = false;
A("cursor besar tetap menghasilkan indeks sah", idxOk);

console.log(fail === 0 ? "  LULUS" : `  GAGAL ${fail}`);
process.exit(fail ? 1 : 0);
