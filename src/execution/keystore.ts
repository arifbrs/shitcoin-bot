import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { config } from "../config.js";

/**
 * KEY STORAGE — macOS keychain first, gitignored 0600 file as the fallback.
 *
 * ── What this actually buys, stated honestly ────────────────────────────────────────────
 * It is NOT a defence against malware running as you: anything with your uid can call
 * `security find-generic-password` just as it can read a 0600 file. What it removes is the
 * much more likely accident — a private key sitting inside the project directory, where it
 * gets swept into a zip, a Time Machine backup, a `cp -r` to a USB stick, a screen share, or
 * a `git add -f`. The key stops being a file in a folder you copy around.
 *
 * ── Why no passphrase prompt ────────────────────────────────────────────────────────────
 * A passphrase at startup is stronger, and it was rejected deliberately: this bot is restarted
 * unattended by `run-*-supervised.sh` and `watchdog.mjs`. A prompt would convert a security
 * improvement into an availability failure — the bot silently not coming back up after a
 * crash, holding open positions. For a trading bot that is the worse trade.
 *
 * ── Read path ───────────────────────────────────────────────────────────────────────────
 * Keychain → file. Never the reverse, so once imported the keychain copy is authoritative
 * even if a stale file is left behind. `importFromFile()` verifies the round-trip BEFORE
 * offering to delete anything.
 */

export const KEYCHAIN_SERVICE = "micincloud-bot-wallet";
export const KEYCHAIN_ACCOUNT = "bot-wallet";

export type KeySource = "keychain" | "file" | "generated" | "none";

function isMac(): boolean {
  return process.platform === "darwin";
}

/** Read the secret from the login keychain. `null` = not present or not available. */
export function keychainRead(service = KEYCHAIN_SERVICE, account = KEYCHAIN_ACCOUNT): string | null {
  if (!isMac()) return null;
  const r = spawnSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (r.status !== 0) return null;
  const secret = (r.stdout ?? "").trim();
  return secret.length > 0 ? secret : null;
}

/**
 * Write the secret to the login keychain.
 *
 * `-U` updates an existing item instead of failing. `-T` trusts THIS node binary so the bot
 * can read it back unattended; without it every restart would block on a GUI prompt that a
 * supervisor script can never answer.
 */
export function keychainWrite(secret: string, service = KEYCHAIN_SERVICE, account = KEYCHAIN_ACCOUNT): { ok: boolean; err?: string } {
  if (!isMac()) return { ok: false, err: "keychain storage is macOS-only" };
  const r = spawnSync(
    "security",
    ["add-generic-password", "-s", service, "-a", account, "-w", secret, "-U", "-T", process.execPath, "-T", "/usr/bin/security"],
    { encoding: "utf8", timeout: 20_000 },
  );
  if (r.status !== 0) return { ok: false, err: (r.stderr || r.stdout || "unknown security(1) failure").trim() };
  return { ok: true };
}

export function keychainDelete(service = KEYCHAIN_SERVICE, account = KEYCHAIN_ACCOUNT): boolean {
  if (!isMac()) return false;
  const r = spawnSync("security", ["delete-generic-password", "-s", service, "-a", account], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return r.status === 0;
}

/** Where would `botWallet()` get the key right now? Reports without consuming it. */
export function keySource(): KeySource {
  if (keychainRead()) return "keychain";
  if (existsSync(config.exec.keyFile)) return "file";
  return "none";
}

let keyAvailableCache = false;

/**
 * Is a signing key reachable AT ALL? The guardian's live gate calls this on every buy and every
 * sell, so it must be cheap: `keychainRead()` spawns `security(1)`, which is ~20ms of process
 * start on a path where an exit is waiting.
 *
 * Only a POSITIVE result is cached — a key that exists does not stop existing, but a key that is
 * missing can appear (first run generates one, or an import lands), so "no" is always re-checked.
 *
 * This replaced a bare `existsSync(config.exec.keyFile)` in the guardian, which the keychain
 * migration silently broke: with the key moved off disk, the file was gone, the gate read that
 * as "no key", and live execution would have been blocked forever with no diagnosis pointing at
 * the cause. Caught by the live-bridge selftest the moment the file was deleted.
 */
export function keyAvailable(): boolean {
  if (keyAvailableCache) return true;
  keyAvailableCache = existsSync(config.exec.keyFile) || keychainRead() !== null;
  return keyAvailableCache;
}

export interface ImportResult {
  ok: boolean;
  verified: boolean;      // the keychain copy reads back byte-identical
  fileRemoved: boolean;
  message: string;
}

/**
 * Move the key from the 0600 file into the keychain.
 *
 * The file is deleted ONLY after the keychain copy has been read back and compared. Deleting
 * on the strength of "the write command returned 0" is how a wallet becomes unrecoverable.
 */
export function importFromFile(deleteFile: boolean): ImportResult {
  if (!isMac()) return { ok: false, verified: false, fileRemoved: false, message: "keychain storage is macOS-only" };
  if (!existsSync(config.exec.keyFile)) {
    return keychainRead()
      ? { ok: true, verified: true, fileRemoved: true, message: "already in the keychain; no key file present" }
      : { ok: false, verified: false, fileRemoved: false, message: `no key file at ${config.exec.keyFile}` };
  }
  const secret = readFileSync(config.exec.keyFile, "utf8").trim();
  if (!secret) return { ok: false, verified: false, fileRemoved: false, message: "key file is empty" };

  const w = keychainWrite(secret);
  if (!w.ok) return { ok: false, verified: false, fileRemoved: false, message: `keychain write failed: ${w.err}` };

  const back = keychainRead();
  if (back !== secret) {
    return { ok: false, verified: false, fileRemoved: false, message: "keychain read-back MISMATCH — key file left untouched" };
  }
  let fileRemoved = false;
  if (deleteFile) {
    try { rmSync(config.exec.keyFile); fileRemoved = true; } catch (e) {
      return { ok: true, verified: true, fileRemoved: false, message: `stored + verified, but the file could not be deleted: ${(e as Error).message}` };
    }
  }
  return {
    ok: true,
    verified: true,
    fileRemoved,
    message: fileRemoved
      ? "stored in the keychain, read-back verified, key file deleted"
      : "stored in the keychain, read-back verified (key file kept — delete it once you are satisfied)",
  };
}
