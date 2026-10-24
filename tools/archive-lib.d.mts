/** Deklarasi tipe untuk tools/archive-lib.mjs (dipakai tes TS + CLI). */
export declare const NEVER_ARCHIVE: RegExp[];
export declare function sha256File(path: string): string;
export declare function archiveOne(src: string, dst: string): Promise<
  | { ok: true; manifest: { ts: number; file: string; sha256: string; bytes: number; gz: string } }
  | { ok: false; reason: string }>;
export declare function archiveTree(logDir: string, opts?: {
  days?: number; archiveDir?: string; run?: boolean;
}): Promise<{
  candidates: Array<{ path: string; size: number; ageDays: number }>;
  manifests: Array<Record<string, unknown> & { ok?: boolean; reason?: string; bytes?: number; sha256?: string; file?: string; gz?: string }>;
  savedBytes: number;
}>;
