class ExternalFileDropController {
  constructor(editor) {
    this.editor = editor;
    this.api = editor.api;
    this.dragDepth = 0;
    this.state = "hidden";
    this.dragOperationId = 0;
    this.statusTimer = null;
    this.statusGeneration = 0;
    this.destroyed = false;
    this.overlay = this.createOverlay();

    this.onDragEnter = this.handleDragEnter.bind(this);
    this.onDragOver = this.handleDragOver.bind(this);
    this.onDragLeave = this.handleDragLeave.bind(this);
    this.onDrop = this.handleDrop.bind(this);
    this.onWindowBlur = () => {
      this.dragOperationId += 1;
      this.hideOverlay();
    };
    this.onUnload = this.destroy.bind(this);
    this.externalFileOpenQueue = Promise.resolve();
    this.onExternalFiles = (request) => {
      this.externalFileOpenQueue = this.externalFileOpenQueue
        .then(() => this.openExternalFiles(request))
        .catch((error) => console.error("[External Open] Delivery failed", error));
    };
    this.onExternalResult = (result) => this.showResult(result);
    window.addEventListener("dragenter", this.onDragEnter, true);
    window.addEventListener("dragover", this.onDragOver, true);
    window.addEventListener("dragleave", this.onDragLeave, true);
    window.addEventListener("drop", this.onDrop, true);
    window.addEventListener("blur", this.onWindowBlur);
    window.addEventListener("unload", this.onUnload, { once: true });
    this.unsubscribeExternalFiles = this.api.onExternalFilesRequested?.(this.onExternalFiles) || null;
    this.unsubscribeExternalResult = this.api.onExternalOpenResult?.(this.onExternalResult) || null;
  }

  createOverlay() {
    const overlay = document.createElement("div");
    overlay.className = "nce-external-drop-overlay";
    overlay.setAttribute("aria-hidden", "true");
    const card = document.createElement("div");
    card.className = "nce-external-drop-card";
    const title = document.createElement("strong");
    title.className = "nce-external-drop-title";
    title.textContent = "Drop files to open";
    const details = document.createElement("span");
    details.className = "nce-external-drop-details";
    details.textContent = "Folders open in a new window.";
    card.append(title, details);
    overlay.append(card);
    this.editor.editorOBJ.append(overlay);
    return overlay;
  }

  isSystemFileDrag(dataTransfer) {
    if (!dataTransfer) return false;
    const types = Array.from(dataTransfer.types || []);
    if (types.includes("Files")) return true;
    return Array.from(dataTransfer.items || []).some((item) => item?.kind === "file");
  }

  getFilePaths(dataTransfer) {
    const files = Array.from(dataTransfer?.files || []);
    return files.map((file) => {
      try {
        const filePath = this.api.getPathForDroppedFile?.(file);
        return typeof filePath === "string" ? filePath : "";
      } catch (error) {
        console.warn("[External Open] Electron could not resolve a dropped path", error);
        return "";
      }
    });
  }

  handleDragEnter(event) {
    if (!this.isSystemFileDrag(event.dataTransfer)) return;
    this.dragDepth += 1;
    if (this.state !== "dragging") this.showOverlay();
  }

