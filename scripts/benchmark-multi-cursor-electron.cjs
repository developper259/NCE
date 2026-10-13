const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function run() {
  const appRoot = path.resolve(process.argv[2] || process.cwd());
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nce-multi-cursor-bench-"));
  await fs.writeFile(path.join(directory, ".nce-smoke"), "");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.NCE_BENCH_APP_ROOT = appRoot;

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        require("electron"),
        [path.join(__dirname, "../tests/electron/driver.cjs"), directory, "benchmark"],
        { env: environment, stdio: ["ignore", "pipe", "pipe"] },
      );
      let log = "";
      child.stdout.on("data", (chunk) => { log += chunk; });
      child.stderr.on("data", (chunk) => { log += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(Error(`Electron benchmark exited ${code}/${signal}:\n${log}`));
      });
    });

    assert.equal(await fs.readFile(path.join(directory, "benchmark.ok"), "utf8"), "ok");
    const report = JSON.parse(await fs.readFile(
      path.join(directory, "multi-cursor-benchmark.json"),
      "utf8",
    ));
    process.stdout.write(`${JSON.stringify({
      ...report,
      appRoot,
      platform: `${process.platform}/${process.arch}`,
      cpu: os.cpus()[0]?.model || "unknown",
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      methodology: "one warmup plus fifteen timed writes per cursor count; fifteen single-cursor typing, Backspace, Enter, and Undo samples; thirty scroll samples measured through the next animation frame; selection setup is flushed through one animation frame before timing, and recovery undo is outside typing measurements",
    }, null, 2)}\n`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
