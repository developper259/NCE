const assert = require("node:assert/strict");
const test = require("node:test");
const { GitTaskQueue } = require("../dist/ts/manager/GitTaskQueue.js");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("GitTaskQueue bounds concurrency and drains in order", async () => {
  const queue = new GitTaskQueue(2);
  let active = 0;
  let peak = 0;
  const started = [];
  const tasks = Array.from({ length: 8 }, (_, index) => queue.run(async () => {
    started.push(index);
    active += 1;
    peak = Math.max(peak, active);
    await delay(10);
    active -= 1;
    return index;
  }));
  assert.equal(await Promise.all(tasks).then((results) => results.join(",")), "0,1,2,3,4,5,6,7");
  assert.equal(peak, 2);
  assert.equal(queue.pendingCount, 0);
  assert.equal(queue.activeCount, 0);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("GitTaskQueue propagates failures without stalling later work", async () => {
  const queue = new GitTaskQueue(1);
  const results = await Promise.allSettled([
    queue.run(async () => { throw new Error("boom"); }),
    queue.run(async () => "after"),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[1].value, "after");
  assert.equal(queue.activeCount, 0);
});

test("GitTaskQueue rejects an invalid limit", () => {
  assert.throws(() => new GitTaskQueue(0), RangeError);
  assert.throws(() => new GitTaskQueue(1.5), RangeError);
});
