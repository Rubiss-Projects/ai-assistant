import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { operationSignal } from "../src/common/operationSignal.js";

test("operation cancellation propagates its reason and removes parent listeners", () => {
  const parent = new AbortController();
  const operation = operationSignal(parent.signal, 10_000);
  assert.equal(operation.signal.aborted, false);
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);
  const reason = new Error("cancelled");
  parent.abort(reason);
  assert.equal(operation.signal.reason, reason);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  assert.equal(operationSignal(parent.signal, 10_000).signal.aborted, true);
});

test("deadlines work without AbortSignal.any and disposal cancels pending deadlines", async () => {
  const deadline = operationSignal(undefined, 5);
  const parent = new AbortController();
  const completed = operationSignal(parent.signal, 5);
  completed.dispose();
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  await delay(20);
  assert.equal(deadline.signal.aborted, true);
  assert.match(deadline.signal.reason.message, /timed out/);
  assert.equal(completed.signal.aborted, false);
});
