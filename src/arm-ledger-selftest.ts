import { strict as assert } from "node:assert";
import { VirtualArmLedger } from "./experiments/arm-ledger.js";

const make = (armId: string) => new VirtualArmLedger({
  armId,
  policyId: `policy-${armId}`,
  startingSol: 0.1,
  maxPositions: 2,
  maxPerCluster: 1,
});
const a = make("A");
const b = make("B");

const a1 = a.admit({ decisionId: "d1", mint: "m1", stakeSol: 0.03, clusterIds: ["actor-x"] });
assert.equal(a1.ok, true);
if (!a1.ok) throw new Error("fixture");
assert.equal(a.snapshot().pendingSol, 0.03);
assert.equal(b.snapshot().pendingSol, 0, "pending capital must be isolated per arm");
a.commit(a1.reservationId);
assert.equal(a.snapshot().freeSol, 0.07);

assert.deepEqual(
  a.admit({ decisionId: "d2", mint: "m2", stakeSol: 0.03, clusterIds: ["actor-x"] }),
  { ok: false, reason: "CLUSTER_CAP" },
);
const b2 = b.admit({ decisionId: "d2", mint: "m2", stakeSol: 0.03, clusterIds: ["actor-x"] });
assert.equal(b2.ok, true, "arm A exposure must not consume arm B capacity");
if (!b2.ok) throw new Error("fixture");
b.commit(b2.reservationId);
b.quarantine("d2");
assert.equal(b.snapshot().quarantinedSol, 0.03);
assert.equal(b.snapshot().openPositions, 0);
assert.equal(b.snapshot().freeSol, 0.07, "missing quote must not release unknown capital");

const a3 = a.admit({ decisionId: "d3", mint: "m3", stakeSol: 0.03, clusterIds: ["actor-y"] });
assert.equal(a3.ok, true);
if (!a3.ok) throw new Error("fixture");
assert.equal(a.snapshot().availableSol, 0.04);
assert.deepEqual(
  a.admit({ decisionId: "d4", mint: "m4", stakeSol: 0.03, clusterIds: ["actor-z"] }),
  { ok: false, reason: "POSITION_CAP" },
);

a.cancel(a3.reservationId);
assert.equal(a.snapshot().pendingSol, 0);
a.partial("d1", 0.012, 0.018);
assert.equal(a.snapshot().freeSol, 0.088);
assert.equal(a.snapshot().deployedCostSol, 0.018);
assert.equal(a.snapshot().realizedPnlSol, 0.006);
a.close("d1", 0.042);
assert.equal(a.snapshot().realizedPnlSol, 0.03);
assert.equal(a.snapshot().freeSol, 0.13);
assert.deepEqual(
  a.admit({ decisionId: "d1", mint: "m1", stakeSol: 0.03 }),
  { ok: false, reason: "DUPLICATE_DECISION" },
);

const persisted = a.toState();
const restored = VirtualArmLedger.fromState(a.cfg, JSON.parse(JSON.stringify(persisted)));
assert.deepEqual(restored.toState(), persisted);
assert.deepEqual(restored.snapshot(), a.snapshot());
assert.throws(() => VirtualArmLedger.fromState({ ...a.cfg, policyId: "changed" }, persisted));
assert.throws(() => VirtualArmLedger.fromState(a.cfg, { ...persisted, pendingLamports: 1 }));

console.log("arm-ledger-selftest: 22/22 passed");
