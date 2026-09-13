const assert = require("node:assert/strict");
const test = require("node:test");
const {
  waitForCondition,
} = require("./electron/wait-for-condition.cjs");

test("renderer condition returns immediately when already satisfied", async () => {
  let polls = 0;
  await waitForCondition(async () => {
    polls += 1;
    return true;
  });
  assert.equal(polls, 1);
});

test("renderer condition polls until asynchronous state changes", async () => {
  let polls = 0;
  await waitForCondition(
    async () => {
      polls += 1;
      return polls === 3;
    },
    { timeout: 100, interval: 1, description: "test state" },
  );
  assert.equal(polls, 3);
});

test("renderer condition timeout reports the awaited state", async () => {
  await assert.rejects(
    waitForCondition(async () => false, {
      timeout: 5,
      interval: 1,
      description: "Quick Open to close after Escape",
    }),
    /Timed out waiting for Quick Open to close after Escape/,
  );
});
