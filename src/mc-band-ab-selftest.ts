/**
 * MC-BAND A/B SELF-TEST.
 *
 * The failure this guards is not a crash — it is a comparison that looks valid and is not.
 * An A/B whose split correlates with anything about the token stops measuring the policy and
 * starts measuring the population, and nothing downstream would ever reveal that. So the
 * properties asserted here are: the split is stable, it is blind, it is even, each arm's floor
 * is actually the one applied, and a candidate the pipeline could not identify is EXCLUDED
 * rather than quietly banked into the control.
 */
process.env.ENTRY_MC_AB = "true";
process.env.ENTRY_MC_FLOOR_SOL = "55";
process.env.ENTRY_MC_CEIL_SOL = "74";
process.env.ENTRY_MC_AB_LO_FLOOR_SOL = "46";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

async function main(): Promise<void> {
  console.log("═══════ MC-BAND A/B SELF-TEST ═══════\n");
  const M = await import("./experiments/mc-band-ab.js");

  console.log("1. PEMBAGIAN STABIL DAN BUTA");
  const ids = Array.from({ length: 20_000 }, (_, i) => `dmt${i.toString(36)}xq${i * 7}`);
  const arms = ids.map((id) => M.mcArmFor(id));
  const lo = arms.filter((a) => a === "LO").length;
  check("id yang sama selalu dapat arm yang sama",
    ids.slice(0, 500).every((id, i) => M.mcArmFor(id) === arms[i]));
  check(`pembagian mendekati 50/50 (LO ${lo}/${ids.length} = ${(lo / ids.length * 100).toFixed(1)}%)`,
    Math.abs(lo / ids.length - 0.5) < 0.02);

  // Buta terhadap fitur: id yang berdekatan tidak boleh mengumpul di satu sisi. Kalau hash-nya
  // bocor pola, decisionId berurutan (yang lahir berurutan dalam waktu) akan berkorelasi dengan
  // arm — dan arm jadi berkorelasi dengan jam perdagangan.
  let flips = 0;
  for (let i = 1; i < arms.length; i++) if (arms[i] !== arms[i - 1]) flips++;
  check(`id berurutan tidak mengumpul (${(flips / arms.length * 100).toFixed(1)}% pergantian, harap ~50%)`,
    Math.abs(flips / arms.length - 0.5) < 0.03);

  // Eksperimen lain yang mem-hash decisionId yang SAMA tidak boleh mewarisi pembagian ini.
  const { deterministicArmSample } = await import("./experiments/arm-spec.js");
  const agree = ids.slice(0, 5_000).filter((id) => (M.mcArmFor(id) === "LO") === deterministicArmSample(id, 5_000)).length;
  check(`bebas dari split eksperimen e3 (${(agree / 50).toFixed(1)}% sepakat, harap ~50%)`,
    Math.abs(agree / 5_000 - 0.5) < 0.03);

  console.log("\n2. LANTAI YANG DIPAKAI HARUS LANTAI ARM-NYA");
  const loId = ids.find((id) => M.mcArmFor(id) === "LO") as string;
  const hiId = ids.find((id) => M.mcArmFor(id) === "HI") as string;
  const bLo = M.mcBandFor(loId), bHi = M.mcBandFor(hiId);
  check("LO memakai lantai 46", bLo.arm === "LO" && bLo.floor === 46, `floor=${bLo.floor}`);
  check("HI memakai lantai produksi 55", bHi.arm === "HI" && bHi.floor === 55, `floor=${bHi.floor}`);
  check("plafon dibagi bersama — hanya lantai yang diuji", bLo.ceiling === bHi.ceiling && bLo.ceiling === 74);
  check("  → jadi 46–54 hanya bisa masuk lewat LO", 50 >= bLo.floor && 50 < bHi.floor);

  console.log("\n3. YANG TIDAK TERIDENTIFIKASI DIKELUARKAN, BUKAN DIMASUKKAN KE KONTROL");
  for (const bad of [null, undefined, ""]) {
    const v = M.mcBandFor(bad as string | null | undefined);
    check(`decisionId ${JSON.stringify(bad)} → tanpa arm, pakai pita produksi`,
      v.arm === null && v.floor === 55 && v.ceiling === 74, `arm=${v.arm} floor=${v.floor}`);
  }

  console.log("\n4. SAKLAR MATI = PERILAKU PRODUKSI PERSIS");
  {
    const child = await import(`./experiments/mc-band-ab.js?off=${Date.now()}`);
    // Modul membaca config saat dipanggil, jadi mematikannya lewat env di proses ini tidak
    // membuktikan apa pun — dijalankan di proses terpisah.
    const { spawnSync } = await import("node:child_process");
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    void child;
    const r = spawnSync(process.execPath, ["-e", `
      process.env.ENTRY_MC_AB = "false";
      process.env.ENTRY_MC_FLOOR_SOL = "55";
      process.env.ENTRY_MC_CEIL_SOL = "74";
      import("${pathToFileURL(join(process.cwd(), "src/experiments/mc-band-ab.ts")).href}")
        .then((m) => console.log(JSON.stringify(m.mcBandFor("dmtwhatever"))))
        .catch((e) => { console.error(e); process.exit(1); });
    `], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--import tsx" } });
    let v: { arm?: string | null; floor?: number } = {};
    try { v = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}"); } catch { /* dilaporkan di bawah */ }
    check("A/B mati → tanpa arm, lantai produksi", v.arm === null && v.floor === 55,
      `stdout=${(r.stdout ?? "").trim()} stderr=${(r.stderr ?? "").trim().slice(0, 160)}`);
  }

  console.log("\n5. SPEC TERKUNCI SEBELUM DATA ADA");
  check("aturan berhenti sudah terdaftar", M.MC_BAND_AB_SPEC.minTradesPerArm === 400 && M.MC_BAND_AB_SPEC.maxDays === 7);
  check("  → dan cukup besar untuk bermakna", M.MC_BAND_AB_SPEC.minTradesPerArm >= 100);
  check("spec beku (tidak bisa diubah diam-diam saat berjalan)", Object.isFrozen(M.MC_BAND_AB_SPEC));

  console.log(`\n═══════ RESULT: ${pass} passed, ${fail} failed ═══════`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
