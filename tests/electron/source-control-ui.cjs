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
    const branchDirty = branchIndicator.querySelector(
      ".bottomBar-git-branch-dirty",
    );
    check(Boolean(branchDirty), "bottom-bar dirty marker exists");
    check(
      branchDirty.hidden === true,
      "clean branch shows no dirty marker",
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
  const secondFileName = "source-control-stage-all-second-file.txt";
  const createdSecond = await editor.fileExplorer.fileOperations.createFile(
    workspace,
    secondFileName,
    "second staged change\n",
    true,
  );
  check(createdSecond?.success === true, "second fixture file is created");
  await git.refresh({ reason: "manual" });
  await waitFor(() => git.getViewState().mode === "changes", "changes state");
  await nextFrame();
  check(
    git.getViewState().changes.length === 2,
    "both fixture changes are listed",
  );
  check(git.commitBoxElement.hidden === false, "commit form is visible with changes");
  check(git.listElement.hidden === false, "change list is visible with changes");
  check(git.stateElement.hidden === true, "empty state is hidden with changes");
  check(git.commitInput.placeholder === "Commit message...", "commit placeholder");
  check(
    git.commitInput.tagName === "INPUT" && git.commitInput.type === "text",
    "commit message uses a single-line input",
  );
  check(
    getComputedStyle(git.commitInput).borderTopStyle === "none" &&
      getComputedStyle(git.commitInput).backgroundColor === "rgba(0, 0, 0, 0)",
    "commit input blends into the composer bar",
  );
  const composerBar = git.commitInput.parentElement;
  const composerHeight = composerBar.getBoundingClientRect().height;
  check(
    composerBar.className.includes("git-composer-bar") &&
      composerHeight > 0 &&
      composerHeight <= 32,
    "commit composer is a single compact bar",
  );
  git.commitInput.value = `feat: ${"long message ".repeat(20)}`;
  git.commitInput.dispatchEvent(new Event("input", { bubbles: true }));
  await nextFrame();
  check(
    Math.abs(composerBar.getBoundingClientRect().height - composerHeight) <= 1,
    "a long commit message does not deform the composer bar",
  );
  git.commitInput.value = "";
  git.commitInput.dispatchEvent(new Event("input", { bubbles: true }));
  await nextFrame();
  check(git.commitButton.disabled === true, "commit is disabled before staging");
  check(
    git.commitStatus.getBoundingClientRect().width <= 1,
    "commit status text takes no visible space",
  );
  check(
    composerBar.children[0] === git.branchButton &&
      composerBar.children[1].className.includes("git-composer-separator") &&
      composerBar.children[2] === git.commitInput,
    "branch, separator and message are ordered left to right",
  );
  check(
    !git.commitBoxElement.querySelector(".fi-rr-pencil"),
    "composer has no pencil icon",
  );
  check(
    git.branchButton.textContent.includes("main") &&
      Boolean(git.branchButton.querySelector(".git-branch-button-arrow")),
    "branch selector shows the current branch and a dropdown arrow",
  );
  check(
    git.settingsButton.parentElement === composerBar &&
      git.settingsButton.nextElementSibling === git.commitButton,
    "Git settings sits directly left of Commit",
  );
  check(
    git.commitButton.title === "Commit changes" &&
      git.commitButton.getAttribute("aria-label") === "Commit changes" &&
      git.commitButton.textContent.trim() === "" &&
      git.commitButton.querySelector("i")?.className.includes("fi-rr-check"),
    "Commit is a compact icon action with an accessible tooltip",
  );
  check(
    document.querySelector(".git-composer-hint")?.textContent ===
      (editor.api.platform === "darwin" ? "⌘ ↵ Commit" : "Ctrl ↵ Commit"),
    "commit hint shows the supported shortcut",
  );
  const themeBeforeComposer = editor.themeManager.getResolvedTheme();
  editor.themeManager.applyTheme("light");
  await nextFrame();
  const composerThemeProbe = document.createElement("span");
  composerThemeProbe.style.position = "absolute";
  composerThemeProbe.style.visibility = "hidden";
  document.body.appendChild(composerThemeProbe);
  try {
    composerThemeProbe.style.color = getComputedStyle(document.documentElement)
      .getPropertyValue("--bg-secondary")
      .trim();
    check(
      getComputedStyle(composerBar).backgroundColor ===
        getComputedStyle(composerThemeProbe).color,
      "commit composer follows the active theme",
    );
  } finally {
    composerThemeProbe.remove();
    editor.themeManager.applyTheme(themeBeforeComposer);
    await nextFrame();
  }
  git.settingsButton.click();
  await waitFor(
    () => editor.tabManager.activeTab?.type === "settings",
    "Git settings tab to open",
  );
  check(
    editor.getSettingsView().category === "Git",
    "Git settings gear opens the Git category",
  );
  await editor.tabManager.closeTab(editor.tabManager.activeTab);
  await nextFrame();
  check(git.isOpen, "Source Control stays open after visiting settings");
  const branchIndicatorWithChanges = document.querySelector(".bottomBar-git-branch");
  const branchDirtyWithChanges = branchIndicatorWithChanges.querySelector(
    ".bottomBar-git-branch-dirty",
  );
  await waitFor(
    () => branchDirtyWithChanges.hidden === false,
    "dirty branch marker with changes",
  );
  check(
    branchIndicatorWithChanges.dataset.dirty === "true",
    "changed repository marks the branch as dirty",
  );
  check(
    branchIndicatorWithChanges.title.includes("Uncommitted changes"),
    "dirty branch tooltip explains the changes",
  );
  let row = git.listLayer.querySelector(
    `.git-file-row[data-path="${fileName}"]`,
  );
  check(Boolean(row), "untracked file row is visible");
  check(
    row.querySelector(".git-status-badge").textContent === "U",
    "untracked status letter is displayed",
  );
  check(
    getComputedStyle(row.querySelector(".git-file-actions")).marginRight === "2px",
    "stage action keeps a small inset from the row edge",
  );
  check(
    [...git.listLayer.querySelectorAll(".git-section-title")]
      .some((element) => element.textContent === "Changes"),
    "Changes section is visible",
  );

  // Branch selector: alphabetical menu, creation and switching.
  check(
    (await editor.api.git.createBranch("zeta"))?.success === true,
    "fixture branch zeta is created",
  );
  check(
    (await editor.api.git.createBranch("alpha"))?.success === true,
    "fixture branch alpha is created",
  );
  const backToMain = await editor.api.git.switchBranch("main");
  check(
    backToMain?.success === true,
    `fixture returns to main: ${JSON.stringify(backToMain)}`,
  );
  await git.refresh({ reason: "manual" });
  await waitFor(() => git.getBranchLabel() === "main", "main branch fixture");
  git.branchButton.click();
  await waitFor(
    () => git.branchMenuOpen && !git.branchMenuLoading,
    "branch menu to load",
  );
  await nextFrame();
  const branchMenu = document.querySelector(".git-branch-menu");
  const branchMenuRect = branchMenu.getBoundingClientRect();
  const branchButtonRect = git.branchButton.getBoundingClientRect();
  const commitBoxRect = git.commitBoxElement.getBoundingClientRect();
  check(branchMenu.hidden === false, "branch menu is visible");
  check(
    branchMenuRect.bottom <= branchButtonRect.top + 1,
    "branch menu opens upward",
  );
  check(
    branchMenuRect.left >= commitBoxRect.left - 1 &&
      branchMenuRect.right <= commitBoxRect.right + 1,
    "branch menu aligns with the commit card",
  );
  const branchItems = [...branchMenu.querySelectorAll(".git-branch-menu-item")];
  const branchLabels = branchItems
    .map((item) => item.querySelector(".git-branch-menu-item-name")?.textContent)
    .filter(Boolean);
  check(
    branchLabels.join(",") === "alpha,main,zeta,New Branch",
    "branch menu lists branches alphabetically then New Branch",
  );
  const currentBranchItem = branchItems.find(
    (item) =>
      item.querySelector(".git-branch-menu-item-name")?.textContent === "main",
  );
  check(
    currentBranchItem?.classList.contains("is-current") === true &&
      Boolean(currentBranchItem.querySelector(".git-branch-menu-check")),
    "current branch is marked in the menu",
  );
  const newBranchItem = branchItems.find(
    (item) => item.classList.contains("git-branch-menu-new"),
  );
  newBranchItem.click();
  await waitFor(
    () => editor.quickPanel.isOpen("git-new-branch"),
    "new branch prompt",
  );
  check(
    editor.quickPanel.title.textContent === "New Branch",
    "new branch prompt is titled",
  );
  editor.quickPanel.input.value = "feature/test";
  editor.quickPanel.accept("feature/test");
  await waitFor(
    () => git.getBranchLabel() === "feature/test",
    "new branch to be created and checked out",
  );
  await nextFrame();
  check(
    git.branchButton.textContent.includes("feature/test"),
    "branch selector follows the created branch",
  );
  check(!git.branchMenuOpen, "branch menu closes after creating a branch");
  git.branchButton.click();
  await waitFor(
    () => git.branchMenuOpen && !git.branchMenuLoading,
    "branch menu to reopen",
  );
  await nextFrame();
  const mainBranchItem = [...document.querySelectorAll(".git-branch-menu-item")]
    .find((item) =>
      item.querySelector(".git-branch-menu-item-name")?.textContent === "main");
  mainBranchItem.click();
  await waitFor(() => git.getBranchLabel() === "main", "switch back to main");
  await nextFrame();
  check(!git.branchMenuOpen, "branch menu closes after switching");
  check(
    git.getViewState().changes.length === 2,
    "branch switches preserve the working changes",
  );
  row = git.listLayer.querySelector(
    `.git-file-row[data-path="${fileName}"]`,
  );
  check(Boolean(row), "change row is visible after branch switching");

  // Responsive widths.
  const sidebar = document.querySelector(".sidebar-left");
  const sidebarRect = sidebar.getBoundingClientRect();
  const changesSection = git.listLayer.querySelector(
    '.git-section-header[data-section="changes"]',
  );
  check(
    Math.abs(changesSection.getBoundingClientRect().right - sidebarRect.right) <= 1,
    "Changes header reaches the sidebar's right edge",
  );
  check(
    Math.abs(row.getBoundingClientRect().right - sidebarRect.right) <= 1,
    "change rows reach the sidebar's right edge",
  );
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
  check(
    getComputedStyle(git.settingsButton).display === "none",
    "narrow sidebar hides the settings shortcut",
  );
  sidebar.style.width = "320px";
  await nextFrame();
  check(
    getComputedStyle(git.repoNameElement).display !== "none",
    "repository name returns at wide width",
  );
  check(
    getComputedStyle(git.settingsButton).display !== "none",
    "settings shortcut returns at wide width",
  );
  check(
    git.container.scrollWidth <= git.container.clientWidth + 1,
    "wide sidebar has no horizontal overflow",
  );
  sidebar.style.width = originalWidth;
  await nextFrame();

  // Stage every change with the Changes header action, then commit through real Git operations.
  const stageAllButton = git.listLayer.querySelector(
    '.git-section-header[data-section="changes"] .git-section-action',
  );
  check(Boolean(stageAllButton), "Changes header offers Stage All");
  check(
    stageAllButton.getAttribute("aria-label") === "Stage all changes",
    "Stage All is announced to assistive technology",
  );
  check(
    getComputedStyle(stageAllButton).cursor === "pointer",
    "Stage All shows a pointer cursor",
  );
  const stageAllRect = stageAllButton.getBoundingClientRect();
  const changesHeaderRect = changesSection.getBoundingClientRect();
  check(
    stageAllRect.width >= 16 &&
      stageAllRect.height >= 16 &&
      stageAllRect.right <= changesHeaderRect.right,
    "Stage All stays inside the Changes header",
  );
  const listRect = git.listViewport.getBoundingClientRect();
  const stageInset = listRect.right - stageAllRect.right;
  const rowInset = listRect.right -
    row.querySelector(".git-file-action").getBoundingClientRect().right;
  check(
    stageInset >= 4 && stageInset <= 12,
    "Stage All keeps a small inset from the list edge",
  );
  check(
    Math.abs(stageInset - rowInset) <= 1,
    "Stage All and row stage actions align at the right edge",
  );
  const stageIconRect = stageAllButton.querySelector("i").getBoundingClientRect();
  const rowIconRect = row.querySelector(".git-file-action i").getBoundingClientRect();
  check(
    Math.abs(
      (stageIconRect.left + stageIconRect.right) / 2 -
        (rowIconRect.left + rowIconRect.right) / 2,
    ) <= 0.5,
    "Stage All and row stage icons share a vertical axis",
  );
  stageAllButton.click();
  await waitFor(() => {
    const state = git.getViewState();
    return state.mode === "changes" &&
      state.staged.length === 2 &&
      state.changes.length === 0;
  }, "Stage All to stage every change");
  await nextFrame();
  check(
    git.commitStatus.textContent === "Staged 2 changes",
    "Stage All reports how many changes were staged",
  );
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
    () => branchDirtyWithChanges.hidden === true,
    "dirty branch marker to clear after commit",
  );
  check(
    branchIndicatorWithChanges.dataset.dirty === "false",
    "committed repository clears the dirty branch marker",
  );
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
