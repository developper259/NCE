class ExternalFileDropController {
  constructor(editor) {
    this.editor = editor;
    this.api = editor.api;
    this.dragDepth = 0;
    this.state = "hidden";
    this.overlayKind = "file";
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
    details.textContent = "Files open in this window.";
    card.append(title, details);
    overlay.append(card);
    this.editor.mainSection.append(overlay);
    return overlay;
  }

  getDroppedItemKind(dataTransfer, canReadEntries = false) {
    for (const item of Array.from(dataTransfer?.items || [])) {
      if (item?.kind !== "file") continue;
      const type = String(item.type || "").toLowerCase();
      if (type === "inode/directory" || type === "application/x-directory") {
        return "directory";
      }
      if (canReadEntries) {
        try {
          const entry = item.webkitGetAsEntry?.();
          if (entry?.isDirectory) return "directory";
          if (entry?.isFile) return "file";
        } catch {}
      }
      if (!type || type === "application/octet-stream") {
        // Chromium hides the entry until drop; native folders often have no MIME type.
        return canReadEntries ? "unknown" : "directory";
      }
      return "file";
    }
    return "unknown";
  }

  updateOverlayCopy(kind, force = false) {
    const overlayKind = ["directory", "file", "unknown"].includes(kind) ? kind : "unknown";
    if (!force && overlayKind === this.overlayKind) return;
    this.overlayKind = overlayKind;
    const title = this.overlay?.querySelector(".nce-external-drop-title");
    const details = this.overlay?.querySelector(".nce-external-drop-details");
    const copy = this.overlayKind === "directory"
      ? { title: "Drop folders to open", details: "Folders open in a new window." }
      : this.overlayKind === "file"
        ? { title: "Drop files to open", details: "Files open in this window." }
        : { title: "Drop item to open", details: "" };
    if (title && title.textContent !== copy.title) title.textContent = copy.title;
    if (details && details.textContent !== copy.details) details.textContent = copy.details;
  }

  updateOverlayBounds() {
    const container = this.editor.mainSection;
    const fileManager = this.editor.fileManagerOBJ;
    const editor = this.editor.editorOBJ;
    if (!container || !editor || !this.overlay) return;

    const containerRect = container.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    const fileManagerRect = fileManager?.getBoundingClientRect();
    if (!containerRect.width || !containerRect.height || !editorRect.height) return;

    const overlayTop = fileManagerRect?.height ? fileManagerRect.top : editorRect.top;
    const intersectsOverlayVertically = (rect) =>
      rect.bottom > overlayTop && rect.top < editorRect.bottom;

    let left = Math.max(0, editorRect.left - containerRect.left);
    let right = Math.max(0, containerRect.right - editorRect.right);

    const leftSidebarRect = container.querySelector(".sidebar-left")?.getBoundingClientRect();
    if (leftSidebarRect && intersectsOverlayVertically(leftSidebarRect)) {
      left = Math.max(left, leftSidebarRect.right - containerRect.left + 2);
    }

    const rightSidebarRect = container.querySelector(".sidebar-right")?.getBoundingClientRect();
    if (rightSidebarRect && intersectsOverlayVertically(rightSidebarRect)) {
      right = Math.max(right, containerRect.right - rightSidebarRect.left + 2);
    }

    left = Math.min(containerRect.width, Math.max(0, left));
    right = Math.min(containerRect.width - left, Math.max(0, right));
    this.overlay.style.top = `${Math.max(0, overlayTop - containerRect.top)}px`;
    this.overlay.style.bottom = `${Math.max(0, containerRect.bottom - editorRect.bottom)}px`;
    this.overlay.style.left = `${left}px`;
    this.overlay.style.right = `${right}px`;
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
    this.showOverlay(event.dataTransfer);
  }

  handleDragOver(event) {
    if (!this.isSystemFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    this.showOverlay(event.dataTransfer);
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
    const kind = this.getDroppedItemKind(event.dataTransfer, true);
    this.updateOverlayCopy(kind);
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
        if (operationId === this.dragOperationId) this.showDropResult(result);
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

  showOverlay(dataTransfer) {
    if (this.destroyed || !this.overlay) return;
    this.updateOverlayCopy(this.getDroppedItemKind(dataTransfer));
    if (this.state === "dragging") return;
    this.updateOverlayBounds();
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

  showDropResult(result) {
    const failures = Array.isArray(result?.failures) ? result.failures : [];
    if (failures.length) {
      this.showResult(result);
      return;
    }
    const openedFiles = Number(result?.openedFiles) || 0;
    const openedFolders = Number(result?.openedFolders) || 0;
    if (openedFolders > 0 && openedFiles === 0) {
      this.showStatus(
        openedFolders === 1
          ? "Folder opened in a new window."
          : "Folders opened in new windows.",
      );
    } else if (openedFiles > 0 && openedFolders === 0) {
      this.showStatus(
        openedFiles === 1
          ? "File opened in this window."
          : "Files opened in this window.",
      );
    }
  }

  showStatus(message) {
    if (this.destroyed || !this.overlay) return;
    this.updateOverlayBounds();
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
    this.updateOverlayCopy(this.overlayKind, true);
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
