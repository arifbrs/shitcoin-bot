/**
 * HARNESS PENGUJI — tanpa kerangka pihak ketiga (2026-10-11).
 *
 * Proyek ini sudah punya 25 skrip `*-selftest.ts` yang dijalankan manual dan nol penguji yang
 * menolak regresi otomatis. Berkas ini menambah dua hal saja: assertion yang jelas pesannya, dan
 * cara menjalankan semua `*.test.ts` dengan satu perintah yang keluar non-nol bila ada yang gagal.
 */

export type TestFn = () => void | Promise<void>;
interface Case {
  name: string;
  fn: TestFn;
}

const cases: Case[] = [];

export function test(name: string, fn: TestFn): void {
  cases.push({ name, fn });
}

export function registeredCases(): readonly Case[] {
  return cases;
}

export function fail(msg: string): never {
  throw new Error(msg);
}

export function assert(cond: unknown, msg: string): void {
  if (!cond) fail(msg);
}

export function eq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) fail(`${msg} — harap ${JSON.stringify(expected)}, dapat ${JSON.stringify(actual)}`);
}

export function approx(actual: number, expected: number, eps: number, msg: string): void {
  if (!(Math.abs(actual - expected) <= eps)) fail(`${msg} — harap ${expected} ±${eps}, dapat ${actual}`);
}

export function throws(fn: () => unknown, msg: string): void {
  try {
    fn();
  } catch {
    return;
  }
  fail(`${msg} — seharusnya melempar, tetapi tidak`);
}

export interface RunSummary {
  passed: number;
  failed: number;
  failures: Array<{ name: string; error: string }>;
}

export async function runAll(): Promise<RunSummary> {
  let passed = 0;
  const failures: Array<{ name: string; error: string }> = [];
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
    } catch (e) {
      failures.push({ name: c.name, error: (e as Error).message });
    }
  }
  return { passed, failed: failures.length, failures };
}
