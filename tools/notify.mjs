#!/usr/bin/env node
/**
 * NOTIFIKASI OPERASIONAL (item 5, 2026-10-11).
 *
 * TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID sudah lama jadi placeholder di .env.example, tetapi tidak
 * ada satu pun pemanggil — sehingga lane mati / audit merah / drift buku tidak memberi tahu siapa
 * pun. Berkas ini adalah SATU implementasi yang dipakai semua: watchdog (.mjs), lane-guard (.sh),
 * dan modul TypeScript (lewat CLI `node tools/notify.mjs "..."`).
 *
 * Tanpa env: SENYAP dan keluar 0 (bukan error) — supaya pemanggil tidak perlu tahu apakah alarm
 * sedang dipasang. Kegagalan kirim juga tidak pernah menggagalkan pemanggil: alarm tidak boleh
 * menjadi penyebab masalah baru.
 *
 * Pakai:  node tools/notify.mjs "pesan"          → kirim
 *         node tools/notify.mjs --test           → kirim pesan uji dan laporkan status
 *         node tools/notify.mjs --status         → laporkan apakah alarm terpasang
 */

const TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
const CHAT = process.env.TELEGRAM_CHAT_ID?.trim() ?? "";

export function notifyConfigured() {
  return Boolean(TOKEN && CHAT);
}

export async function notify(text) {
  if (!notifyConfigured()) return { sent: false, reason: "alarm belum dipasang (TELEGRAM_BOT_TOKEN/CHAT_ID kosong)" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text: `[shitcoin-bot] ${text}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    return { sent: res.ok, status: res.status };
  } catch (e) {
    return { sent: false, reason: e?.message ?? "gagal kirim" };
  }
}

const arg = process.argv[2];
if (arg === "--status") {
  console.log(notifyConfigured() ? "alarm: TERPASANG (token & chat id ada)" : "alarm: BELUM TERPASANG (isi TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID di .env)");
} else if (arg === "--test") {
  const r = await notify("uji alarm — kalau pesan ini sampai, jalur notifikasi hidup");
  console.log(r.sent ? "terkirim ✓" : `tidak terkirim: ${r.reason ?? "status " + r.status}`);
  process.exit(r.sent ? 0 : 1);
} else if (arg) {
  const r = await notify(arg);
  if (process.env.NOTIFY_VERBOSE === "1") console.log(r.sent ? "terkirim" : `tidak terkirim: ${r.reason ?? r.status}`);
}
