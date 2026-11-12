import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { queryString, qstr, qnum } from "../src/lib/query.js";

describe("query coercion", () => {
  it("queryString takes the first element of arrays and rejects non-strings", () => {
    assert.equal(queryString("a"), "a");
    assert.equal(queryString(["a", "b"]), "a");
    assert.equal(queryString([]), undefined);
    assert.equal(queryString(undefined), undefined);
    assert.equal(queryString({ a: "b" }), undefined); // ?q[a]=b
    assert.equal(queryString([{ a: 1 }, "x"]), undefined);
    assert.equal(queryString(""), "");
    assert.equal(qstr, queryString);
  });

  it("qnum parses numbers and yields NaN for absent/blank/non-numeric", () => {
    assert.equal(qnum("42"), 42);
    assert.equal(qnum(["7", "8"]), 7);
    assert.equal(qnum("-1.5"), -1.5);
    assert.ok(Number.isNaN(qnum(undefined)));
    assert.ok(Number.isNaN(qnum("")));
    assert.ok(Number.isNaN(qnum("   ")));
    assert.ok(Number.isNaN(qnum("abc")));
    assert.ok(Number.isNaN(qnum({})));
  });
});
