const assert = require("node:assert/strict");
const test = require("node:test");
const { mapWithConcurrency } = require("../dist/ts/util/Concurrency.js");

test("mapWithConcurrency preserves input order and bounds in-flight work", async () => {
  const items = Array.from({ length: 25 }, (_, index) => index);
  let active = 0;
  let maxActive = 0;

  const results = await mapWithConcurrency(items, 4, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, (items.length - item) % 5));
    active -= 1;
    return item * 2;
  });

  assert.deepEqual(results, items.map((item) => item * 2));
  assert.ok(maxActive <= 4, `expected at most 4 in-flight workers, saw ${maxActive}`);
  assert.ok(maxActive > 1, "independent work is not serialized");
});

test("mapWithConcurrency handles empty input and non-positive limits", async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);

  const visited = [];
  const results = await mapWithConcurrency([1, 2, 3], 0, async (item) => {
    visited.push(item);
    return item;
  });
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(visited, [1, 2, 3]);
});

test("mapWithConcurrency propagates worker failures", async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("worker failed");
      return item;
    }),
    /worker failed/,
  );
});
