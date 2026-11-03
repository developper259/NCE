class ProblemsPanel {
  constructor(editor, controller) {
    this.editor = editor;
    this.controller = controller;
    this.element = document.createElement("div");
    this.element.className = "problems-panel";
    this.header = document.createElement("div");
    this.header.className = "problems-panel-header";
    this.summary = document.createElement("span");
    this.summary.className = "problems-panel-summary";
    this.serverStatus = document.createElement("span");
    this.serverStatus.className = "problems-panel-servers";
    this.header.append(this.summary, this.serverStatus);
    this.list = document.createElement("div");
    this.list.className = "problems-panel-list";
    this.list.setAttribute("role", "list");
    this.empty = document.createElement("div");
    this.empty.className = "problems-panel-empty";
    this.empty.textContent = "No problems have been reported.";
    this.element.append(this.header, this.list, this.empty);
    this.onClick = (event) => {
      const row = event.target.closest?.(".problem-row");
      if (!row) return;
      this.controller.navigateTo({
        path: row.dataset.path,
        uri: row.dataset.uri,
        range: {
          start: { line: Number(row.dataset.line), character: Number(row.dataset.character) },
          end: { line: Number(row.dataset.endLine), character: Number(row.dataset.endCharacter) },
        },
        authorized: true,
      });
    };
    this.list.addEventListener("click", this.onClick);
  }

  render(documents = []) {
    const entries = [];
    for (const document of documents) {
      for (const diagnostic of document.diagnostics || []) {
        entries.push({
          path: document.path || "",
          uri: document.uri,
          diagnostic,
        });
      }
    }
    entries.sort((left, right) =>
      (left.diagnostic.severity || 9) - (right.diagnostic.severity || 9) ||
      left.path.localeCompare(right.path) ||
      left.diagnostic.range.start.line - right.diagnostic.range.start.line);
    const counts = { errors: 0, warnings: 0, infos: 0 };
    for (const entry of entries) {
      if (entry.diagnostic.severity === 1) counts.errors += 1;
      else if (entry.diagnostic.severity === 2) counts.warnings += 1;
      else counts.infos += 1;
    }
    this.summary.textContent = `${counts.errors} error${counts.errors === 1 ? "" : "s"}, `
      + `${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}, `
      + `${counts.infos} info`;
    this.list.replaceChildren();
    this.empty.hidden = entries.length > 0;
    const root = this.editor.fileExplorer?.rootPath || "";
    for (const entry of entries.slice(0, 500)) {
      const { diagnostic } = entry;
      const severity = diagnostic.severity === 1
        ? "error"
        : diagnostic.severity === 2
          ? "warning"
          : diagnostic.severity === 3
            ? "info"
            : "hint";
      const row = document.createElement("button");
      row.type = "button";
      row.className = `problem-row problem-${severity}`;
      row.setAttribute("role", "listitem");
      row.dataset.path = entry.path;
      row.dataset.uri = entry.uri;
      const start = diagnostic.range?.start || { line: 0, character: 0 };
      const end = diagnostic.range?.end || start;
      row.dataset.line = String(start.line);
      row.dataset.character = String(start.character);
      row.dataset.endLine = String(end.line);
      row.dataset.endCharacter = String(end.character);

      const icon = document.createElement("span");
      icon.className = `problem-icon problem-icon-${severity}`;
      icon.setAttribute("aria-hidden", "true");
      const message = document.createElement("span");
      message.className = "problem-message";
      message.textContent = diagnostic.message;
      const meta = document.createElement("span");
      meta.className = "problem-meta";
      const relative = root && entry.path.startsWith(root)
        ? entry.path.slice(root.length).replace(/^[\\/]/, "")
        : entry.path;
      meta.textContent = `${relative}:${start.line + 1}:${start.character + 1}`;
      row.append(icon, message, meta);
      this.list.appendChild(row);
    }
    if (entries.length > 500) {
      const more = document.createElement("div");
      more.className = "problems-panel-more";
      more.textContent = `${entries.length - 500} more problems not shown.`;
      this.list.appendChild(more);
    }
  }

  setServerStatus(text) {
    this.serverStatus.textContent = text || "";
  }

  focus() {
    const first = this.list.querySelector(".problem-row");
    (first || this.element).focus?.();
  }

  onOpen() {
    this.controller.refreshProblems();
  }

  onActivate() {}
  onDeactivate() {}
  onClose() {}

  destroy() {
    this.list.removeEventListener("click", this.onClick);
    this.element.remove();
  }
}
