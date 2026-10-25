/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { connectStatsStream } from "../src/lib/statsStream";
import { filterVariants, formatAge, laneState, snapshotAge } from "../src/lib/dashboard";
import { DashboardOverview } from "../src/components/panels/DashboardOverview";
import { FeedStatus } from "../src/components/panels/FeedStatus";
import { TopBar } from "../src/components/panels/TopBar";
import type { ConnectionStatus } from "../src/lib/statsStream";
import type { RobinhoodVariantView } from "../src/types/stats";

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; this.readyState = FakeEventSource.CLOSED; }
  send(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  fail(state = 0) { this.readyState = state; this.onerror?.(); }
}

const valid = { now: "2026-10-12T10:00:00Z", control: {}, system: {}, feeling: {}, paper: {}, strategy2: {} };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

await test("stream lifecycle", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "EventSource", original);
    else Reflect.deleteProperty(globalThis, "EventSource");
  });
  const setup = () => {
    const states: ConnectionStatus[] = [];
    const snapshots: unknown[] = [];
    const errors: Array<string | null> = [];
    const connection = connectStatsStream({ onData: (data) => snapshots.push(data), onStatus: (status) => states.push(status), onError: (error) => errors.push(error) });
    return { connection, states, snapshots, errors, source: FakeEventSource.instances.at(-1)! };
  };

  await t.test("only valid snapshots mark the feed open; invalid frames preserve data", () => {
    const { connection, source, states, snapshots, errors } = setup();
    try {
      assert.deepEqual(states, []);
      source.send(valid);
      source.send(null);
      source.send({ now: "invalid" });
      source.onmessage?.({ data: "not json" });
      assert.deepEqual(states, ["open"]);
      assert.equal(snapshots.length, 1);
      assert.match(errors.at(-1)!, /tidak valid/);
      source.send(valid);
      assert.equal(errors.at(-1), null);
    } finally { connection.close(); }
  });

  await t.test("server failure is reconnecting, never session expired; CLOSED retries", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
    const { connection, source, states } = setup();
    try {
      source.send(valid);
      const count = FakeEventSource.instances.length;
      source.fail(2);
      await tick();
      assert.equal(states.at(-1), "reconnecting");
      await new Promise((resolve) => setTimeout(resolve, 3_100));
      assert.equal(FakeEventSource.instances.length, count + 1);
      FakeEventSource.instances.at(-1)!.send(valid);
      assert.equal(states.at(-1), "open");
    } finally { connection.close(); }
  });

  await t.test("native retries do not create duplicate connections", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
    const { connection, source, states } = setup();
    try {
      const count = FakeEventSource.instances.length;
      source.fail();
      await tick();
      assert.equal(FakeEventSource.instances.length, count);
      assert.equal(states.at(-1), "reconnecting");
    } finally { connection.close(); }
  });

  await t.test("only a confirmed 401 expires the session and closes the source", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 401 }));
    const { connection, source, states } = setup();
    try {
      source.fail(2);
      await tick();
      assert.equal(states.at(-1), "session-expired");
      assert.equal(source.closed, true);
      const count = FakeEventSource.instances.length;
      connection.reconnect();
      assert.equal(FakeEventSource.instances.length, count);
    } finally { connection.close(); }
  });

  await t.test("manual reconnect ignores old frames and cleanup ignores late auth results", async (t) => {
    let finish: ((response: Response) => void) | undefined;
    t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => { finish = resolve; }));
    const { connection, source, states, snapshots } = setup();
    source.fail();
    connection.reconnect();
    assert.equal(source.closed, true);
    source.send(valid);
    assert.equal(snapshots.length, 0);
    const latest = FakeEventSource.instances.at(-1)!;
    latest.send(valid);
    connection.close();
    finish?.(new Response(null, { status: 401 }));
    await tick();
    assert.equal(states.at(-1), "open");
    latest.send(valid);
    assert.equal(snapshots.length, 1);
    assert.equal(latest.closed, true);
  });
});

test("snapshot age advances independently of the stream; missing health stays unknown", () => {
  assert.equal(snapshotAge(1_000, 96_000), 95);
  assert.equal(snapshotAge(null, 96_000), null);
  assert.equal(snapshotAge(100, 0), 0);
  assert.equal(formatAge(null), "Belum tersedia");
  assert.equal(formatAge(120), "2 mnt lalu");
  assert.equal(laneState({ ageSec: 2, fresh: true }, 95, false).tone, "unknown");
  assert.equal(laneState(undefined, 0, true).tone, "unknown");
});

const variant: RobinhoodVariantView = {
  id: "rh-momentum", cohort: "stop-quality", equityUsd: 98, pnlUsd: -2, trades: 2,
  wins: 0, losses: 2, winRate: 0, maxDdPct: 2, openPositions: 1, life: 1,
  cumulativePnlUsd: -2, bankrupt: false, exposureUsd: 5, status: "jalan",
  positions: [{ symbol: "TEST", lastPrice: 0.25, markAgeSec: 20, notionalUsd: 5 }],
};

test("variant search matches id, cohort and token; open filter composes with search", () => {
  const variants = [variant, { ...variant, id: "rh-closed", openPositions: 0, positions: [] }];
  assert.equal(filterVariants(variants, "  TEST ", false).length, 1);
  assert.equal(filterVariants(variants, "stop-quality", false).length, 2);
  assert.equal(filterVariants(variants, "rh-closed", true).length, 0);
  assert.equal(filterVariants(variants, "", true).length, 1);
  assert.equal(filterVariants(variants, "missing", false).length, 0);
});

test("overview does not invent zero values and never claims disconnected lanes are active", () => {
  const html = renderToStaticMarkup(<DashboardOverview data={{}} age={null} healthy={false} onSelect={() => {}} />);
  assert.equal((html.match(/<dd>—<\/dd>/g) ?? []).length, 4);
  assert.ok(!html.includes("state-active"));
  assert.ok(!/NaN|undefined|Infinity/.test(html));
  const disconnected = renderToStaticMarkup(<DashboardOverview data={{ laneHealth: { robinhood: { ageSec: 1, fresh: true } } }} age={120} healthy={false} onSelect={() => {}} />);
  assert.ok(disconnected.includes("Belum terverifikasi"));
  assert.ok(!disconnected.includes("state-active"));
});

test("stale and malformed feeds show actionable status without false live badges", () => {
  const stale = renderToStaticMarkup(<FeedStatus status="open" age={100} error={null} onReconnect={() => {}} />);
  assert.ok(stale.includes("Belum ada snapshot baru"));
  assert.ok(stale.includes("Sambungkan ulang"));
  const top = renderToStaticMarkup(<TopBar data={null} status="connecting" healthy={false} onOpenControl={() => {}} onOpenDiagnostics={() => {}} />);
  assert.ok(top.includes("Mode belum tersedia"));
  assert.ok(!top.includes("Feed tersambung"));
});
