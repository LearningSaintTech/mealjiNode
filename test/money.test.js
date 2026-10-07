import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPaise, fromPaise, percentOf, splitGst, toPaise } from "../src/common/money.js";

test("converts rupees and paise", () => {
  assert.equal(toPaise(299), 29900);
  assert.equal(toPaise("12.345"), 1235);
  assert.equal(fromPaise(29900), 299);
});

test("rejects non-integer paise", () => {
  assert.throws(() => assertPaise(10.5));
  assert.throws(() => assertPaise(-1));
  assert.equal(assertPaise(0), 0);
});

test("percent rounds half up", () => {
  assert.equal(percentOf(1000, 5), 50);
  assert.equal(percentOf(1010, 5), 51);
});

test("GST halves always add back to the total", () => {
  for (const amount of [1, 3, 99, 1001, 87_654]) {
    const gst = splitGst(amount, 5);
    assert.equal(gst.cgst + gst.sgst, gst.total);
    assert.equal(gst.igst, 0);
  }
  const inter = splitGst(10_000, 18, { interState: true });
  assert.deepEqual(inter, { cgst: 0, sgst: 0, igst: 1800, total: 1800 });
});
