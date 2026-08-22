import { strict as assert } from "node:assert";
import { clampedScaleSellQty } from "./trader.js";

const original = 100;
let remaining = original;
const first = clampedScaleSellQty(original, remaining, 0.4, 0.15);
remaining -= first;
const second = clampedScaleSellQty(original, remaining, 0.3, 0.15);
remaining -= second;
const third = clampedScaleSellQty(original, remaining, 0.15, 0.15);
remaining -= third;
const impossibleFourth = clampedScaleSellQty(original, remaining, 0.05, 0.15);

assert.equal(first, 40);
assert.equal(second, 30);
assert.equal(third, 15);
assert.equal(remaining, 15);
assert.equal(impossibleFourth, 0);
assert.equal(clampedScaleSellQty(100, 18, 0.05, 0.15), 3);

console.log("scaleout-selftest: 6/6 passed");
