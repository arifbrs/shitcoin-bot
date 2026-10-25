import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const OKX_STRICT_EPOCH = "OKX-STRICT-PAPER-V2";

export interface StrictLedgerRecord {
  seq: number;
  ts: string;
  epoch: string;
  prevHash: string;
  recordHash: string;
  type: string;
  [key: string]: unknown;
}

const ZERO_HASH = "0".repeat(64);

/** Hashes exactly the JSON bytes written before recordHash is attached. */
export function strictRecordHash(recordWithoutHash: Omit<StrictLedgerRecord, "recordHash">): string {
  return createHash("sha256").update(JSON.stringify(recordWithoutHash)).digest("hex");
}

export function verifyStrictLedger(path: string, expectedEpoch: string = OKX_STRICT_EPOCH): { ok: boolean; records: StrictLedgerRecord[]; error: string | null } {
  if (!existsSync(path)) return { ok: true, records: [], error: null };
  const records: StrictLedgerRecord[] = [];
  let expectedSeq = 1;
  let prevHash = ZERO_HASH;
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    let row: StrictLedgerRecord;
    try { row = JSON.parse(line) as StrictLedgerRecord; }
    catch { return { ok: false, records, error: `invalid JSON at line ${index + 1}` }; }
    if (row.epoch !== expectedEpoch) return { ok: false, records, error: `wrong epoch at line ${index + 1}` };
    if (row.seq !== expectedSeq) return { ok: false, records, error: `sequence gap at line ${index + 1}` };
    if (row.prevHash !== prevHash) return { ok: false, records, error: `hash-chain break at line ${index + 1}` };
    const { recordHash, ...withoutHash } = row;
    if (strictRecordHash(withoutHash) !== recordHash) return { ok: false, records, error: `record hash mismatch at line ${index + 1}` };
    records.push(row);
    expectedSeq++;
    prevHash = row.recordHash;
  }
  return { ok: true, records, error: null };
}

/**
 * Append-only, hash-chained paper ledger. If one byte in the history is edited or dropped, the
 * next startup/report fails closed instead of silently producing a flattering PnL.
 */
export class StrictLedger {
  readonly path: string;
  readonly startupRecords: readonly StrictLedgerRecord[];
  private seq = 0;
  private prevHash = ZERO_HASH;

  constructor(logDir: string) {
    this.path = join(logDir, "okx-strict-paper-v2.jsonl");
    const verified = verifyStrictLedger(this.path);
    if (!verified.ok) throw new Error(`strict paper ledger is not trustworthy: ${verified.error}`);
    this.startupRecords = verified.records;
    const last = verified.records.at(-1);
    this.seq = last?.seq ?? 0;
    this.prevHash = last?.recordHash ?? ZERO_HASH;
  }

  append(payload: { type: string; [key: string]: unknown }): StrictLedgerRecord {
    const withoutHash: Omit<StrictLedgerRecord, "recordHash"> = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      epoch: OKX_STRICT_EPOCH,
      prevHash: this.prevHash,
      ...payload,
    };
    const row = { ...withoutHash, recordHash: strictRecordHash(withoutHash) } as StrictLedgerRecord;
    appendFileSync(this.path, `${JSON.stringify(row)}\n`);
    this.prevHash = row.recordHash;
    return row;
  }
}
