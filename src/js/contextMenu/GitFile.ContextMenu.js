function buildGitFileContextMenu(editor) {
  return (context) => {
    const sidebar = context?.sidebar;
    const entry = context?.entry;
    const staged = context?.staged === true;
    if (!sidebar || !entry) return {};
    const filePath = GitSidebar.resolveAbsolutePath(sidebar.workspaceRoot, entry.path);
    const actions = {
      openDiff: {
        name: staged ? "Open Staged Diff" : "Open Diff",
        callback: () => sidebar.openDiff(entry, staged),
      },
    };
    if (staged) {
      actions.unstage = {
        name: "Unstage File",
        callback: () => sidebar.toggleStage(entry, true),
      };
    } else {
      actions.stage = {
        name: "Stage File",
        callback: () => sidebar.toggleStage(entry, false),
      };
    }
    const selectionCount = sidebar.resolveDiscardTargetsFor?.(entry, staged)?.length || 1;
    actions.discard = {
      name: selectionCount > 1
        ? `Discard ${selectionCount} Changes…`
        : staged ? "Discard Staged Changes…" : "Discard Changes…",
      enabled: entry.conflicted !== true,
      callback: () => sidebar.requestDiscard(sidebar.resolveDiscardTargetsFor(entry, staged)),
    };
    actions.sep1 = { type: "separator" };
    actions.openFile = {
      name: "Open File",
      enabled: entry.kind !== "deleted" && Boolean(filePath),
      callback: () => sidebar.openEntryFile(entry),
    };
    actions.copyRelativePath = {
      name: "Copy Relative Path",
      callback: () => editor?.api?.writeClipboardText?.(entry.path),
    };
    actions.copyAbsolutePath = {
      name: "Copy Absolute Path",
      enabled: Boolean(filePath),
      callback: () => editor?.api?.writeClipboardText?.(filePath),
    };
    actions.sep2 = { type: "separator" };
    actions.refresh = {
      name: "Refresh",
      callback: () => sidebar.refresh({ reason: "manual" }),
    };
    return actions;
  };
}

function buildGitHeaderContextMenu(editor) {
  return (context) => {
    const sidebar = context?.sidebar;
    if (!sidebar) return {};
    const branch = sidebar.getBranchName?.() || null;
    const sections = sidebar.getSections?.() || { staged: [], changes: [] };
    return {
      refresh: {
        name: "Refresh",
        callback: () => sidebar.refresh({ reason: "manual" }),
      },
      history: {
        name: sidebar.collapsed?.history === false ? "Hide History" : "Show History",
        enabled: Boolean(sidebar.status),
        callback: () => {
          if (sidebar.collapsed?.history === false) sidebar.toggleSection("history");
          else void sidebar.showHistory();
        },
      },
      discardAllChanges: {
        name: "Discard All Changes…",
        enabled: sections.changes.some((entry) => !entry.conflicted),
        callback: () => sidebar.requestDiscardAll("changes"),
      },
      discardAllStaged: {
        name: "Discard All Staged Changes…",
        enabled: sections.staged.length > 0,
        callback: () => sidebar.requestDiscardAll("staged"),
      },
      copyBranch: {
        name: "Copy Branch Name",
        enabled: Boolean(branch),
        callback: () => editor?.api?.writeClipboardText?.(branch),
      },
      sep2: { type: "separator" },
      fetch: {
        name: "Fetch",
        enabled: Boolean(sidebar.status),
        callback: () => sidebar.fetchChanges(),
      },
      pull: {
        name: "Pull",
        enabled: Boolean(sidebar.status),
        callback: () => sidebar.pullChanges(),
      },
      push: {
        name: "Push",
        enabled: Boolean(sidebar.status),
        callback: () => sidebar.pushChanges(),
      },
      manageRemotes: {
        name: "Manage Remotes…",
        enabled: Boolean(sidebar.status),
        callback: () => sidebar.openRemotesDialog(),
      },
    };
  };
}
