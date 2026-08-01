import { PublicKey } from "@solana/web3.js";
import { getAccountInfoBase64 } from "./onchain.js";

/**
 * On-chain token metadata (Metaplex) reader — surfaces two signals learned from
 * dissecting reference sniper bots:
 *   - isMutable: if true, the dev can still change the token's name/image/socials
 *     after launch — a rug/bait-and-switch vector. Immutable = stronger.
 *   - socials: read straight from the metadata URI JSON, so fast-follow tokens
 *     (not yet on DexScreener) still get a community signal at launch.
 */
const MPL = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("metadata"), MPL.toBuffer(), mint.toBuffer()], MPL)[0];
}

export interface TokenMetadata {
  isMutable: boolean;
  uri: string;
  hasSocials: boolean;
  image?: string; // logo URL from the same JSON we already fetch for the socials check
}

function parseMetadata(buf: Buffer): { isMutable: boolean; uri: string } | null {
  try {
    let o = 1 + 32 + 32; // key + updateAuthority + mint
    const readStr = () => {
      const len = buf.readUInt32LE(o);
      o += 4;
      const s = buf.slice(o, o + len).toString("utf8").replace(/\0+$/, "");
      o += len;
      return s;
    };
    readStr(); // name
    readStr(); // symbol
    const uri = readStr();
    o += 2; // seller_fee_basis_points (u16)
    const hasCreators = buf.readUInt8(o);
    o += 1;
    if (hasCreators) {
      const n = buf.readUInt32LE(o);
      o += 4 + n * (32 + 1 + 1);
    }
    o += 1; // primary_sale_happened
    const isMutable = buf.readUInt8(o) === 1;
    return { isMutable, uri };
  } catch {
    return null;
  }
}

/**
 * Read the off-chain metadata JSON once and pull out everything we use.
 *
 * This fetch already happened — it was made purely to answer "does this token have socials?"
 * and the rest of the document was thrown away. The same JSON carries the token's `image`, so
 * the logo costs ZERO extra requests; we were just discarding it.
 */
async function readUriMeta(uri: string, externalSignal?: AbortSignal): Promise<{ hasSocials: boolean; image?: string }> {
  if (!uri.startsWith("http")) return { hasSocials: false };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3_000);
  const onExternalAbort = () => ctrl.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const res = await fetch(uri, { signal: ctrl.signal });
    const j = (await res.json()) as Record<string, unknown> & { extensions?: Record<string, unknown> };
    const keys = ["twitter", "telegram", "website", "discord"];
    const hasSocials = keys.some((k) => Boolean(j[k]) || Boolean(j.extensions?.[k]));
    // Only accept an http(s) image. Some tokens put ipfs:// or a data: blob here; the dashboard
    // renders these straight into an <img>, so anything we cannot hand a browser is dropped.
    const raw = typeof j.image === "string" ? j.image : undefined;
    const image = raw && /^https?:\/\//i.test(raw) ? raw : undefined;
    return { hasSocials, image };
  } catch {
    return { hasSocials: false };
  } finally {
    clearTimeout(t);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/** Best-effort; returns null on failure so the gate treats it as unknown, not bad. */
export async function tokenMetadata(mint: string, signal?: AbortSignal): Promise<TokenMetadata | null> {
  try {
    const data = await getAccountInfoBase64(metadataPda(new PublicKey(mint)).toBase58(), "confirmed", signal);
    if (!data) return null;
    const parsed = parseMetadata(data);
    if (!parsed) return null;
    const meta = await readUriMeta(parsed.uri, signal);
    return { isMutable: parsed.isMutable, uri: parsed.uri, hasSocials: meta.hasSocials, image: meta.image };
  } catch {
    return null;
  }
}
