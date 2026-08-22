import { existsSync } from "node:fs";
import { config } from "./config.js";
import { botPubkey, balanceSol, withdrawSol, walletSource } from "./execution/wallet.js";
import { importFromFile, keySource, keychainRead, KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT } from "./execution/keystore.js";
import { devnetPlumbingTest, simulateBuyMainnet } from "./execution/executor.js";

const cmd = process.argv[2] ?? "status";

async function main() {
  const pubkey = botPubkey();

  if (cmd === "status") {
    const [mainnet, devnet] = await Promise.all([
      balanceSol(config.rpcUrl).catch(() => -1),
      balanceSol(config.exec.devnetRpc).catch(() => -1),
    ]);
    console.log(`\n  Shitcoin bot wallet\n`);
    console.log(`  Address:        ${pubkey}`);
    console.log(`  Mainnet balance: ${mainnet < 0 ? "?" : mainnet.toFixed(4)} SOL`);
    console.log(`  Devnet balance:  ${devnet < 0 ? "?" : devnet.toFixed(4)} SOL`);
    console.log(`  Exec mode:       ${config.exec.mode}`);
    const src = walletSource();
    console.log(`\n  Key storage:    ${src === "keychain" ? "macOS keychain ✓" : src === "file" ? `FILE ${config.exec.keyFile} (gitignored, 0600)` : src}`);
    if (src !== "keychain") {
      console.log(`  → move it into the keychain:  npm run wallet keychain-import`);
      console.log(`     (a key file in the project directory is the one that gets swept into a`);
      console.log(`      backup, a zip, or a screen share — that is what this removes.)`);
    }
    console.log(`  Live permitted: ${config.exec.liveConfirmed ? "YES (LIVE_TRADING_CONFIRMED=yes)" : "no — .env lock closed"}\n`);
    console.log(`  Commands: npm run wallet [status|airdrop|devnet-test|simulate <mint>|withdraw <dest> <amt|all>|keychain-import [--keep-file]|keychain-status]\n`);
    return;
  }

  if (cmd === "keychain-status") {
    const inKeychain = keychainRead() !== null;
    console.log(`\n  Keychain item: ${KEYCHAIN_SERVICE} / ${KEYCHAIN_ACCOUNT}`);
    console.log(`  Present:       ${inKeychain ? "yes ✓" : "no"}`);
    console.log(`  Key file:      ${existsSync(config.exec.keyFile) ? `still on disk (${config.exec.keyFile})` : "not on disk"}`);
    console.log(`  In use by bot: ${keySource()}`);
    if (inKeychain && existsSync(config.exec.keyFile)) {
      console.log(`\n  ⚠ Both exist. The keychain WINS (wallet.ts checks it first), so the file is a`);
      console.log(`    leftover copy of your private key. Delete it once you're satisfied:`);
      console.log(`      rm ${config.exec.keyFile}`);
    }
    console.log("");
    return;
  }

  if (cmd === "keychain-import") {
    const keepFile = process.argv.includes("--keep-file");
    console.log(`\n  Memindahkan kunci dompet ke macOS keychain…\n`);
    console.log(`  Address: ${pubkey}`);
    const r = importFromFile(!keepFile);
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.message}`);
    if (r.ok && r.verified) {
      // Prove the migration on the address, not on the exit code: a keychain holding the
      // WRONG key would still "succeed" every check above.
      const { Keypair } = await import("@solana/web3.js");
      const bs58 = (await import("bs58")).default;
      const back = keychainRead();
      const same = back ? Keypair.fromSecretKey(bs58.decode(back)).publicKey.toBase58() === pubkey : false;
      console.log(`  ${same ? "✓" : "✗"} keychain berisi kunci untuk alamat yang SAMA (${pubkey.slice(0, 8)}…)`);
      if (!same) console.log(`  ⚠ JANGAN hapus key file. Ada yang salah.`);
      else if (!r.fileRemoved && !keepFile) console.log(`  ⚠ key file masih ada — hapus manual: rm ${config.exec.keyFile}`);
      else if (keepFile) console.log(`  ℹ key file sengaja dipertahankan (--keep-file). Keychain tetap yang dipakai.`);
    }
    console.log("");
    return;
  }

  if (cmd === "airdrop" || cmd === "devnet-test") {
    console.log(`\n  Running devnet plumbing test (airdrop + sign + send + confirm)…\n`);
    const r = await devnetPlumbingTest();
    console.log(`  Address:   ${r.pubkey}`);
    console.log(`  Devnet SOL: ${r.balanceSol.toFixed(4)}`);
    if (r.confirmed) {
      console.log(`  ✓ SIGN + SEND + CONFIRM works on devnet`);
      console.log(`  Signature: ${r.signature}`);
      console.log(`  → The full transaction plumbing is validated.\n`);
    } else {
      console.log(`  ✗ ${r.error}\n`);
    }
    return;
  }

  if (cmd === "simulate") {
    const mint = process.argv[3];
    if (!mint) { console.log("  usage: npm run wallet simulate <mint>"); return; }
    console.log(`\n  SIMULATE (mainnet, no send): buy 0.1 SOL of ${mint}…\n`);
    const r = await simulateBuyMainnet(mint, 0.1);
    console.log(`  tx built:  ${r.built} ${r.built ? "(real pump.fun buy tx constructed ✓)" : ""}`);
    console.log(`  would land on mainnet: ${r.ok}`);
    if (r.err) console.log(`  sim result: ${r.err}`);
    if (r.unitsConsumed) console.log(`  compute units: ${r.unitsConsumed}`);
    if (r.needsFunding) {
      console.log(`\n  ℹ Wallet has 0 SOL, so the on-chain buy sim can't complete.`);
      console.log(`    For a FULL fill/slippage sim, send ~0.05 SOL to the bot wallet — it is`);
      console.log(`    NEVER spent (simulate sends nothing). Address:`);
      console.log(`      ${botPubkey()}\n`);
    } else {
      console.log(r.ok ? `\n  ✓ real buy tx is valid + would land on mainnet right now.\n` : `\n  ✗ this buy would fail (honeypot / freeze / curve state).\n`);
    }
    return;
  }

  if (cmd === "withdraw") {
    const dest = process.argv[3];
    const amt = process.argv[4]; // number, or "all"
    if (!dest || !amt) {
      console.log(`\n  usage: npm run wallet withdraw <destinationAddress> <amountSol|all>`);
      console.log(`  contoh: npm run wallet withdraw <alamat-Phantom-mu> all\n`);
      return;
    }
    const amount = amt === "all" ? "all" : Number(amt);
    console.log(`\n  Menarik ${amt} SOL dari dompet bot → ${dest} …\n`);
    try {
      const r = await withdrawSol(config.rpcUrl, dest, amount);
      console.log(`  ✓ TERKIRIM ${r.sentSol.toFixed(4)} SOL`);
      console.log(`  Signature: ${r.signature}`);
      console.log(`  → Uangmu keluar. Dompet bot tidak mengunci apa pun.\n`);
    } catch (e) {
      console.log(`  ✗ gagal: ${(e as Error).message}\n`);
    }
    return;
  }

  console.log(`  unknown command "${cmd}" — use: status | airdrop | devnet-test | simulate <mint> | withdraw <dest> <amt|all> | keychain-import [--keep-file] | keychain-status`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