  handleDragOver(event) {
    if (!this.isSystemFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    if (this.state !== "dragging") this.showOverlay();
  }

  handleDragLeave(event) {
    if (this.dragDepth === 0) return;
    const target = event.relatedTarget;
    if (target?.nodeType && document.documentElement.contains(target)) return;
    this.dragDepth = 0;
    this.dragOperationId += 1;
    this.hideOverlay();
  }

  handleDrop(event) {
    if (!this.isSystemFileDrag(event.dataTransfer)) return;
    const paths = this.getFilePaths(event.dataTransfer);
    // Consume only real file drops. Text, links and NCE's internal drag payloads
    // continue through the application's existing handlers.
    if (!Array.from(event.dataTransfer?.files || []).length) return;
    event.preventDefault();
    event.stopPropagation();
    const operationId = this.dragOperationId;
    this.dragDepth = 0;
    this.hideOverlay();
    Promise.resolve(this.api.openDroppedFiles?.(paths)).then(
      (result) => {
        if (operationId === this.dragOperationId) this.showResult(result);
      },
      (error) => {
        console.error("[External Open] Drop request failed", error);
        if (operationId === this.dragOperationId) {
          this.showStatus("NCE could not process the dropped items.");
        }
      },
    );
  }

  async openExternalFiles(request) {
    if (!request || typeof request.requestId !== "string" || !Array.isArray(request.paths)) return;
    const openedPaths = [];
    const failures = [];
    for (const filePath of request.paths) {
      if (typeof filePath !== "string") {
        failures.push({ path: "", message: "NCE received an invalid file path." });
        continue;
      }
      try {
        const opened = await this.editor.tabManager.openFileWithPath(filePath);
        if (!opened) throw new Error("NCE did not open this file.");
        openedPaths.push(filePath);
      } catch (error) {
        const message = error?.message || "The file could not be opened.";
        failures.push({ path: filePath, message });
        console.warn("[External Open] Failed to open file", filePath, error);
      }
    }
    try {
      await this.api.acknowledgeExternalOpen?.(
        request.requestId,
        request.attempt,
        { openedPaths, failures },
      );
    } catch (error) {
      console.error("[External Open] Failed to acknowledge opened files", error);
    }
  }

  showOverlay() {
    if (this.destroyed || !this.overlay) return;
    if (this.state === "dragging") return;
    this.dragOperationId += 1;
    this.clearStatusTimer();
    this.resetStatusContent();
    this.state = "dragging";
    this.overlay.classList.remove("nce-external-drop-result");
    this.overlay.classList.add("nce-external-drop-visible");
  }

  hideOverlay() {
    this.dragDepth = 0;
    if (!this.overlay) return;
    this.clearStatusTimer();
    this.state = "hidden";
    this.overlay.classList.remove("nce-external-drop-visible", "nce-external-drop-result");
    this.resetStatusContent();
  }

  showResult(result) {
    const failures = Array.isArray(result?.failures) ? result.failures : [];
    if (!failures.length) return;
    const firstFailure = failures[0];
    const detail = typeof firstFailure?.message === "string" ? firstFailure.message : "Some items could not be opened.";
    this.showStatus(`Could not open ${failures.length} item${failures.length === 1 ? "" : "s"}: ${detail}`);
  }

  showStatus(message) {
    if (this.destroyed || !this.overlay) return;
    const title = this.overlay.querySelector(".nce-external-drop-title");
    const details = this.overlay.querySelector(".nce-external-drop-details");
    if (title) title.textContent = message;
    if (details) details.textContent = "";
    this.state = "error";
    this.overlay.classList.add("nce-external-drop-visible", "nce-external-drop-result");
    this.clearStatusTimer();
    const generation = this.statusGeneration;
    this.statusTimer = setTimeout(() => {
      if (generation !== this.statusGeneration) return;
      this.statusTimer = null;
      this.hideOverlay();
    }, 3500);
  }

  clearStatusTimer() {
    this.statusGeneration += 1;
    clearTimeout(this.statusTimer);
    this.statusTimer = null;
  }

  resetStatusContent() {
    const title = this.overlay?.querySelector(".nce-external-drop-title");
    const details = this.overlay?.querySelector(".nce-external-drop-details");
    if (title) title.textContent = "Drop files to open";
    if (details) details.textContent = "Folders open in a new window.";
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.state = "hidden";
    this.dragDepth = 0;
    this.clearStatusTimer();
    window.removeEventListener("dragenter", this.onDragEnter, true);
    window.removeEventListener("dragover", this.onDragOver, true);
    window.removeEventListener("dragleave", this.onDragLeave, true);
    window.removeEventListener("drop", this.onDrop, true);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("unload", this.onUnload);
    this.unsubscribeExternalFiles?.();
    this.unsubscribeExternalResult?.();
    this.overlay?.remove();
    this.overlay = null;
  }
}
