module.exports = async function exerciseSourceControlUI(workspace, stage = "repository") {
  const check = (condition, message) => {
    if (!condition) throw Error(message);
  };
  const nextFrame = () => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
    check(git.stateRefresh.hidden === false, "clean state offers refresh");
    return { mode: "clean", branch: git.branchNameElement.textContent.trim() };
  }

  await waitFor(
    () => git.getViewState().mode === "clean",
    "clean state before repository fixture",
  );

  // State C: changes.
  const fileName = "source-control-long-file-name-for-sidebar-layout-verification.js";
  const created = await editor.fileExplorer.fileOperations.createFile(
    workspace,
    fileName,
    "const value = 1;\n",
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
  check(
    editor.notificationManager.getNotifications()
      .some((notification) => notification.title === "Commit created"),
    "commit result is notified",
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
