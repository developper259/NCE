const TAB_TYPES = Object.freeze({
  FILE: "file",
  SETTINGS: "settings",
  PICTURE: "picture",
  MARKDOWN: "markdown",
});
const AUTO_SAVE_DEBOUNCE_MS = 180;
const RECOVERY_SNAPSHOT_DEBOUNCE_MS = 120;
const MAX_RECOVERY_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_RECOVERY_SNAPSHOT_LINES = 100000;

function createRecoveryUntitledId() {
  const random = Math.random().toString(36).slice(2, 14);
  return `${Date.now().toString(36)}-${random}`;
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff &&
        index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 &&
        value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

class Tab {
  constructor(id, type, name, closable = true) {
    this.id = id;
    this.type = type;
    this.name = name;
    this.closable = closable;
  }
}

class SettingsTab extends Tab {
  constructor(id) {
    super(id, TAB_TYPES.SETTINGS, "Settings");
  }
}

class PictureTab extends Tab {
  constructor(id, path) {
    super(id, TAB_TYPES.PICTURE, NCEPath.basename(path));
    this.path = path;
    this.diskFingerprint = null;
  }
}

class MarkdownTab extends Tab {
  constructor(id, path) {
    super(id, TAB_TYPES.MARKDOWN, NCEPath.basename(path));
    this.path = path;
    this.diskFingerprint = null;
    this.textTab = null;
  }
}

class FileNode extends Tab {
  constructor(e, id, name, path) {
    super(id, TAB_TYPES.FILE, name);
    Object.defineProperties(this, {
      _lineLengthRecords: { value: null, writable: true, configurable: true },
      _lineLengthHeap: { value: null, writable: true, configurable: true },
      _lineLengthCount: { value: -1, writable: true, configurable: true },
      _lineMetricsTabWidth: { value: null, writable: true, configurable: true },
      _logicalLineLengths: { value: null, writable: true, configurable: true },
      _logicalLengthTree: { value: null, writable: true, configurable: true },
      _logicalLengthCount: { value: -1, writable: true, configurable: true },
    });
    this.editor = e;
    this.path = path;
    this.searchReplaceValue = "";
    this.searchCurrentIndex = -1;

    this.isSaved = true;
    this.deletedFromDisk = false;
    this.externalModified = false;
    this.diskFingerprint = null;
    this.editVersion = 0;
    this.saveQueue = Promise.resolve(true);
    this.autoSaveTimer = null;
    this.autoSaveFlushPromise = null;
    this.autoSaveDisposed = false;
    this.recoveryUntitledId = createRecoveryUntitledId();
    this.recoverySnapshotId = null;
    this.recoveryStoreRoot = null;
    this.recoveryPreviousSnapshotId = null;
    this.recoveryPreviousStoreRoot = null;
    this.recoveryTimer = null;
    this.recoveryFlushPromise = null;
    this.recoveryGeneration = 0;
    this.recoveryDisposed = false;

    // KeyBinding
    this.historyX = undefined;

    // Cursor
    this.row = 0;
    this.column = 0;

    // Line Controller
    this.lines = [new LineNode("")];
    this.index = 1;
    this.totalLines = 0;
    this.maxLineLength = 0;
    this.maxLineLengthDirty = false;
    this.startIndex = 0;
    this.offsetY = 0;
    this.offsetX = 0;
    this.isLoaded = false;
    this.loadingState = null;
    this.syntaxMetrics = null;
    this.contentGeneration = 0;

    // Select Controller
    this.isMouseDown = false;
    this.containsSelected = "";
    this._selectedLines = new Map();
    this._selectionRange = null;
    this._selectionTextCache = null;

    this.lastClick = 0;
    this.clickCount = 0;

    this.HstartSelect = undefined; // historique start select
    this.startSelect = undefined;
    this.endSelect = undefined;

    // Writer Controller
    this.insertMode = false;

    // HighlightController
    this.language = undefined;
    this.eol = "\n";
    this.hasFinalNewline = false;
    this.lineEndings = [];
    this.loadError = null;
    this.incrementalEligible = false;
    // This capability follows the file across tabs; it is never editor-global.
    this.largeFileMode = false;
    this.largeFileSize = 0;

    // Diff State
    this.diffSnapshot = null;
    this.diffActive = false;
    this.diffRows = null;
  }

  async loadLanguage() {
    this.language = await this.editor.highlightController.detectLanguage(
      this.name,
    );
  }
  isEmpty() {
    if (this.lines.length === 0) return true;
    if (this.lines.length === 1 && this.lines[0].getText().length === 0)
      return true;
    return false;
  }

  hasPath() {
    if (this.path) return true;
    return false;
  }

  replaceFile(file) {
    this.cancelRecoverySnapshot();
    void this.clearRecoverySnapshot();
    this.name = file.name;
    this.path = file.path;
    this.searchReplaceValue = "";
    this.searchCurrentIndex = -1;
    this.isSaved = file.isSaved;
    this.deletedFromDisk = file.deletedFromDisk === true;
    this.externalModified = file.externalModified === true;
    this.diskFingerprint = file.diskFingerprint || null;
    this.recoveryUntitledId = file.recoveryUntitledId || createRecoveryUntitledId();
    this.recoverySnapshotId = file.recoverySnapshotId || null;
    this.recoveryStoreRoot = file.recoveryStoreRoot || null;
    this.recoveryPreviousSnapshotId = file.recoveryPreviousSnapshotId || null;
    this.recoveryPreviousStoreRoot = file.recoveryPreviousStoreRoot || null;

    this.historyX = file.historyX;

    this.row = file.row;
    this.column = file.column;

    this.lines = file.lines;
    this.index = file.index;
    this.totalLines = file.totalLines;
    this.maxLineLength = file.maxLineLength;
    this.maxLineLengthDirty = file.maxLineLengthDirty === true;
    this._lineLengthRecords = null;
    this._lineLengthHeap = null;
    this._lineLengthCount = -1;
    this._lineMetricsTabWidth = null;
    this._logicalLineLengths = null;
    this._logicalLengthTree = null;
    this._logicalLengthCount = -1;
    this.startIndex = file.startIndex;
    this.offsetY = file.offsetY;
    this.offsetX = file.offsetX;
    this.isLoaded = false;

    this.isMouseDown = file.isMouseDown;
    this.containsSelected = file.containsSelected;
    this._selectedLines = file._selectedLines;
    this._selectionRange = file._selectionRange || null;
    this._selectionTextCache = null;

    this.lastClick = file.lastClick;
    this.clickCount = file.clickCount;

    this.HstartSelect = file.HstartSelect;
    this.startSelect = file.startSelect;
    this.endSelect = file.endSelect;

    this.insertMode = file.insertMode;

    this.language = file.language;
    this.eol = file.eol || "\n";
    this.hasFinalNewline = file.hasFinalNewline === true;
    this.lineEndings = Array.isArray(file.lineEndings)
      ? [...file.lineEndings]
      : [];
    this.loadError = file.loadError || null;
    this.incrementalEligible = file.incrementalEligible === true;
    this.largeFileMode = file.largeFileMode === true;
    this.largeFileSize = Number.isFinite(file.largeFileSize)
      ? file.largeFileSize
      : 0;
  }

  async loadContent() {
    const generation = ++this.contentGeneration;
    this.largeFileMode = false;
    this.largeFileSize = 0;
    if (!this.path) {
      this.isLoaded = true;
      return;
    }
    try {
      const loading = this.editor.fileLoader.loadFile(this.path);
      this.loadingState = this.editor.fileLoader.getState(this.path);
      this.editor.bottomBar?.refreshFileStatus?.();
      const result = await loading;
      if (generation !== this.contentGeneration) return;
      this.loadingState = result.state;
      this.eol = result.eol;
      this.hasFinalNewline = result.hasFinalNewline;
      this.lineEndings = result.lineEndings;
      this.incrementalEligible = result.incrementalEligible;
      this.largeFileMode = result.largeFileMode === true;
      this.largeFileSize = Number.isFinite(result.size) ? result.size : 0;
      this.editor.bottomBar?.refreshFileStatus?.();
      if (this.largeFileMode) {
        this.diffSnapshot = null;
        this.diffActive = false;
        this.diffRows = null;
      }
      this.lines = result.initialLines.map((text) => new LineNode(text));
      if (!this.lines.length) this.lines = [new LineNode("")];
      this._logicalLineLengths = null;
      this._logicalLengthTree = null;
      this._logicalLengthCount = -1;
      this._lineLengthRecords = null;
      this._lineLengthHeap = null;
      this._lineLengthCount = -1;
      this._lineMetricsTabWidth = null;
      this.maxLineLengthDirty = true;
      this.totalLines = this.lines.length;
      this.syntaxMetrics = null;
      this.loadError = null;
      this.deletedFromDisk = false;
      this.externalModified = false;
      this.editor.historyController?.clear(this);
      this.editor.fileLoader.loadRemainingLines(
        this,
        result.initialLines.length,
        result.totalLines,
      );
      this.isLoaded = true;
    } catch (error) {
      if (generation !== this.contentGeneration) return;
      this.loadError = error;
      this.isLoaded = true;
      this.editor.bottomBar?.refreshFileStatus?.();
    }
  }

  async ensureSaveable({ allowExternalConflict = false } = {}) {
    if (this.loadError) return false;
    if (this.externalModified && !allowExternalConflict) {
      this.reportSaveError(
        Object.assign(new Error("File changed on disk"), {
          code: "FILE_CHANGED_ON_DISK",
        }),
      );
      return false;
    }
    try {
      await this.editor.fileLoader.waitForFileLoaded(this);
      this.saveError = null;
      return true;
    } catch (error) {
      this.reportSaveError(error);
      return false;
    }
  }

  getSyntaxMetrics() {
    if (!this.syntaxMetrics) {
      let logicalLength = Math.max(0, this.lines.length - 1);
      let longLineCount = 0;
      for (const line of this.lines) {
        const length = line.getText().length;
        logicalLength += length;
        if (length > 1000) longLineCount++;
      }
      this.syntaxMetrics = { logicalLength, longLineCount };
    }
    return this.syntaxMetrics;
  }

  reportSaveError(error) {
    this.saveError = error;
    let message = "Failed to save file.";
    // Electron IPC forwards the Error message but may drop custom properties
    // such as `code`, so also recognize the stable, user-facing message prefix.
    if (
      error?.code === "SAVE_REPLACEMENT_FAILED" ||
      /Atomic rename failed \(/.test(error?.message || "")
    )
      message = error.message || "NCE could not safely replace this file.";
    else if (error.code === "FILE_LOAD_FAILED")
      message = "File loading failed. Reload the file before saving.";
    else if (error.code === "FILE_CHANGED_ON_DISK")
      message = "File changed on disk. Use Save As to preserve your changes.";
    else if (error.code === "FILE_NOT_FULLY_LOADED")
      message = "File is not fully loaded. Save was cancelled.";
    if (typeof alert === "function") alert(message);
    else console.warn(message);
  }

  save() {
    this.cancelAutoSave();
    return this.enqueueSaveOperation(() => this.performSave());
  }

  enqueueSaveOperation(operation) {
    this.saveQueue = this.saveQueue.catch(() => false).then(operation);
    return this.saveQueue;
  }

  enqueueSaveSnapshot(
    content,
    version,
    saveFile = this.editor.api.saveFile.bind(this.editor.api),
  ) {
    return this.enqueueSaveOperation(() =>
      this.performSaveSnapshot(content, version, saveFile),
    );
  }

  scheduleAutoSave() {
    if (
      this.autoSaveDisposed ||
      !this.shouldPersistChanges() ||
      this.isSaved === true
    ) {
      this.cancelAutoSave();
      return false;
    }

    this.cancelAutoSave();
    this.autoSaveTimer = setTimeout(() => {
      this.autoSaveTimer = null;
      void this.flushAutoSave();
    }, AUTO_SAVE_DEBOUNCE_MS);
    this.editor.performanceMetrics?.increment("autosave.schedules");
    return true;
  }

  cancelAutoSave() {
    if (this.autoSaveTimer !== null) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  disposeAutoSave() {
    this.autoSaveDisposed = true;
    this.cancelAutoSave();
  }

  scheduleRecoverySnapshot() {
    if (this.recoveryDisposed || this.isSaved === true ||
        this.largeFileMode === true || typeof this.editor.api?.saveRecoverySnapshot !== "function") {
      this.cancelRecoveryTimer();
      return false;
    }
    if (this.lines.length > MAX_RECOVERY_SNAPSHOT_LINES) {
      this.editor.performanceMetrics?.increment("recovery.snapshot.skipped");
      this.cancelRecoveryTimer();
      return false;
    }
    this.cancelRecoveryTimer();
    this.recoveryGeneration += 1;
    const generation = this.recoveryGeneration;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (generation === this.recoveryGeneration)
        void this.flushRecoverySnapshot();
    }, RECOVERY_SNAPSHOT_DEBOUNCE_MS);
    this.editor.performanceMetrics?.increment("recovery.snapshot.schedules");
    return true;
  }

  cancelRecoveryTimer() {
    if (this.recoveryTimer !== null) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  cancelRecoverySnapshot() {
    this.cancelRecoveryTimer();
    this.recoveryGeneration += 1;
  }

  disposeRecovery() {
    this.recoveryDisposed = true;
    this.cancelRecoverySnapshot();
  }

  flushRecoverySnapshot() {
    this.cancelRecoveryTimer();
    if (this.recoveryFlushPromise) return this.recoveryFlushPromise;
    let flushPromise;
    flushPromise = this.runRecoverySnapshotFlush().finally(() => {
      if (this.recoveryFlushPromise === flushPromise)
        this.recoveryFlushPromise = null;
    });
    this.recoveryFlushPromise = flushPromise;
    return flushPromise;
  }

  async runRecoverySnapshotFlush() {
    while (this.isSaved !== true && !this.recoveryDisposed &&
        this.largeFileMode !== true) {
      if (this.lines.length > MAX_RECOVERY_SNAPSHOT_LINES) {
        this.editor.performanceMetrics?.increment("recovery.snapshot.skipped");
        return false;
      }
      const version = this.editVersion;
      const generation = this.recoveryGeneration;
      if (this.path && typeof this.editor.fileLoader?.waitForFileLoaded === "function") {
        try {
          await this.editor.fileLoader.waitForFileLoaded(this);
        } catch {
          this.editor.performanceMetrics?.increment("recovery.snapshot.skipped");
          return false;
        }
      }
      if (version !== this.editVersion) {
        this.cancelRecoveryTimer();
        continue;
      }
      if (this.lines.length > MAX_RECOVERY_SNAPSHOT_LINES) {
        this.editor.performanceMetrics?.increment("recovery.snapshot.skipped");
        return false;
      }
      if (this.largeFileMode === true || this.recoveryDisposed || this.isSaved === true)
        return false;

      let content;
      try {
        content = this.serializeContent();
      } catch {
        this.editor.performanceMetrics?.increment("recovery.snapshot.skipped");
        return false;
      }
      if (utf8ByteLength(content) > MAX_RECOVERY_SNAPSHOT_BYTES) {
        this.editor.performanceMetrics?.increment("recovery.snapshot.skipped");
        return false;
      }

      const workspaceRoot = this.editor.fileExplorer?.rootPath || null;
      const measure = this.editor.performanceMetrics?.begin("recovery.snapshot.write");
      let result;
      try {
        result = await this.editor.api.saveRecoverySnapshot(workspaceRoot, {
          filePath: this.path || null,
          untitledId: this.path ? null : this.recoveryUntitledId,
          displayName: this.name || "Untitled buffer",
          content,
          lineCount: this.lines.length,
          editVersion: version,
          diskFingerprint: this.diskFingerprint || null,
        });
      } catch {
        result = null;
      } finally {
        this.editor.performanceMetrics?.end(measure);
      }
      if (!result?.success || typeof result.id !== "string") {
        this.editor.performanceMetrics?.increment("recovery.snapshot.failures");
        return false;
      }

      const previousId = this.recoverySnapshotId || this.recoveryPreviousSnapshotId;
      const previousRoot = this.recoveryStoreRoot;
      this.recoverySnapshotId = result.id;
      this.recoveryStoreRoot = workspaceRoot;
      this.recoveryPreviousSnapshotId = null;
      this.recoveryPreviousStoreRoot = null;
      this.editor.performanceMetrics?.increment("recovery.snapshot.writes");

      if (this.isSaved === true || this.recoveryDisposed || this.largeFileMode === true ||
          version !== this.editVersion || generation !== this.recoveryGeneration) {
        await this.deleteRecoveryRecord(workspaceRoot, result.id);
        if (this.recoverySnapshotId === result.id) this.recoverySnapshotId = null;
        if (this.isSaved === true || this.recoveryDisposed || this.largeFileMode === true)
          return false;
        this.cancelRecoveryTimer();
        continue;
      }
      if (previousId && (previousId !== result.id || previousRoot !== workspaceRoot)) {
        const removedPrevious = await this.deleteRecoveryRecord(previousRoot, previousId);
        if (!removedPrevious) {
          this.recoveryPreviousSnapshotId = previousId;
          this.recoveryPreviousStoreRoot = previousRoot;
        }
      }
      return true;
    }
    return false;
  }

  async deleteRecoveryRecord(root, id) {
    if (!id || typeof this.editor.api?.deleteRecoverySnapshot !== "function")
      return false;
    try {
      return await this.editor.api.deleteRecoverySnapshot(root || null, id);
    } catch {
      return false;
    }
  }

  async clearRecoverySnapshot() {
    this.cancelRecoverySnapshot();
    if (this.recoveryFlushPromise) await this.recoveryFlushPromise.catch(() => false);
    const records = [
      { id: this.recoverySnapshotId, root: this.recoveryStoreRoot },
      { id: this.recoveryPreviousSnapshotId, root: this.recoveryPreviousStoreRoot },
    ].filter((record, index, all) => record.id &&
      all.findIndex((candidate) => candidate.id === record.id && candidate.root === record.root) === index);
    for (const record of records) {
      const deleted = await this.deleteRecoveryRecord(record.root, record.id);
      if (!deleted) {
        this.editor.performanceMetrics?.increment("recovery.snapshot.deleteFailures");
        return false;
      }
      if (this.recoverySnapshotId === record.id &&
          this.recoveryStoreRoot === record.root)
        this.recoverySnapshotId = null;
      if (this.recoveryPreviousSnapshotId === record.id &&
          this.recoveryPreviousStoreRoot === record.root)
        this.recoveryPreviousSnapshotId = null;
    }
    if (!records.length) return true;
    this.recoveryPreviousStoreRoot = null;
    return true;
  }

  restoreRecoveredContent(content, {
    editVersion = 0,
    diskChanged = false,
    snapshotId = null,
    storeRoot = null,
  } = {}) {
    if (typeof content !== "string") return false;
    const lines = [];
    const endings = [];
    const newline = /\r\n|\r|\n/g;
    let start = 0;
    let match;
    while ((match = newline.exec(content))) {
      lines.push(content.slice(start, match.index));
      endings.push(match[0]);
      start = match.index + match[0].length;
    }
    lines.push(content.slice(start));
    const hasFinalNewline = endings.length > 0 && start === content.length;
    if (hasFinalNewline) lines.pop();
    if (!lines.length) lines.push("");
    const counts = new Map();
    for (const ending of endings) counts.set(ending, (counts.get(ending) || 0) + 1);
    const eol = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "\n";

    this.cancelRecoverySnapshot();
    this.lines = lines.map((text) => new LineNode(text));
    this.lineEndings = endings;
    this.eol = eol;
    this.hasFinalNewline = hasFinalNewline;
    this.totalLines = this.lines.length;
    this.maxLineLengthDirty = true;
    this.syntaxMetrics = null;
    this._lineLengthRecords = null;
    this._lineLengthHeap = null;
    this._lineLengthCount = -1;
    this._logicalLineLengths = null;
    this._logicalLengthTree = null;
    this._logicalLengthCount = -1;
    this.startIndex = 0;
    this.largeFileMode = false;
    this.largeFileSize = 0;
    this.isLoaded = true;
    this.loadingState = {
      status: "loaded",
      isLoading: false,
      isFullyLoaded: true,
      loadedLineCount: this.lines.length,
      expectedTotalLines: this.lines.length,
    };
    this.editVersion = Math.max(this.editVersion + 1, Number(editVersion) || 0);
    this.externalModified = diskChanged === true;
    this.deletedFromDisk = false;
    this.editor.historyController?.clear(this);
    this.recoverySnapshotId = snapshotId;
    this.recoveryPreviousSnapshotId = snapshotId;
    this.recoveryStoreRoot = storeRoot || null;
    this.recoveryPreviousStoreRoot = storeRoot || null;
    this.setIsSaved(false);
    this.editor.lineController?.markDirtyAll?.();
    if (this === this.editor.tabManager?.activeFile)
      this.editor.lineController?.refresh?.(true);
    this.editor.tabManager?.refresh?.();
    return true;
  }

  flushAutoSave() {
    this.cancelAutoSave();
    if (this.autoSaveFlushPromise) return this.autoSaveFlushPromise;

    this.editor.performanceMetrics?.increment("autosave.flushes");
    let flushPromise;
    flushPromise = this.runAutoSaveFlush().finally(() => {
      if (this.autoSaveFlushPromise === flushPromise)
        this.autoSaveFlushPromise = null;
    });
    this.autoSaveFlushPromise = flushPromise;
    return flushPromise;
  }

  async runAutoSaveFlush() {
    while (this.shouldPersistChanges() && this.isSaved !== true) {
      const version = this.editVersion;
      const result = await this.enqueueSaveOperation(() =>
        this.performAutoSave(version),
      );

      // An edit during load or write makes that snapshot stale. Persist the
      // latest version before a lifecycle flush is allowed to finish.
      if (version !== this.editVersion && !result?.error) continue;
      if (result?.saved === true || result?.unchanged === true) return true;
      return false;
    }
    return true;
  }

  async performAutoSave(version) {
    if (!this.shouldPersistChanges())
      return { saved: false, skipped: true };
    if (version !== this.editVersion) return { saved: false, stale: true };
    if (this.isSaved === true) return { saved: true, unchanged: true };
    if (!(await this.ensureSaveable()))
      return { saved: false, error: this.saveError || new Error("Save unavailable") };
    if (!this.shouldPersistChanges())
      return { saved: false, skipped: true };
    if (version !== this.editVersion) return { saved: false, stale: true };

    const content = this.serializeContent();
    const metrics = this.editor.performanceMetrics;
    metrics?.increment("autosave.writeAttempts");
    const measure = metrics?.begin("autosave.write");
    const result = await this.performSaveSnapshot(
      content,
      version,
      (filePath, snapshot) => this.editor.api.saveFile(filePath, snapshot),
      { saveableChecked: true },
    );
    metrics?.end(measure);
    if (result?.saved || result?.persisted)
      metrics?.increment("autosave.persistedWrites");
    if (result?.error) metrics?.increment("autosave.failures");
    return result;
  }

  async performSaveSnapshot(
    content,
    version,
    saveFile,
    { saveableChecked = false } = {},
  ) {
    if (version !== this.editVersion) return { saved: false, stale: true };
    if (!saveableChecked && !(await this.ensureSaveable())) {
      return {
        saved: false,
        error: this.saveError || new Error("Save unavailable"),
      };
    }
    if (version !== this.editVersion) return { saved: false, stale: true };
    try {
      const saved = await saveFile(this.path, content);
      if (!saved) throw new Error("Failed to save file");
      if (version !== this.editVersion) {
        return { saved: false, stale: true, persisted: true };
      }
      this.deletedFromDisk = false;
      this.saveError = null;
      this.setIsSaved(true);
      this.cancelAutoSave();
      this.editor.historyController?.markSaved(this);
      await this.clearRecoverySnapshot();
      this.editor.tabManager.refresh();
      return { saved: true, result: saved };
    } catch (error) {
      this.reportSaveError(error);
      return { saved: false, error };
    }
  }

  async performSave() {
    if (this.loadError) {
      this.reportSaveError(this.loadError);
      return false;
    }
    if (!this.path) return this.performSaveAs();
    if (!(await this.ensureSaveable())) return false;
    const content = this.serializeContent();
    const version = this.editVersion;
    try {
      const saved = await this.editor.api.saveFile(this.path, content);
      if (!saved) throw new Error("Failed to save file");
      if (version === this.editVersion) {
        this.deletedFromDisk = false;
        this.setIsSaved(true);
        this.cancelAutoSave();
        this.editor.historyController?.markSaved(this);
        await this.clearRecoverySnapshot();
      }
      this.editor.tabManager.refresh();
      return true;
    } catch (error) {
      this.reportSaveError(error);
      return false;
    }
  }

  saveAs() {
    this.cancelAutoSave();
    this.saveQueue = this.saveQueue
      .catch(() => false)
      .then(() => this.performSaveAs());
    return this.saveQueue;
  }

  async performSaveAs() {
    if (this.loadError) {
      this.reportSaveError(this.loadError);
      return false;
    }
    if (!(await this.ensureSaveable({ allowExternalConflict: true })))
      return false;
    const selectedPath = await this.editor.tabManager.selectNewFile();
    if (typeof selectedPath !== "string" || !selectedPath) return false;
    const content = this.serializeContent();
    const version = this.editVersion;
    try {
      const saved = await this.editor.api.saveFile(selectedPath, content);
      if (!saved) throw new Error("Failed to save file");
    } catch (error) {
      this.reportSaveError(error);
      return false;
    }

    if (!this.path)
      this.loadingState = {
        status: "loaded",
        loadedLineCount: this.lines.length,
        expectedTotalLines: this.lines.length,
      };
    this.path = selectedPath;
    this.deletedFromDisk = false;
    this.externalModified = false;
    this.name = selectedPath.replace(/\\/g, "/").split("/").pop() || this.name;
    if (version === this.editVersion) {
      this.setIsSaved(true);
      this.cancelAutoSave();
      this.editor.historyController?.markSaved(this);
      await this.clearRecoverySnapshot();
    }
    const language = await this.editor.highlightController.detectLanguage(
      this.name,
    );
    await this.editor.highlightController.changeLanguage(this, language);
    if (this === this.editor.tabManager.activeFile)
      this.editor.fileExplorer?.setActiveFile(this.path);
    this.editor.tabManager.refresh();
    return true;
  }

  async selectFileToSave() {
    return this.saveAs();
  }

  serializeContent() {
    if (this.lineEndings.length > 0) {
      let content = "";
      for (let index = 0; index < this.lines.length; index++) {
        content += this.lines[index].getText();
        const shouldEndLine =
          index < this.lines.length - 1 || this.hasFinalNewline;
        if (shouldEndLine) content += this.lineEndings[index] || this.eol;
      }
      return content;
    }

    const content = this.lines.map((line) => line.getText()).join(this.eol);
    return content + (this.hasFinalNewline ? this.eol : "");
  }

  setIsSaved(value) {
    this.isSaved = value;
    if (value === false) {
      this.scheduleRecoverySnapshot();
    }
  }

  get autoSave() {
    return this.editor.getAutoSaveState?.() === true;
  }

  isVisuallyDirty() {
    return (
      this.deletedFromDisk === true ||
      this.externalModified === true ||
      Boolean(this.saveError) ||
      (this.isSaved !== true &&
        (this.largeFileMode === true || this.autoSave !== true))
    );
  }

  shouldPersistChanges() {
    return (
      !this.largeFileMode &&
      this.autoSave === true &&
      Boolean(this.path) &&
      !this.deletedFromDisk &&
      !this.externalModified
    );
  }

  onChange() {
    this.setIsSaved(
      this.editor.historyController
        ? this.editor.historyController.isAtSavePoint(this)
        : false,
    );
    this.scheduleAutoSave();
    if (typeof this.editor.tabManager.refreshTabState === "function") {
      this.editor.tabManager.refreshTabState(this);
    } else {
      this.editor.tabManager.refresh();
    }
  }

  keepDiff() {
    if (this.largeFileMode) return;
    this.diffSnapshot = null;
    this.diffActive = false;
    this.diffRows = null;
    this.setIsSaved(false);
    this.editor.lineController.refresh(true);
  }

  undoDiff() {
    if (this.largeFileMode) return;
    if (this.diffSnapshot === null) return;
    const lineController = this.editor.lineController;
    lineController.loadContent(this.diffSnapshot);
    this.diffSnapshot = null;
    this.diffActive = false;
    this.diffRows = null;
    this.editor.tabManager.refresh();
  }
}
