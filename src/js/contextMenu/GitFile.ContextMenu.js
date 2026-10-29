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
    return {
      refresh: {
        name: "Refresh",
        callback: () => sidebar.refresh({ reason: "manual" }),
      },
      copyBranch: {
        name: "Copy Branch Name",
        enabled: Boolean(branch),
        callback: () => editor?.api?.writeClipboardText?.(branch),
      },
    };
  };
}
