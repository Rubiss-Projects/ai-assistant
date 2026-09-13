import assert from "node:assert/strict";
import test from "node:test";
import { acquireBrowserSlot, closeBrowserAndRelease } from "../src/utils/browserBudget.js";

test("browser admission bounds concurrent readers and removes cancelled waiters", async () => {
  const signal = new AbortController().signal;
  const first = await acquireBrowserSlot(signal);
  const cancelled = new AbortController();
  const abandoned = acquireBrowserSlot(cancelled.signal);
  const rejected = assert.rejects(abandoned, /cancelled/);
  cancelled.abort(new Error("cancelled"));
  await rejected;
  let admitted = false;
  const waiting = acquireBrowserSlot(signal).then(release => { admitted = true; return release; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admitted, false);
  first(); first(); // Releasing twice must not admit an extra browser.
  const third = await waiting;
  let fourthAdmitted = false;
  const fourth = acquireBrowserSlot(signal).then(release => { fourthAdmitted = true; return release; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fourthAdmitted, false);
  third(); (await fourth)();
});

test("a late cancelled launch holds its admission until the browser closes", async () => {
  const signal = new AbortController().signal;
  const first = await acquireBrowserSlot(signal);
  let complete!: (browser: any) => void;
  const launch = new Promise<any>(resolve => { complete = resolve; });
  await closeBrowserAndRelease(undefined, launch, first);
  let admitted = false, closed = false;
  const waiting = acquireBrowserSlot(signal).then(release => { admitted = true; return release; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admitted, false);
  complete({ close: async () => { closed = true; } });
  const third = await waiting;
  assert.equal(closed, true);
  third();
});
