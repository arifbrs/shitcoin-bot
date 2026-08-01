import { strict as assert } from "node:assert";
import {
  applyOutcome,
  type ActorStore,
} from "./memory/actor-memory.js";

const store: ActorStore = {};
applyOutcome(store, {
  creator: "creator-a",
  funders: ["funder-z"],
  rugged: true,
  abandoned: false,
  sellableWin: false,
  at: 1,
});
applyOutcome(store, {
  creator: "creator-b",
  funders: ["funder-z"],
  rugged: false,
  abandoned: false,
  sellableWin: true,
  at: 2,
});
applyOutcome(store, {
  creator: "creator-a",
  funders: ["funder-z"],
  rugged: false,
  abandoned: true,
  sellableWin: false,
  at: 3,
});

assert.equal(store["creator-a"]?.launches, 2);
assert.equal(store["creator-a"]?.rugs, 1);
assert.equal(store["creator-a"]?.abandons, 1);
assert.equal(store["creator-b"]?.sellableWins, 1);
assert.equal(store["funder-z"]?.launches, 3);
assert.deepEqual(store["funder-z"]?.fundedActors.sort(), ["creator-a", "creator-b"]);
assert.deepEqual(store["creator-a"]?.fundedBy, ["funder-z"]);

console.log("actor-memory-selftest: 7/7 passed");
