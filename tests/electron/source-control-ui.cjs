module.exports = async function exerciseSourceControlUI(workspace, stage = "repository") {
  const check = (condition, message) => {
    if (!condition) throw Error(message);
  };
  const nextFrame = () => new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 250);
  });
  const rectOf = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  };
  const waitFor = async (predicate, description, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw Error(`Timed out waiting for ${description}`);
  };

  const git = editor.gitSidebar;
  check(Boolean(git), "Source Control sidebar exists");
  editor.sidebarManager.openMenu("git");
  await waitFor(() => git.isOpen && Boolean(git.container), "Source Control sidebar to open");

  if (stage === "initialize") {
    // State A: no repository.
    await waitFor(
      () => git.getViewState().mode === "no-repository",
      "no-repository state",
    );
    await nextFrame();
    check(git.commitBoxElement.hidden === true, "commit form is hidden without a repository");
    check(git.listElement.hidden === true, "change list is hidden without a repository");
    check(git.stateElement.hidden === false, "empty repository state is visible");
    check(git.stateTitleElement.textContent === "No Git repository", "no-repository title");
    check(
      git.stateText.textContent === "This workspace is not tracked by Git.",
      "no-repository description",
    );
    check(
      git.stateInit.hidden === false &&
        git.stateInit.textContent === "Initialize Repository",
      "primary initialization action",
    );
    check(git.stateRefresh.hidden === false, "secondary refresh action");
    check(
      getComputedStyle(git.stateInit).cursor === "pointer",
      "initialization action shows a pointer cursor",
    );
    const branchIndicator = document.querySelector(".bottomBar-git-branch");
    check(Boolean(branchIndicator), "bottom-bar branch control exists");
    await nextFrame();
    check(
      branchIndicator.hidden === true,
      "bottom bar hides the branch without a repository",
    );

    // State B: initialize then clean repository.
    git.stateInit.click();
    await waitFor(() => git.getViewState().mode === "clean", "clean state after initialization");
    await nextFrame();
    check(git.commitBoxElement.hidden === true, "commit form is hidden on a clean repository");
    check(git.listElement.hidden === true, "change list is hidden on a clean repository");
    check(git.stateElement.hidden === false, "clean state is visible");
    check(git.stateTitleElement.textContent === "Working tree clean", "clean state title");
    check(git.stateText.textContent === "No changes to commit.", "clean state description");
    check(git.summaryElement.hidden === false, "branch summary is visible");
    check(git.branchNameElement.textContent.trim().length > 0, "current branch is displayed");
    check(
      Boolean(git.summaryElement.querySelector(".fi-rr-code-branch")),
      "branch icon is displayed",
    );
    await waitFor(
      () => branchIndicator.hidden === false,
      "bottom-bar branch indicator",
    );
    check(
      branchIndicator.textContent.includes(git.branchNameElement.textContent.trim()),
      "bottom bar shows the current branch",
    );
    check(
      branchIndicator.getAttribute("aria-label").includes("Open Source Control"),
      "bottom-bar branch opens Source Control",
    );
    editor.sidebarManager.closeMenu("git");
    branchIndicator.click();
    await waitFor(() => git.isOpen, "bottom-bar branch to reopen Source Control");
    check(git.stateRefresh.hidden === false, "clean state offers refresh");
    return { mode: "clean", branch: git.branchNameElement.textContent.trim() };
  }

  await waitFor(
    () => git.getViewState().mode === "clean",
    "clean state before repository fixture",
  );

  // State C: changes.
  const fileName = "source-control-long-file-name-for-sidebar-layout-verification.js";
  const fileLines = Array.from({ length: 120 }, (_, index) =>
    `const line${index} = ${index};`);
  const created = await editor.fileExplorer.fileOperations.createFile(
    workspace,
    fileName,
    `${fileLines.join("\n")}\n`,
    true,
  );
  check(created?.success === true, "fixture file is created");
  await git.refresh({ reason: "manual" });
  await waitFor(() => git.getViewState().mode === "changes", "changes state");
  await nextFrame();
  check(git.commitBoxElement.hidden === false, "commit form is visible with changes");
  check(git.listElement.hidden === false, "change list is visible with changes");
  check(git.stateElement.hidden === true, "empty state is hidden with changes");
  check(git.commitInput.placeholder === "Commit message...", "commit placeholder");
  check(git.commitButton.disabled === true, "commit is disabled before staging");
  const row = git.listLayer.querySelector(
    `.git-file-row[data-path="${fileName}"]`,
  );
  check(Boolean(row), "untracked file row is visible");
  check(
    row.querySelector(".git-status-badge").textContent === "U",
    "untracked status letter is displayed",
  );
  check(
    getComputedStyle(row.querySelector(".git-file-actions")).marginRight === "4px",
    "stage action keeps space from the row edge",
  );
  check(
    [...git.listLayer.querySelectorAll(".git-section-title")]
      .some((element) => element.textContent === "Changes"),
    "Changes section is visible",
  );

  // Responsive widths.
  const sidebar = document.querySelector(".sidebar-left");
  const originalWidth = sidebar.style.width;
  sidebar.style.width = "190px";
  await nextFrame();
  check(
    git.container.scrollWidth <= git.container.clientWidth + 1,
    "narrow sidebar has no horizontal overflow",
  );
  check(
    getComputedStyle(git.repoNameElement).display === "none",
    "repository name hides at narrow width",
  );
  check(
    getComputedStyle(row.querySelector(".git-file-name")).textOverflow === "ellipsis",
    "long file names use ellipsis",
  );
  sidebar.style.width = "320px";
  await nextFrame();
  check(
    getComputedStyle(git.repoNameElement).display !== "none",
    "repository name returns at wide width",
  );
  check(
    git.container.scrollWidth <= git.container.clientWidth + 1,
    "wide sidebar has no horizontal overflow",
  );
  sidebar.style.width = originalWidth;
  await nextFrame();

  // Stage, write a message and commit through real Git operations.
  const stageRow = git.listLayer.querySelector(
    `.git-file-row[data-path="${fileName}"]`,
  );
  stageRow.querySelector(".git-file-action").click();
  await waitFor(() => git.getViewState().staged.length === 1, "file to stage");
  await waitFor(() => {
    const state = git.getViewState();
    return state.mode === "changes" && state.changes.length === 0;
  }, "staged-only changes state");
  await nextFrame();
  check(
    [...git.listLayer.querySelectorAll(".git-section-title")]
      .map((element) => element.textContent)
      .join(",") === "Staged Changes",
    "empty change sections are not rendered",
  );
  check(git.commitButton.disabled === true, "commit stays disabled with an empty message");
  git.commitInput.value = "feat: source control redesign";
  git.commitInput.dispatchEvent(new Event("input", { bubbles: true }));
  check(git.commitButton.disabled === false, "commit enables with a staged change and message");
  git.commitButton.click();
  await waitFor(() => git.getViewState().mode === "clean", "clean state after commit");
  await nextFrame();
  check(git.commitBoxElement.hidden === true, "commit form hides after commit");
  check(git.listElement.hidden === true, "change list hides after commit");
  check(git.stateTitleElement.textContent === "Working tree clean", "clean state after commit");
  await waitFor(
    () => editor.notificationManager.getNotifications()
      .some((notification) => notification.title === "Commit created"),
    "commit result notification",
    3000,
  );

  // Bottom bar ordering: bell first, then the status items, all right aligned.
  const filePath = `${workspace}${workspace.includes("\\") ? "\\" : "/"}${fileName}`;
  await editor.tabManager.openFileWithPath(filePath);
  await waitFor(
    () => editor.tabManager.activeFile?.path === filePath &&
      editor.tabManager.activeFile?.isLoaded === true,
    "fixture file to open for bottom bar layout",
  );
  await nextFrame();
  const rightGroup = document.querySelector(".bottomBar .right");
  const bellGroup = rightGroup?.querySelector(".nce-bottom-bar-actions");
  check(Boolean(rightGroup && bellGroup), "notification bell is in the right status group");
  check(
    rightGroup.lastElementChild === bellGroup,
    "notification bell sits at the far right of the status group",
  );
  const languageItem = rightGroup.querySelector("#language");
  check(
    getComputedStyle(languageItem).display !== "none" &&
      languageItem.getBoundingClientRect().right <=
        bellGroup.getBoundingClientRect().left + 1,
    "right status items precede the notification bell",
  );
  check(
    rightGroup.getBoundingClientRect().right <= innerWidth - 1,
    "right status group stays aligned to the window edge",
  );
  editor.bottomBar.hide();
  await nextFrame();
  check(
    getComputedStyle(bellGroup).display !== "none" &&
      bellGroup.getBoundingClientRect().width > 0,
    "notification bell remains visible in a collapsed bottom bar",
  );
  editor.bottomBar.show();
  await nextFrame();
  const terminalToggle = document.querySelector(".bottomBar-terminal-toggle");
  terminalToggle.setAttribute("aria-expanded", "true");
  await nextFrame();
  check(
    getComputedStyle(terminalToggle).backgroundColor === "rgba(0, 0, 0, 0)",
    "expanded Terminal does not paint a bottom-bar highlight",
  );
  terminalToggle.setAttribute("aria-expanded", "false");

  // Problems and warnings indicators open the Problems panel.
  const diagnostics = [
    { severity: 1, message: "Error one", range: { start: { line: 80, character: 0 }, end: { line: 80, character: 1 } } },
    { severity: 1, message: "Error two", range: { start: { line: 90, character: 2 }, end: { line: 90, character: 3 } } },
    { severity: 2, message: "Warning one", range: { start: { line: 4, character: 4 }, end: { line: 4, character: 5 } } },
    { severity: 3, message: "Info one", range: { start: { line: 6, character: 6 }, end: { line: 6, character: 7 } } },
  ];
  editor.lspController.handleDiagnostics({
    documents: [{
      path: filePath,
      uri: `file://${filePath.replace(/\\/g, "/")}`,
      diagnostics,
    }],
  });
  await nextFrame();
  const problemsControl = document.querySelector(".bottomBar-problems");
  const errorIndicator = problemsControl?.querySelector(
    '.bottomBar-problem[data-severity="error"]',
  );
  const warningIndicator = problemsControl?.querySelector(
    '.bottomBar-problem[data-severity="warning"]',
  );
  check(Boolean(problemsControl && errorIndicator && warningIndicator),
    "single Problems control exists");
  check(
    problemsControl.tagName === "DIV" &&
      problemsControl.getAttribute("role") === "button" &&
      problemsControl.tabIndex === 0 &&
      problemsControl.querySelectorAll("button").length === 0,
    "Problems and warnings share one div control",
  );
  check(
    document.querySelector(".bottomBar .left")?.lastElementChild === problemsControl,
    "Problems control follows Terminal",
  );
  check(problemsControl.dataset.errors === "2", "error count reflects diagnostics");
  check(problemsControl.dataset.warnings === "1", "warning count reflects diagnostics");
  check(
    problemsControl.getAttribute("aria-label") ===
      "2 errors, 1 warning. Open Problems panel.",
    "Problems control exposes both counts",
  );
  check(
    getComputedStyle(problemsControl).cursor === "pointer",
    "Problems control shows a pointer cursor",
  );
  const errorCount = errorIndicator.querySelector(".bottomBar-problem-count");
  const errorIcon = errorIndicator.querySelector("i");
  const errorCountRect = rectOf(errorCount);
  const errorIconRect = rectOf(errorIcon);
  const problemsControlRect = rectOf(problemsControl);
  check(
    errorIndicator.firstElementChild === errorCount &&
      errorCountRect.right <= errorIconRect.left + 1,
    "problem count sits to the left of its icon",
  );
  check(
    getComputedStyle(problemsControl).alignItems === "center" &&
      getComputedStyle(errorIndicator).alignItems === "center",
    "problem count and icon are centered in the single control",
  );
  check(
    Math.abs(
      (errorCountRect.top + errorCountRect.bottom) / 2 -
        (problemsControlRect.top + problemsControlRect.bottom) / 2,
    ) <= 1.5 &&
      Math.abs(
        (errorIconRect.top + errorIconRect.bottom) / 2 -
          (problemsControlRect.top + problemsControlRect.bottom) / 2,
      ) <= 1.5,
    "problem count and icon are vertically centered",
  );
  problemsControl.click();
  await waitFor(
    () => editor.bottomPanelManager.activePanelId === "problems" &&
      Boolean(document.querySelector(".problems-panel")),
    "Problems panel to open from the bottom bar",
  );
  await nextFrame();
  check(
    document.querySelector(".problems-panel-summary").textContent
      .startsWith("2 errors, 1 warning, 1 info"),
    "Problems panel reflects the same counts",
  );
  check(
    document.querySelector(".bottomBar-terminal-toggle")
      .getAttribute("aria-expanded") === "false",
    "Terminal is not highlighted while Problems is active",
  );
  const deepProblem = document.querySelector('.problem-row[data-line="80"]');
  check(Boolean(deepProblem), "deep problem row exists");
  deepProblem.click();
  await waitFor(
    () => editor.tabManager.activeFile?.row === 81 &&
      editor.tabManager.activeFile?.column === 0,
    "problem row to place the cursor",
  );
  await nextFrame();
  const checkCaretVisible = (label) => {
    const caret = document.querySelector(".editor-caret");
    const caretRect = caret.getBoundingClientRect();
    const editorRect = editor.editorOBJ.getBoundingClientRect();
    const caretState = {
      display: getComputedStyle(caret).display,
      top: caretRect.top,
      left: caretRect.left,
      height: caretRect.height,
      editorTop: editorRect.top,
      editorBottom: editorRect.bottom,
      row: editor.tabManager.activeFile?.row,
      startIndex: editor.lineController.startIndex,
      activeTag: document.activeElement?.tagName,
      activeClass: document.activeElement?.className,
    };
    check(
      caretState.display !== "none" &&
        caretState.height > 0 &&
        caretState.top >= editorRect.top &&
        caretState.top < editorRect.bottom,
      `${label}: ${JSON.stringify(caretState)}`,
    );
  };
  checkCaretVisible("caret is visible after problem navigation");

  await editor.tabManager.closeTab(editor.tabManager.activeFile);
  await waitFor(
    () => !editor.tabManager.activeFile,
    "fixture file to close before reopening from Problems",
  );
  deepProblem.click();
  await waitFor(
    () => editor.tabManager.activeFile?.row === 81 &&
      editor.tabManager.activeFile?.column === 0,
    "problem row to reopen the closed file at its diagnostic",
  );
  await nextFrame();
  checkCaretVisible("caret is visible after reopening a closed file from Problems");
  editor.lspController.handleDiagnostics({ documents: [] });
  editor.bottomPanelManager.closePanel({ restoreFocus: false });
  await nextFrame();
  check(
    problemsControl.dataset.errors === "0" &&
      problemsControl.dataset.warnings === "0",
    "problem indicators reset with the diagnostics",
  );

  // State D: contextual error.
  git.status = null;
  git.applyStatusError({ code: "GIT_TIMEOUT", error: "Git did not respond in time." });
  git.updateView();
  await nextFrame();
  check(git.getViewState().mode === "error", "error state");
  check(git.stateTitleElement.textContent === "Git did not respond", "error state title");
  check(
    git.stateDetailsElement.hidden === false &&
      git.stateCodeElement.textContent === "GIT_TIMEOUT",
    "technical error code is available",
  );
  check(
    git.stateRetry.hidden === false && git.stateRetry.textContent === "Retry",
    "error state offers retry",
  );
  check(git.commitBoxElement.hidden === true, "commit form is hidden on error");
  check(git.listElement.hidden === true, "change list is hidden on error");
  await git.refresh({ reason: "manual" });
  await waitFor(() => git.getViewState().mode === "clean", "clean state after retry");

  // Theme compatibility.
  const previousTheme = editor.themeManager.getResolvedTheme();
  editor.themeManager.applyTheme("light");
  await nextFrame();
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  try {
    probe.style.color = getComputedStyle(document.documentElement)
      .getPropertyValue("--text-primary")
      .trim();
    check(
      getComputedStyle(git.stateTitleElement).color === getComputedStyle(probe).color,
      "state title follows the active theme",
    );
  } finally {
    probe.remove();
  }
  editor.themeManager.applyTheme(previousTheme);
  await nextFrame();

  return {
    mode: git.getViewState().mode,
    branch: git.branchNameElement.textContent.trim(),
    file: fileName,
  };
};
