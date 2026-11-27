/**
 * Run UI, driven inside a real Electron window.
 *
 * This function is stringified and evaluated in the renderer, so it must not
 * close over anything from the driver. It exercises the real Run control and
 * the real Output panel against a real process, and reports what it saw.
 *
 * It deliberately clicks the button rather than calling the panel directly:
 * the point is to prove the button, the panel and the main process agree.
 */
module.exports = async function runUiChecks({ workspace, pythonFile, jsFile, failingFile }) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitFor = async (predicate, description, timeout = 25000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await predicate()) return true;
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${description}`);
  };

  // The Output view is created the first time the panel opens, so everything
  // that reads it goes through these and never assumes it already exists.
  const panel = () => editor.runPanel;
  const needPanel = () => {
    const value = panel();
    if (!value) throw new Error("the Output panel was never created");
    return value;
  };
  const openFile = async (filePath) => {
    await editor.tabManager.openFileWithPath(filePath);
    await waitFor(
      () => editor.tabManager.activeFile?.path === filePath,
      `${filePath} to become active`,
    );
    await waitFor(() => editor.tabManager.activeFile?.isLoaded === true, "the file to load");
    await sleep(150);
  };

  // ---- the control exists and is wired --------------------------------
  const actionElement = document.querySelector(".run-action");
  if (!actionElement) throw new Error("the Run control is not in the tab strip");
  const actionButton = actionElement.querySelector(".run-action-button");
  if (!actionButton) throw new Error("the Run control has no button");

  // It must sit in the tab strip band, at its right edge.
  const strip = document.querySelector(".file-manager");
  const actionRect = actionElement.getBoundingClientRect();
  const stripRect = strip.getBoundingClientRect();
  if (actionRect.width < 20 || actionRect.height < 10)
    throw new Error(`the Run control has no size (${actionRect.width}x${actionRect.height})`);
  if (actionRect.top < stripRect.top - 2 || actionRect.bottom > stripRect.bottom + 2)
    throw new Error(
      `the Run control is outside the tab strip (action ${actionRect.top}-${actionRect.bottom}, strip ${stripRect.top}-${stripRect.bottom})`,
    );

  // ---- open a Python file and check the control is ready --------------
  await openFile(pythonFile);

  if (actionElement.dataset.mode !== "run")
    throw new Error(`Run should be enabled for a .py file, mode=${actionElement.dataset.mode}`);
  const runLabel = actionElement.querySelector(".run-action-label").textContent;
  if (runLabel !== "Run") throw new Error(`Run label was "${runLabel}"`);

  // ---- click Run and watch the real lifecycle -------------------------
  const states = [];
  actionButton.click();

  await waitFor(() => panel(), "the Output panel to be created");
  // Record every state from here on; the first ones may already have landed.
  const controller = needPanel().controller;
  const originalApply = controller.apply.bind(controller);
  controller.apply = (event) => {
    if (event?.type === "state") states.push(event.state);
    return originalApply(event);
  };

  await waitFor(
    () => controller.state === "success",
    `the run to succeed (state=${controller.state})`,
  );

  // The panel opened by itself, and it is the Output panel.
  if (editor.bottomPanelManager.activePanelId !== "run")
    throw new Error(`the wrong panel opened: ${editor.bottomPanelManager.activePanelId}`);

  // Output is on screen, in the right kind of line.
  const view = needPanel();
  const text = view.log.textContent;
  if (!/bonjour/.test(text)) throw new Error(`stdout missing from the log: ${text}`);
  if (view.log.querySelectorAll(".run-panel-line-stdout").length === 0)
    throw new Error("no stdout line was rendered");

  // The facts row names the file, the runtime and the exit code.
  if (view.info.hidden) throw new Error("the run facts are hidden after a run");
  if (!/main\.py/.test(view.infoFile.textContent))
    throw new Error(`the file name is not shown: ${view.infoFile.textContent}`);
  if (!/python/i.test(view.infoRuntime.textContent))
    throw new Error(`the runtime is not shown: ${view.infoRuntime.textContent}`);
  const pythonRuntime = view.infoRuntime.textContent;
  if (!/exit 0/.test(view.infoResult.textContent))
    throw new Error(`the exit code is not shown: ${view.infoResult.textContent}`);

  if (view.status.textContent !== "Finished")
    throw new Error(`status was "${view.status.textContent}"`);
  if (view.stopButton.hidden !== true) throw new Error("Stop is still visible after finishing");
  if (actionElement.dataset.mode !== "run")
    throw new Error("the control did not return to Run after finishing");

  // ---- a failing program ----------------------------------------------
  await openFile(failingFile);
  actionButton.click();
  await waitFor(
    () => controller.state === "error",
    `the failing run to end in error (state=${controller.state})`,
  );

  if (view.status.textContent !== "Failed")
    throw new Error(`status was "${view.status.textContent}" for a failing run`);
  if (!/exit 1/.test(view.infoResult.textContent))
    throw new Error(`the non-zero exit code is not shown: ${view.infoResult.textContent}`);
  if (view.log.querySelectorAll(".run-panel-line-stderr").length === 0)
    throw new Error("no stderr line was rendered");
  if (!/ValueError/.test(view.log.textContent)) throw new Error("the traceback was swallowed");
  // A program that failed on its own gets no remedy button.
  if (!view.errorBlock.hidden)
    throw new Error("an error block with no remedy was shown for a plain non-zero exit");

  // ---- a long-running program: Stop -----------------------------------
  await openFile(jsFile);
  actionButton.click();
  await waitFor(
    () => controller.state === "running",
    `the long run to start (state=${controller.state})`,
  );

  if (actionElement.dataset.mode !== "stop")
    throw new Error(`the control should read Stop while running, mode=${actionElement.dataset.mode}`);
  if (view.stopButton.hidden !== false) throw new Error("the panel does not offer Stop");
  // Running is reported on spawn, which is before the first byte of stdout.
  // Waiting here is the point: the output must arrive while the program is
  // still alive, not only once it has exited.
  await waitFor(
    () => /started/.test(view.log.textContent),
    `output to arrive while the program is still running (state=${controller.state}, ` +
      `log=${JSON.stringify(view.log.textContent.slice(0, 200))})`,
    10000,
  );
  if (controller.state !== "running")
    throw new Error(`the program ended before its output was read (state=${controller.state})`);

  // Closing the panel must not kill the program: the run belongs to the file,
  // not to the view.
  editor.bottomPanelManager.closePanel({ restoreFocus: false });
  await sleep(300);
  if (controller.state !== "running")
    throw new Error(`closing the panel ended the run (state=${controller.state})`);
  if (actionElement.dataset.mode !== "stop")
    throw new Error("the control lost its Stop state when the panel closed");

  // Reopening shows the same run, log intact.
  await editor.bottomPanelManager.openPanel("run", { focus: false });
  await sleep(200);
  if (!/started/.test(view.log.textContent))
    throw new Error("the log was lost when the panel was closed and reopened");

  actionButton.click();
  await waitFor(
    () => controller.state === "cancelled",
    `the run to be cancelled (state=${controller.state})`,
  );
  if (view.status.textContent !== "Stopped")
    throw new Error(`a cancelled run read "${view.status.textContent}"`);
  if (!view.errorBlock.hidden) throw new Error("a cancelled run was presented as an error");

  // ---- Clear does not stop anything -----------------------------------
  actionButton.click();
  await waitFor(() => controller.state === "running", "the run to start again");
  await waitFor(() => /started/.test(view.log.textContent), "output to arrive");

  view.clearButton.click();
  await sleep(100);
  if (view.log.textContent.includes("started")) throw new Error("Clear did not empty the log");
  if (controller.state !== "running") throw new Error("Clear stopped the process");

  await view.stop();
  await waitFor(() => controller.state === "cancelled", "the run to stop");

  // ---- an unsupported file disables the control -----------------------
  const tsFile = jsFile.replace(/\.js$/, ".ts");
  await openFile(tsFile);
  if (actionElement.dataset.mode !== "disabled")
    throw new Error(`Run should be disabled for a .ts file, mode=${actionElement.dataset.mode}`);
  if (!/build step/.test(actionButton.title))
    throw new Error(`the disabled reason does not explain TypeScript: ${actionButton.title}`);

  // Leave the panel in a state worth photographing: a successful run.
  await openFile(pythonFile);
  actionButton.click();
  await waitFor(() => controller.state === "success", "the final run to succeed");
  await sleep(200);

  return {
    actionPresent: true,
    actionAligned: true,
    lifecycle: states,
    stdoutRendered: true,
    runtimeShown: pythonRuntime,
    successStatus: "Finished",
    errorStatus: "Failed",
    cancelledStatus: "Stopped",
    stopWorked: true,
    closeKeptRunning: true,
    clearKeptRunning: true,
    typescriptDisabled: true,
  };
};
