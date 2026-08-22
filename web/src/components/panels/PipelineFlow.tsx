import { useEffect, useRef } from "react";
import type { StatsResponse } from "@/types/stats";

/**
 * PIPELINE — hairline convergence.
 *
 * Owner picked this shape over the ribbon/Sankey versions. The rule that keeps it honest: the
 * NUMBER OF STRANDS a source gets is proportional to its share. pumpportal really does carry ~91%
 * of the flow, so its bundle really does dominate the frame — giving every feed an equal strand
 * count would draw a lie about where this flow comes from.
 *
 * Canvas, not SVG: ~74 strands x 40 points moving every frame would put ~3,000 DOM nodes into the
 * layout path. Each strand is ONE gradient-stroked path (an earlier per-segment version measured
 * 2,956 strokes/frame for identical output).
 *
 * A silent feed keeps its row at 0 and draws as a dashed grey strand. A dead source is a finding,
 * not an empty slot to hide.
 */
interface Strand { side: 1 | -1; col: [number, number, number]; spread: number; y0: number; bow: number }

export function PipelineFlow({ data }: { data: StatsResponse }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dRef = useRef(data);
  dRef.current = data;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DPR = window.devicePixelRatio || 1;

    let W = 0, H = 0;
    function rs() {
      const r = cv!.parentElement!.getBoundingClientRect();
      W = r.width; H = r.height;
      cv!.width = Math.max(1, W * DPR); cv!.height = Math.max(1, H * DPR);
      ctx!.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    rs();
    window.addEventListener("resize", rs);

    const nf = (v: number) => v.toLocaleString("id");
    const bez = (a: number, b: number, c: number, d: number, t: number) => {
      const u = 1 - t;
      return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
    };
    const PTS = 34;

    let strands: Strand[] = [];
    let pulses: number[] = [];
    let grads: (CanvasGradient | undefined)[] = [];
    let sig = "";
    let ph = 0, raf = 0, lastT = 0;
    // Semua gerak dinyatakan per DETIK, bukan per frame. Versi sebelumnya menambah phase 0,012
    // tiap frame, jadi kecepatannya ikut frame rate: 2x lebih cepat di layar 120Hz, dan tersendat
    // setiap kali satu frame terlambat. Panel ini menggambar ~2.400 segmen per frame, jadi frame
    // terlambat itu nyata, bukan teoretis.
    const PULSE_PER_SEC = 0.30;   // satu denyut menempuh helai penuh dalam ~3,3 detik
    const PULSES_PER_STRAND = 2;  // fase saling geser 0,5 → helai tidak pernah kosong

    function frame(now: number) {
      const p = dRef.current.pipeline;
      if (!p) { raf = requestAnimationFrame(frame); return; }
      const dt = lastT ? Math.min(0.05, (now - lastT) / 1000) : 0.016;
      lastT = now;
      const live = p.sources.filter((s) => s.v > 0);
      const dead = p.sources.filter((s) => s.v <= 0);
      const stot = live.reduce((a, s) => a + s.v, 0) || 1;
      const E = Object.entries(p.exits ?? {});
      const etot = E.reduce((a, b) => a + b[1], 0) || 1;

      // GUTTER DIUKUR, BUKAN DITEBAK. Versi pertama memakai LX = 20% lebar tile; pada tile yang
      // menyempit itu memotong "new-launch dev-holding" ke dalam berkas. Sekarang lebar kolom kiri
      // = label terpanjang + angkanya, diukur pada font yang benar-benar dipakai, lalu dikurung
      // supaya tidak pernah memakan lebih dari 40% tile.
      // Sub-label ("polling", "WebSocket launch") dan persentase DIBUANG (owner, 2026-08-04:
      // "jika tidak hide saja, biar fokus dan besar animasi visual pipeline"). Keduanya memang
      // bukan data: yang pertama keterangan, yang kedua sudah dikodekan oleh jumlah helai —
      // membacanya dua kali memakan gutter yang seharusnya jadi berkas. Nama dan cacah tetap,
      // karena itulah isinya.
      // TANPA GUTTER. Owner: "kanan kiri tidak usah tulisan" — label sumber dan alasan keluar
      // dulu memakan 20-25% lebar di tiap sisi, dan itu justru bagian tempat berkasnya paling
      // lebar. Angkanya tidak dibuang, hanya pindah: sumber ke header tile (pipelineMeta), alasan
      // keluar ke satu baris di dasar kanvas — keduanya tidak memakan lebar sama sekali.
      const exitFont = Math.max(7, Math.min(8.5, W / 150));
      const LX = 6, RX = W - 6;
      const GY = H * 0.50;   // tepat di tengah: kini ada baris legenda di atas DAN di bawah
      // Gerbang ditaruh proporsional di antara kedua gutter, bukan di 60% tile — kalau tidak,
      // pada tile lebar jepitannya melenceng ke kanan dan berkas keluar jadi rata.
      const GX = LX + (RX - LX) * 0.62;

      // Rebuild the bundle only when the shape actually changes — every frame would reallocate
      // ~74 objects at 60fps and reset the pulses to a synchronised line.
      // SIGNATURE ATAS ALOKASI, BUKAN ATAS CACAH MENTAH. Ini penyebab sentakan berkala yang
      // tersisa: `s.v` naik terus (cacah launch bertambah beberapa kali per detik), jadi signature
      // berubah pada SETIAP push SSE — sekitar 1,3x per detik. Tiap kali itu terjadi seluruh
      // berkas dibangun ulang DAN fase denyut direset ke nilai awalnya, jadi semua denyut melompat
      // mundur serentak. Yang benar-benar mengubah gambar hanyalah jumlah helai per sumber, dan
      // itu praktis tidak pernah berubah: 90.208 → 90.213 launch tetap menghasilkan 30 helai.
      const N_IN = 44, N_OUT = 24;
      const inN = live.map((s) => Math.max(1, Math.round(N_IN * s.v / stot)));
      const outN = E.map(([, v]) => Math.max(1, Math.round(N_OUT * v / etot)));
      const nextSig = `${Math.round(W)}x${Math.round(H)}|${live.map((s, i) => s.n + ":" + inN[i]).join()}|${E.map((e, i) => e[0] + ":" + outN[i]).join()}`;
      if (nextSig !== sig) {
        sig = nextSig;
        const prev = pulses;
        strands = [];
        const tin = inN.reduce((a, b) => a + b, 0), tout = outN.reduce((a, b) => a + b, 0);
        let k = 0;
        live.forEach((s, si) => {
          const col: [number, number, number] = s.eng === "S1" ? [232, 197, 106] : [167, 139, 250];
          for (let i = 0; i < inN[si]!; i++, k++) {
            const spread = (tin < 2 ? 0.5 : k / (tin - 1)) * 2 - 1;
            strands.push({ side: 1, col, spread, y0: GY + spread * H * 0.38, bow: Math.abs(spread) });
          }
        });
        let k2 = 0;
        E.forEach(([kk], ei) => {
          const col: [number, number, number] =
            kk === "TRAIL_LOCK" ? [75, 208, 127] : kk === "NO_DEVELOPMENT" ? [110, 120, 136] : [255, 95, 95];
          for (let i = 0; i < outN[ei]!; i++, k2++) {
            const spread = (tout < 2 ? 0.5 : k2 / (tout - 1)) * 2 - 1;
            strands.push({ side: -1, col, spread, y0: GY + spread * H * 0.31, bow: Math.abs(spread) });
          }
        });
        // Fase DIPERTAHANKAN lintas pembangunan ulang. Ketika alokasi memang berubah (pangsa
        // sumber bergeser cukup jauh untuk memindahkan satu helai), mereset semua fase akan
        // menghasilkan satu sentakan serentak yang terlihat justru saat data sedang menarik.
        // Helai yang benar-benar baru mengambil fase sebaran deret emas — merata, tidak
        // menggerombol seperti Math.random().
        pulses = strands.map((_, i) => prev[i] ?? (i * 0.6180339887) % 1);
        grads = [];
      }

      const point = (st: Strand, t: number): [number, number] => {
        const x0 = st.side > 0 ? LX : GX, x1 = st.side > 0 ? GX : RX;
        const y0 = st.side > 0 ? st.y0 : GY, y1 = st.side > 0 ? GY : st.y0;
        const w = Math.sin(ph * 0.9 + st.spread * 2.4) * st.bow * H * 0.035;   // outer strands breathe widest
        return [bez(x0, x0 + (x1 - x0) * 0.42, x0 + (x1 - x0) * 0.80, x1, t),
                bez(y0, y0 + w, y1, y1, t)];
      };

      ph += reduce ? 0 : dt * 0.72;
      ctx!.clearRect(0, 0, W, H);

      strands.forEach((st, si) => {
        // Ujung helai TETAP (bezier di t=0 dan t=1 mengembalikan titik awal/akhir apa adanya —
        // napas hanya menggeser titik kendali), jadi gradiennya tidak pernah berubah dan cukup
        // dibuat sekali. Sebelumnya 68 objek gradien dialokasikan ulang tiap frame; itu biaya
        // canvas yang nyata dan salah satu sebab frame terlambat.
        let gr = grads[si];
        if (!gr) {
          const A = point(st, 0), Z = point(st, 1);
          gr = ctx!.createLinearGradient(A[0], A[1], Z[0], Z[1]);
          const c = `${st.col[0]},${st.col[1]},${st.col[2]}`;
          const dim = st.side > 0 ? 0.05 : 0.6, lit = st.side > 0 ? 0.6 : 0.05;
          gr.addColorStop(0, `rgba(${c},${dim})`);
          gr.addColorStop(0.55, `rgba(${c},${(dim + lit) * 0.42})`);
          gr.addColorStop(1, `rgba(${c},${lit})`);
          grads[si] = gr;
        }
        ctx!.strokeStyle = gr; ctx!.lineWidth = 1.05;
        ctx!.beginPath();
        for (let s = 0; s <= PTS; s++) {
          const q = point(st, s / PTS);
          s ? ctx!.lineTo(q[0], q[1]) : ctx!.moveTo(q[0], q[1]);
        }
        ctx!.stroke();

        if (!reduce) {
          // ALIRAN MENYAMBUNG. Versi sebelumnya menjalankan kepala denyut 0 → 1,18 lalu melompat
          // ke −0,1, dan hanya menggambar saat berada di 0..1 — jadi tiap helai KOSONG selama 0,28
          // dari 1,28 siklus (22%). Itu jeda yang terlihat: bukan kesan, memang tidak ada yang
          // digambar. Sekarang fase dibungkus modulo 1 tanpa rentang mati, ekornya dipangkas di
          // pangkal (muncul memanjang secara wajar), dan tiap helai membawa dua denyut berfase
          // 0,5 sehingga saat satu keluar gerbang, satunya sudah setengah jalan.
          const speed = PULSE_PER_SEC * (0.82 + 0.36 * ((si * 37) % 7) / 7);
          pulses[si] = ((pulses[si] ?? 0) + dt * speed) % 1;
          for (let k = 0; k < PULSES_PER_STRAND; k++) {
            const pu = (pulses[si]! + k / PULSES_PER_STRAND) % 1;
            const near = st.side > 0 ? pu : 1 - pu;
            // Redam di kedua tepi supaya pembungkusan modulo tidak "pop" — muncul dan hilang
            // sebagai perubahan terang, bukan sebagai kemunculan mendadak.
            const edge = Math.min(1, pu / 0.10, (1 - pu) / 0.10);
            if (edge <= 0) continue;
            for (let q = 0; q < 5; q++) {
              const t0 = Math.max(0, pu - 0.11 * (q / 5)), t1 = Math.max(0, pu - 0.11 * ((q + 1) / 5));
              if (t1 <= 0 && t0 <= 0) break;
              const a = point(st, t0), b = point(st, t1);
              ctx!.strokeStyle = `rgba(255,255,255,${(1 - q / 5) * (0.14 + 0.31 * near) * edge})`;
              ctx!.lineWidth = 1.5 - q * 0.18;
              ctx!.beginPath(); ctx!.moveTo(a[0], a[1]); ctx!.lineTo(b[0], b[1]); ctx!.stroke();
            }
          }
        }
      });

      if (dead.length) {
        ctx!.save(); ctx!.setLineDash([3, 6]);
        ctx!.strokeStyle = "rgba(60,66,78,.8)"; ctx!.lineWidth = 1;
        const gs: Strand = { side: 1, col: [0, 0, 0], spread: 0.92, y0: GY + H * 0.35, bow: 0.92 };
        ctx!.beginPath();
        for (let i = 0; i <= PTS; i++) { const q = point(gs, i / PTS); i ? ctx!.lineTo(q[0], q[1]) : ctx!.moveTo(q[0], q[1]); }
        ctx!.stroke(); ctx!.restore();
      }

      const g = ctx!.createRadialGradient(GX, GY, 0, GX, GY, 24);
      g.addColorStop(0, "rgba(255,255,255,.9)");
      g.addColorStop(0.35, "rgba(201,240,74,.48)");
      g.addColorStop(1, "rgba(201,240,74,0)");
      ctx!.fillStyle = g; ctx!.beginPath(); ctx!.arc(GX, GY, 24, 0, 7); ctx!.fill();

      ctx!.textBaseline = "middle";
      // DUA BARIS LEGENDA, atas dan bawah — bukan kolom kiri-kanan. Kolom memakan LEBAR, yang
      // justru bagian tempat berkasnya paling hidup; baris memakan tinggi yang di atas dan di
      // bawah jepitan memang sudah kosong. Header tile juga tidak bisa memuatnya: ringkasan
      // sumber butuh 725px sementara tile 5 kolom cuma 482px pada layar 1280.
      // Titik warnanya memakai warna helai yang sama, jadi tiap baris terbaca sebagai legenda
      // berkas di dekatnya, bukan tabel yang kebetulan menempel.
      /**
       * One horizontal legend line that MUST fit — it cannot wrap, because there is exactly one
       * line of vertical room above and below the fan.
       *
       * So it degrades in a fixed order, cheapest sacrifice first: close the gaps, then step the
       * type down, and only then drop chips — smallest count first, since the tail of the
       * distribution is what a cramped row can afford to lose, never the reasons that dominate
       * it. A drop is always shown as "+n" so an omission is visible rather than silent.
       *
       * Found live: a RUN_RESET and a CATASTROPHIC row took the exit reasons from 6 to 8 and the
       * legend ran 608px wide inside a 474px tile.
       */
      const chipRow = (
        items: Array<{ label: string; n: string; col: string }>,
        cy: number,
        baseFont: number,
      ) => {
        const budget = W - 8;
        const measure = (list: typeof items, font: number, gapMul: number) => {
          ctx!.font = `${font.toFixed(2)}px ui-monospace, Menlo, monospace`;
          const DOT = font * 0.62, GAPI = font * 0.55, GAPO = font * gapMul;
          const widths = list.map((c) => DOT + GAPI + ctx!.measureText(c.n ? `${c.label} ${c.n}` : c.label).width);
          return { DOT, GAPI, GAPO, widths, font, total: widths.reduce((a, b) => a + b, 0) + GAPO * Math.max(0, list.length - 1) };
        };

        let list = items;
        let m = measure(list, baseFont, 1.9);
        for (const [font, gap] of [[baseFont, 1.1], [baseFont * 0.88, 1.0], [baseFont * 0.78, 0.85]] as const) {
          if (m.total <= budget) break;
          m = measure(list, Math.max(6.5, font), gap);
        }
        let dropped = 0;
        while (m.total > budget && list.length > 3) {
          const num = (c: { n: string }) => Number(c.n.replace(/\D/g, "")) || 0;
          const min = list.reduce((a, b) => (num(a) <= num(b) ? a : b));
          list = list.filter((c) => c !== min);
          dropped++;
          m = measure([...list, { label: `+${dropped}`, n: "", col: "70,76,88" }], Math.max(6.5, baseFont * 0.78), 0.85);
        }
        if (dropped) list = [...list, { label: `+${dropped}`, n: "", col: "70,76,88" }];
        m = measure(list, m.font, m.total > budget ? 0.85 : 1.1);

        let cx = Math.max(4, (W - m.total) / 2);
        list.forEach((c, i) => {
          ctx!.fillStyle = `rgba(${c.col},.85)`;
          ctx!.beginPath(); ctx!.arc(cx + m.DOT / 2, cy, m.DOT / 2, 0, 7); ctx!.fill();
          ctx!.fillStyle = "rgba(154,161,173,.92)";
          ctx!.fillText(c.label, cx + m.DOT + m.GAPI, cy);
          if (c.n) {
            ctx!.fillStyle = "rgba(96,103,115,1)";
            ctx!.fillText(` ${c.n}`, cx + m.DOT + m.GAPI + ctx!.measureText(c.label).width, cy);
          }
          cx += m.widths[i]! + m.GAPO;
        });
      };

      chipRow(
        p.sources.map((s) => ({
          label: s.n,
          n: s.v > 0 ? nf(s.v) : "diam",
          col: s.v <= 0 ? "70,76,88" : s.eng === "S1" ? "232,197,106" : "167,139,250",
        })),
        exitFont * 1.1,
        exitFont,
      );
      chipRow(
        E.map(([k, v]) => ({
          label: k.toLowerCase().replace(/_/g, " "),
          n: nf(v),
          col: k === "TRAIL_LOCK" ? "75,208,127" : k === "NO_DEVELOPMENT" ? "110,120,136" : "255,95,95",
        })),
        H - exitFont * 1.1,
        exitFont,
      );

      ctx!.textAlign = "center";
      ctx!.font = "12px ui-monospace, Menlo, monospace";
      ctx!.fillStyle = "rgba(201,240,74,.95)";
      ctx!.fillText(nf(p.bought), GX, GY - 30);
      ctx!.font = "7px ui-monospace, Menlo, monospace";
      ctx!.fillStyle = "rgba(69,74,85,1)";
      // "POSISI DIBUKA", not "LOLOS GERBANG". The old label named the gate while the number
      // counted purchases, and the two differ — passing the gate is not the same as being bought.
      ctx!.fillText("POSISI DIBUKA", GX, GY - 20);
      if (p.openNow) {
        ctx!.fillStyle = "rgba(201,240,74,.75)";
        ctx!.fillText(`${p.openNow} terbuka sekarang`, GX, GY + 30);
      }
      ctx!.textAlign = "left"; ctx!.textBaseline = "alphabetic";

      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => { window.removeEventListener("resize", rs); cancelAnimationFrame(raf); };
  }, []);

  // Own wrapper, not the Tile's content box: the canvas sizes itself from its parent, and a
  // parent that is also the flex child would let a resize feed back into its own measurement.
  return (
    <div className="relative h-full w-full overflow-hidden">
      <canvas ref={ref} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
