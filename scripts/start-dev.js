const { spawn } = require("node:child_process");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

async function start() {
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: path.join(projectRoot, "vite.config.mjs"),
  });
  await vite.listen();

  const address = vite.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Vite dev server did not expose a TCP address");
  }
  const rendererUrl = `http://127.0.0.1:${address.port}/html/index.html`;
  console.log(`NCE renderer: ${rendererUrl}`);

  const electronEnvironment = {
    ...process.env,
    NCE_RENDERER_URL: rendererUrl,
  };
  delete electronEnvironment.ELECTRON_RUN_AS_NODE;

  const electron = spawn(
    require("electron"),
    [path.join(projectRoot, "dist/main.js")],
    {
      cwd: projectRoot,
      env: electronEnvironment,
      stdio: "inherit",
    },
  );

  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    if (electron.exitCode === null && !electron.killed) electron.kill(signal);
    await vite.close();
  };

  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));
  electron.once("error", async (error) => {
    console.error("Failed to start Electron:", error);
    await close("SIGTERM");
    process.exitCode = 1;
  });
  electron.once("exit", async (code, signal) => {
    await close("SIGTERM");
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

start().catch((error) => {
  console.error("Failed to start the NCE development renderer:", error);
  process.exitCode = 1;
});
