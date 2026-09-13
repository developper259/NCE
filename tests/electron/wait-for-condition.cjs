async function waitForCondition(
  check,
  { timeout = 2000, interval = 20, description = "condition" } = {},
) {
  const deadline = Date.now() + timeout;

  while (true) {
    if (await check()) return true;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

module.exports = { waitForCondition };
