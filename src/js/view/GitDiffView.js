class GitDiffView {
  static classifyLine(line) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to ") ||
      line.startsWith("Binary files ") ||
      line.startsWith("\\ No newline at end of file")
    ) return "meta";
    if (line.startsWith("@@")) return "hunk";
    if (line.startsWith("+++") || line.startsWith("---")) return "meta";
    if (line.startsWith("+")) return "add";
    if (line.startsWith("-")) return "del";
    return "context";
  }

  static describeUnavailable(reason) {
    if (reason === "untracked") return "Untracked file. Stage it to include it in the diff.";
    if (reason === "binary") return "Binary file — a textual diff is not available.";
    if (reason === "too-large") return "This diff is too large to display.";
    if (reason === "no-changes") return "No changes to show for this side of the index.";
    return "No diff available for this file.";
  }

  constructor(editor) {
    this.editor = editor;
    this.host = editor.domManager.getElement(".git-diff-view-host");
    this.toolbar = null;
    this.title = null;
    this.badge = null;
    this.subtitle = null;
    this.refreshButton = null;
    this.status = null;
    this.patch = null;
    this.tab = null;
    this.generation = 0;
    this.loading = false;
  }

  build() {
    if (!this.host || this.toolbar) return;
    const doc = this.host.ownerDocument || document;
    const toolbar = doc.createElement("div");
    toolbar.className = "git-diff-view-toolbar";

    const heading = doc.createElement("div");
    heading.className = "git-diff-view-heading";

    const titleRow = doc.createElement("div");
    titleRow.className = "git-diff-view-title-row";
    const title = doc.createElement("span");
    title.className = "git-diff-view-title";
    const badge = doc.createElement("span");
    badge.className = "git-diff-view-badge";
    titleRow.append(title, badge);

    const subtitle = doc.createElement("div");
    subtitle.className = "git-diff-view-subtitle";
    heading.append(titleRow, subtitle);

    const refreshButton = doc.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "git-diff-view-refresh";
    refreshButton.title = "Refresh Diff";
    refreshButton.setAttribute("aria-label", "Refresh Diff");
    const refreshIcon = doc.createElement("i");
    refreshIcon.className = "fi fi-rr-refresh";
    refreshIcon.setAttribute("aria-hidden", "true");
    refreshButton.appendChild(refreshIcon);
    refreshButton.addEventListener("click", () => this.refresh());

    toolbar.append(heading, refreshButton);

    const status = doc.createElement("div");
    status.className = "git-diff-view-status";
    status.setAttribute("role", "status");
    status.hidden = true;

    const patch = doc.createElement("div");
    patch.className = "git-diff-view-patch";
    patch.setAttribute("role", "document");

    this.host.replaceChildren(toolbar, status, patch);
    this.toolbar = toolbar;
    this.title = title;
    this.badge = badge;
    this.subtitle = subtitle;
    this.refreshButton = refreshButton;
    this.status = status;
    this.patch = patch;
  }

  show(tab) {
    if (!this.host || !tab) return;
    this.build();
    if (!this.toolbar) return;
    this.host.hidden = false;
    this.tab = tab;
    this.title.textContent = NCEPath.basename(tab.filePath);
    this.title.title = tab.filePath;
    const staged = tab.staged === true;
    this.badge.textContent = staged ? "Staged" : "Working Tree";
    this.badge.dataset.state = staged ? "staged" : "worktree";
    this.subtitle.textContent = tab.originalPath
      ? `${tab.relativePath} ← ${tab.originalPath}`
      : tab.relativePath;
    this.subtitle.title = tab.relativePath;
    void this.load(tab, ++this.generation);
  }

  hide() {
    this.generation++;
    this.tab = null;
    if (this.host) this.host.hidden = true;
  }

  close(tab) {
    if (this.tab === tab) {
      this.generation++;
      this.tab = null;
      this.patch?.replaceChildren();
      this.setStatus("");
    }
  }

  destroy() {
    this.generation++;
    this.tab = null;
    this.host?.replaceChildren();
    this.host = null;
    this.toolbar = null;
    this.title = null;
    this.badge = null;
    this.subtitle = null;
    this.refreshButton = null;
    this.status = null;
    this.patch = null;
  }

  refresh() {
    if (this.tab) void this.load(this.tab, ++this.generation);
  }

  async load(tab, generation) {
    this.loading = true;
    this.refreshButton?.setAttribute("aria-busy", "true");
    this.setStatus("Loading diff…");
    let result = null;
    try {
      result = await this.editor.api.git.getDiff(tab.filePath, {
        staged: tab.staged === true,
      });
    } catch (error) {
      result = null;
    }
    if (generation !== this.generation || tab !== this.tab) return;
    this.loading = false;
    this.refreshButton?.removeAttribute("aria-busy");
    if (!result) {
      this.patch?.replaceChildren();
      this.setStatus("The diff could not be loaded.", true);
      return;
    }
    if (result.success !== true) {
      this.patch?.replaceChildren();
      this.setStatus(result.error || "The diff could not be loaded.", true);
      return;
    }
    if (result.available !== true) {
      this.renderUnavailable(result);
      return;
    }
    this.setStatus("");
    this.renderPatch(result.patch || "");
  }

  renderUnavailable(result) {
    this.patch?.replaceChildren();
    this.setStatus(GitDiffView.describeUnavailable(result.reason));
    if (result.reason !== "untracked" || typeof result.preview !== "string") return;
    if (!this.patch) return;
    const doc = this.patch.ownerDocument || document;
    const preview = doc.createElement("pre");
    preview.className = "git-diff-view-preview";
    preview.textContent = result.preview;
    this.patch.appendChild(preview);
  }

  renderPatch(patchText) {
    if (!this.patch) return;
    const doc = this.patch.ownerDocument || document;
    const lines = patchText.split("\n");
    if (lines.length > 20000) {
      const pre = doc.createElement("pre");
      pre.className = "git-diff-view-preview";
      pre.textContent = patchText;
      this.patch.replaceChildren(pre);
      return;
    }
    const fragment = doc.createDocumentFragment();
    for (const line of lines) {
      const row = doc.createElement("div");
      row.className = `git-diff-line git-diff-${GitDiffView.classifyLine(line)}`;
      row.textContent = line || " ";
      fragment.appendChild(row);
    }
    this.patch.replaceChildren(fragment);
  }

  setStatus(message, error = false) {
    if (!this.status) return;
    this.status.textContent = message || "";
    this.status.hidden = !message;
    this.status.dataset.state = error ? "error" : "info";
  }
}
