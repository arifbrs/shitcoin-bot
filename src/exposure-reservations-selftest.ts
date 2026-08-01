import { strict as assert } from "node:assert";
import { ExposureReservationBook } from "./util/exposure-reservations.js";

const book = new ExposureReservationBook();
assert.equal(book.overlappingCount(["actor-a"]), 0);
const r1 = book.reserve(["actor-a", "funder-z"]);
assert.equal(book.overlappingCount(["actor-a"]), 1);
assert.equal(book.overlappingCount(["funder-z"]), 1);
assert.equal(book.overlappingCount(["actor-b"]), 0);
const r2 = book.reserve(["actor-b", "funder-z"]);
assert.equal(book.overlappingCount(["funder-z"]), 2);
assert.equal(book.overlappingCount(["actor-a", "funder-z"]), 2, "one reservation counts once");
book.release(r1);
assert.equal(book.overlappingCount(["actor-a"]), 0);
assert.equal(book.overlappingCount(["funder-z"]), 1);
book.release(r2);
book.release(r2);
assert.equal(book.size(), 0);

console.log("exposure-reservations-selftest: 10/10 passed");
