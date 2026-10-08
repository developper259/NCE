class tabManager {
  constructor(e) {
    this.editor = e;
    this.tabs = [];
    this.activeTab = null;
    this.emptyName = "New file";

    this.idCounter = 0;
    this.focusGeneration = 0;
    this.focusResyncTimer = null;
    this.pendingCloseOperations = new Map();
    this.pendingSaveOperations = new Map();
    this.tabElements = new Map();
    this.lastVisibleTab = null;
    this.tabScroller = null;
    this.activeTabListeners = new Set();
  }

  initScroller() {
    if (!this.tabScroller) {
      this.tabScroller = new TabManagerScroller(this.editor, this);
    }
    this.tabScroller.init();
    return this.tabScroller;
  }

  destroy() {
    clearTimeout(this.focusResyncTimer);
    this.focusResyncTimer = null;
    this.tabScroller?.destroy();
    this.tabScroller = null;
    this.activeTabListeners.clear();
  }

  get files() {
    // Keep the legacy collection identity for file-only integrations while
    // excluding non-file tabs from file-specific code paths.
    return this.tabs.every((tab) => tab.type === TAB_TYPES.FILE)
      ? this.tabs
      : this.tabs.filter((tab) => tab.type === TAB_TYPES.FILE);
  }
  set files(files) {
    this.tabs = files;
  }
  get activeFile() {
    return this.activeTab?.type === TAB_TYPES.FILE &&
      this.tabs.includes(this.activeTab)
      ? this.activeTab
      : null;
  }
  set activeFile(file) {
    this.activeTab = file?.type === TAB_TYPES.FILE ? file : null;
  }

  getNextID() {
    this.idCounter++;
    return this.idCounter;
  }

  getFileIndexByID(id) {
    return this.tabs.findIndex((tab) => tab.id == id);
  }

  getFileByID(id) {
    return this.tabs.find((tab) => tab.id == id);
  }

  getFileByPath(path) {
    return this.files.find((file) => NCEPath.equals(file.path, path));
  }

  onActiveTabChange(listener) {
    if (typeof listener !== "function") return () => {};
    this.activeTabListeners.add(listener);
    return () => this.activeTabListeners.delete(listener);
  }

  notifyActiveTabChange(tab) {
    for (const listener of this.activeTabListeners) {
      try {
        listener(tab);
      } catch (error) {
        console.error("Error notifying active tab listener:", error);
      }
    }
  }

  removeFileByID(id) {
    const index = this.getFileIndexByID(id);
    if (index !== -1) {
      const tab = this.tabs[index];
      tab?.disposeAutoSave?.();
      tab?.textTab?.disposeAutoSave?.();
      tab?.disposeRecovery?.();
      tab?.textTab?.disposeRecovery?.();
      this.tabs.splice(index, 1);
    }
  }

  finishLastTabClose() {
    if (!this.editor.isOnInit) {
      this.editor.reset?.();
      this.editor.refreshMainContent?.();
    }
    this.refresh({ resetWhenEmpty: false, refreshTitle: this.editor.isOnInit });
  }

  async updateFilePath(oldPath, newPath) {
    if (!oldPath || !newPath) return;
    let changed = false;
    const pathTabs = Array.isArray(this.tabs) ? this.tabs : [this.activeFile].filter(Boolean);
    for (const file of pathTabs.filter((tab) =>
      tab.type === "file" || tab.type === "picture" || tab.type === "markdown")) {
      if (!file.path || !NCEPath.isInside(file.path, oldPath)) continue;
      if (file.type === "picture" || file.type === "markdown") {
        const previousPath = file.path;
        file.path = NCEPath.rebase(file.path, oldPath, newPath);
        file.name = NCEPath.basename(file.path);
        file.diskFingerprint = null;
        if (file.textTab) {
          file.textTab.path = file.path;
          file.textTab.name = file.name;
        }
        if (file === this.activeTab) {
          if (file.type === "picture") this.editor._pictureView?.invalidate(previousPath);
          else this.editor._markdownView?.invalidate(previousPath);
        }
        changed = true;
        continue;
      }
      // Complete the old-path load before moving its identity.
      if (file.loadingState?.status === "loading") {
        await this.editor.fileLoader.cancelLoading(file.path);
        file.isLoaded = false;
        file.contentGeneration++;
      }
      file.path = NCEPath.rebase(file.path, oldPath, newPath);
      file.name = NCEPath.basename(file.path);
      changed = true;
      await this.editor.highlightController.changeLanguage(
        file,
        await this.editor.highlightController.detectLanguage(file.name),
      );
      if (file === this.activeFile && !file.isLoaded)
        await this.setFocusFile(file);
    }

    if (changed) {
      this.editor.fileExplorer.setActiveFile(
        this.activeFile?.path || (["picture", "markdown"].includes(this.activeTab?.type) ? this.activeTab.path : null),
      );
      this.refresh();
    }
  }

  markFileAsDeleted(path) {
    if (!path) return;
    let changed = false;

    for (const tab of this.tabs.filter((candidate) => ["picture", "markdown"].includes(candidate.type))) {
      if (tab.path && NCEPath.isInside(tab.path, path)) {
        tab.diskFingerprint = null;
        if (tab.type === TAB_TYPES.PICTURE) this.editor._pictureView?.invalidate(tab.path);
        else this.editor._markdownView?.invalidate(tab.path);
      }
    }

    for (const file of this.files) {
      if (!file.path) continue;

      if (NCEPath.isInside(file.path, path)) {
        file.cancelAutoSave?.();
        file.deletedFromDisk = true;
        file.setIsSaved(false);
        changed = true;
      }
    }

    if (changed) this.refresh();
  }

  async openFile(file, { forceText = false } = {}) {
    if (!file) return;
    return this.openFiles([file], true, forceText);
  }

  async openSettings() {
    let tab = this.tabs.find(
      (candidate) => candidate.type === TAB_TYPES.SETTINGS,
    );
    if (!tab) {
      tab = new SettingsTab(this.getNextID());
      this.tabs.push(tab);
    }
    await this.setFocusTab(tab);
    return tab;
  }

  async openFiles(files, isSetFocusFile = true, forceText = false) {
    if (files.length === 0) return;
    let lastAddedFile = null;

    for (let file of files) {
      if (!forceText && file?.path && PictureView.isSupportedPath(file.path)) {
        const existing = this.tabs.find((candidate) =>
          candidate.type === TAB_TYPES.PICTURE && NCEPath.equals(candidate.path, file.path));
        lastAddedFile = existing || file;
        if (!existing) this.tabs.push(file.type === TAB_TYPES.PICTURE
          ? file : new PictureTab(file.id || this.getNextID(), file.path));
        lastAddedFile = existing || this.tabs[this.tabs.length - 1];
        continue;
      }
      if (file.path) {
        const f = this.getFileByPath(file.path);
        if (f) {
          lastAddedFile = f;
          continue;
        }
      }

      if (!file.language) await file.loadLanguage();

      if (
        file.hasPath() &&
        this.activeFile &&
        !this.activeFile.hasPath() &&
        this.activeFile.isEmpty()
      ) {
        this.activeFile.replaceFile(file);
        lastAddedFile = this.activeFile;
      } else {
        this.tabs.push(file);
        lastAddedFile = file;
      }
    }
    if (lastAddedFile) {
      if (isSetFocusFile) await this.setFocusTab(lastAddedFile);

      // Focusing an already-open tab must not mark unsaved edits as saved.
    }

    this.editor.events.callEvent(Events.ON_OPEN_FILE, {
      files: files,
      activeFile: this.activeFile,
    });
    if (!isSetFocusFile) this.editor.refreshAll();
    return lastAddedFile;
  }

  async prepareForQuit() {
    const files = this.tabs.map((tab) => tab.type === "file" ? tab : tab.textTab)
      .filter(Boolean)
      .filter((file, index, allFiles) => allFiles.indexOf(file) === index);
    await Promise.all(files.flatMap((file) => [
      file.flushAutoSave?.(),
      file.flushRecoverySnapshot?.(),
    ]));
    const dirtyFiles = files
      .filter(
      (file) => !file.isSaved && !(file.isEmpty() && !file.hasPath()),
    );

    for (const file of dirtyFiles) {
      const choice = await this.editor.savePopupManager.confirmClose(file.id);
      if (choice === "cancel") return false;
      if (choice === "save" && (!(await this.saveFileOnce(file)) || !file.isSaved))
        return false;
    }

    return true;
  }

  async closeFiles({ skipPrepare = false } = {}) {
    if (!skipPrepare && !(await this.prepareForQuit())) return false;
    if (!(await this.clearRecoverySnapshots())) return false;
    for (const tab of this.tabs) {
      tab.disposeAutoSave?.();
      tab.textTab?.disposeAutoSave?.();
      tab.disposeRecovery?.();
      tab.textTab?.disposeRecovery?.();
    }
    await Promise.all(this.files.map((file) =>
      this.editor.fileLoader.cancelLoading(file.path),
    ));
    this.editor.highlightController.closeAllFiles();
    this.editor._pictureView?.clear?.();
    this.editor._pictureView?.hide?.();
    this.editor._markdownView?.clear?.();
    this.tabs = [];
    this.activeTab = null;
    this.editor.fileExplorer.activeFilePath = null;
    this.editor.searchController.close();
    this.editor.events.callEvent(Events.ON_CLOSE_FILE, {
      file: null,
      activeFile: undefined,
    });
    if (!this.editor.isOnInit) this.editor.refreshAll();
    return true;
  }

  async prepareFilesForDeletion(deletedPath) {
    const dirtyFiles = this.files.filter(
      (file) =>
        file.path && NCEPath.isInside(file.path, deletedPath) && !file.isSaved,
    );
    for (const file of dirtyFiles) {
      const choice = await this.editor.savePopupManager.confirmClose(file.id);
      if (choice === "cancel") return false;
      if (choice === "save") {
        if (this.activeFile?.id !== file.id) await this.setFocusFile(file);
        try {
          const saved = await this.saveFileOnce(file);
          if (saved === false || !file.isSaved) return false;
        } catch (error) {
          console.error("Error saving file before deletion:", error);
          return false;
        }
      }
    }
    return true;
  }

  runCloseOperation(id, operation) {
    const pending = this.pendingCloseOperations.get(id);
    if (pending) return pending;

    let closeOperation;
    closeOperation = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.pendingCloseOperations.get(id) === closeOperation) {
          this.pendingCloseOperations.delete(id);
        }
      });
    this.pendingCloseOperations.set(id, closeOperation);
    return closeOperation;
  }

  saveFileOnce(file) {
    const pending = this.pendingSaveOperations.get(file);
    if (pending) return pending;

    let saveOperation;
    saveOperation = Promise.resolve()
      .then(() => file.save())
      .finally(() => {
        if (this.pendingSaveOperations.get(file) === saveOperation) {
          this.pendingSaveOperations.delete(file);
        }
      });
    this.pendingSaveOperations.set(file, saveOperation);
    return saveOperation;
  }

  closeFile(id) {
    const tab = this.getFileByID(id);
    if (!tab) return Promise.resolve(false);
    if (tab.type !== TAB_TYPES.FILE) return this.closeTab(tab);
    return this.runCloseOperation(id, () => this.closeFileOperation(id));
  }

  async closeFileOperation(id) {
    const tab = this.getFileByID(id);
    if (!tab || tab.type !== TAB_TYPES.FILE) return false;
    const file = tab;
    await file.flushAutoSave?.();

    if (!file.isSaved) {
      if (!(file.isEmpty() && !file.hasPath())) {
        const choice = await this.editor.savePopupManager.confirmClose(id);
        if (choice === "cancel") return false;
        if (choice === "save") {
          if (this.activeFile?.id !== id) await this.setFocusFile(file);
          try {
            const saved = await this.saveFileOnce(file);
            if (saved === false || !file.isSaved) return false;
          } catch (error) {
            console.error("Error saving file before close:", error);
            return false;
          }
        }
      }
    }

    if (file.clearRecoverySnapshot &&
        !(await file.clearRecoverySnapshot())) return false;

    if (id == this.activeFile?.id) {
      if (this.tabs.length > 1) {
        const index = this.getFileIndexByID(id);
        if (index == 0) await this.setFocusTab(this.tabs[index + 1]);
        else await this.setFocusTab(this.tabs[index - 1]);
      }
    }

    await this.editor.fileLoader.cancelLoading(file.path);
    file.contentGeneration++;
    await this.editor.highlightController.closeFile(file);
    this.removeFileByID(id);
    const closedLastTab = this.tabs.length === 0;
    if (closedLastTab) {
      this.activeTab = null;
      this.editor.fileExplorer.activeFilePath = null;
      this.editor.searchController.close();
    }

    this.editor.events.callEvent(Events.ON_CLOSE_FILE, {
      file: file,
      activeFile: this.activeFile,
    });
    if (closedLastTab) {
      this.finishLastTabClose();
    } else if (!this.editor.isOnInit) {
      this.editor.refreshAll();
    }
    return true;
  }

  closeTab(tab) {
    if (!tab || !this.getFileByID(tab.id)) return Promise.resolve(false);
    if (tab.type === TAB_TYPES.FILE) return this.closeFile(tab.id);
    return this.runCloseOperation(tab.id, () => this.closeTabOperation(tab));
  }

  async closeTabOperation(tab) {
    if (!tab || !this.getFileByID(tab.id)) return false;
    if (tab.type === "markdown") await tab.textTab?.flushAutoSave?.();
    if (tab.type === "markdown" && tab.textTab && !tab.textTab.isSaved) {
      const choice = await this.editor.savePopupManager.confirmClose(tab.textTab.id);
      if (choice === "cancel") return false;
      if (choice === "save" && (!(await this.saveFileOnce(tab.textTab)) || !tab.textTab.isSaved))
        return false;
    }
    if (tab.textTab?.clearRecoverySnapshot &&
        !(await tab.textTab.clearRecoverySnapshot())) return false;
    if (tab.id === this.activeTab?.id && this.tabs.length > 1) {
      const index = this.getFileIndexByID(tab.id);
      await this.setFocusTab(this.tabs[index === 0 ? 1 : index - 1]);
    }
    this.removeFileByID(tab.id);
    const closedLastTab = this.tabs.length === 0;
    if (tab.type === TAB_TYPES.PICTURE) this.editor._pictureView?.close?.(tab);
    if (tab.type === "markdown") this.editor._markdownView?.close?.(tab);
    if (closedLastTab) {
      this.activeTab = null;
      this.editor.fileExplorer.activeFilePath = null;
      this.editor.searchController?.close?.();
    }
    this.editor.events.callEvent(Events.ON_CLOSE_FILE, {
      file: null,
      activeFile: this.activeFile,
    });
    if (closedLastTab) {
      this.finishLastTabClose();
    } else {
      this.refresh();
      this.editor.refreshMainContent?.();
    }
    return true;
  }

  async closeFileSet(fileIds, preservedFileId = null) {
    const snapshot = [...fileIds];
    const restorePreservedFile = async () => {
      const preservedFile = this.getFileByID(preservedFileId);
      if (preservedFile && this.activeTab?.id !== preservedFileId) {
        await this.setFocusTab(preservedFile);
      }
    };

    await restorePreservedFile();
    for (const id of snapshot) {
      if (!this.getFileByID(id)) continue;

      let closed = false;
      try {
        closed = await this.closeFile(id);
      } catch (error) {
        console.error("Error closing file:", error);
      }

      await restorePreservedFile();
      if (!closed) return false;
    }

    return true;
  }

  async clearRecoverySnapshots() {
    const files = this.tabs
      .map((tab) => tab.type === TAB_TYPES.FILE ? tab : tab.textTab)
      .filter(Boolean)
      .filter((file, index, allFiles) => allFiles.indexOf(file) === index);
    const results = await Promise.all(files.map((file) =>
      file.clearRecoverySnapshot?.() ?? true,
    ));
    return results.every((result) => result !== false);
  }

  async closeOtherFiles(file) {
    if (!file || !this.getFileByID(file.id)) return false;
    const fileIds = this.tabs
      .filter((candidate) => candidate.id !== file.id)
      .map((candidate) => candidate.id);
    return this.closeFileSet(fileIds, file.id);
  }

  async closeFilesToLeft(file) {
    const index = file ? this.getFileIndexByID(file.id) : -1;
    if (index < 0) return false;
    return this.closeFileSet(
      this.tabs.slice(0, index).map((candidate) => candidate.id),
      file.id,
    );
  }

  async closeFilesToRight(file) {
    const index = file ? this.getFileIndexByID(file.id) : -1;
    if (index < 0) return false;
    return this.closeFileSet(
      this.tabs.slice(index + 1).map((candidate) => candidate.id),
      file.id,
    );
  }

  async closeActiveFile() {
    if (this.activeTab) {
      return this.closeFile(this.activeTab.id);
    }
    return false;
  }

  async setFocusFile(file) {
    return this.setFocusTab(file);
  }

  async cycleTab(direction) {
    const count = this.tabs.length;
    if (count < 2 || !Number.isFinite(direction) || direction === 0) return false;

    const step = direction > 0 ? 1 : -1;
    const currentIndex = this.tabs.indexOf(this.activeTab);
    const startIndex = currentIndex < 0
      ? (step > 0 ? -1 : 0)
      : currentIndex;
    const nextIndex = (startIndex + step + count) % count;
    await this.setFocusTab(this.tabs[nextIndex]);
    return true;
  }

  ensureActiveTabVisible() {
    const tab = this.activeTab;
    const element = tab && this.tabElements?.get(String(tab.id))?.element;
    return this.tabScroller?.ensureElementVisible(element) || false;
  }

  async setFocusTab(tab) {
    if (!tab) return;
    const focusGeneration = ++this.focusGeneration;
    const previousFile = this.activeFile;
    if (previousFile && previousFile !== tab) {
      this.editor.searchController?.saveActiveTabState?.(previousFile);
    }
    this.activeTab = tab;
    this.notifyActiveTabChange(tab);
    if (tab.type !== TAB_TYPES.FILE) {
      this.editor.fileExplorer?.setActiveFile?.(
        ["picture", "markdown"].includes(tab.type) ? tab.path : null,
      );
      this.editor.searchController?.close?.();
      this.editor.refreshMainContent?.();
      if (tab.type === TAB_TYPES.PICTURE || tab.type === "markdown")
        await this.capturePictureFingerprint(tab);
      this.refresh();
      return;
    }
    const file = tab;

    this.editor.lineController.dirtyLines.clear();
    this.editor.highlightController.dirtyLines.clear();

    this.editor.fileExplorer.setActiveFile(file.path);

    if (!file.isLoaded) {
      await file.loadLanguage();
      await file.loadContent();
      await this.captureDiskFingerprint(file);
    }

    if (focusGeneration !== this.focusGeneration) return;

    await this.editor.highlightController.openFile(file);

    if (focusGeneration !== this.focusGeneration) return;

    this.editor.searchController?.restoreTabState?.(file);

    this.editor.cursorController.setCursorPosition(file.row, file.column, {
      ensureVisible: !this.editor.searchController?.isOpen,
    });

    if (!this.editor.isOnInit) this.editor.refreshAll();
    this.editor.refreshMainContent?.();
  }

  async reloadFileFromDisk(path) {
    if (!path) return;

    const file = this.getFileByPath(path);
    if (!file) return;

    if (!file.isSaved) {
      file.cancelAutoSave?.();
      let merge = null;
      try { merge = await file.mergeExternalChanges?.(); }
      catch (error) { console.error("Error merging external file changes:", error); }
      if (!merge?.merged) {
        file.externalModified = true;
        file.mergeDiskFingerprint = null;
      }
      this.refresh();
      return;
    }

    try {
      await this.editor.fileLoader.cancelLoading(file.path);
      file.contentGeneration++;
      await this.editor.highlightController.invalidateFile(file);
      if (file === this.activeFile) {
        file.isLoaded = false;

        await file.loadLanguage();
        await file.loadContent();
        await this.editor.highlightController.openFile(file);

        this.editor.lineController.markDirtyAll();
        this.editor.lineController.refresh(true);
        if (typeof this.editor.scrollerManager.refreshActive === "function") {
          this.editor.scrollerManager.refreshActive();
        } else {
          this.editor.scrollerManager.refreshAll();
        }
      } else {
        file.isLoaded = false;
      }
      await this.captureDiskFingerprint(file);
    } catch (error) {
      console.error("Error reloading file from disk:", error);
    }
  }

  async captureDiskFingerprint(file) {
    const pathStatus = this.editor.fileExplorer?.fileOperations?.pathStatus;
    if (!file?.path || !pathStatus) return;
    const status = await pathStatus.call(
      this.editor.fileExplorer.fileOperations,
      file.path,
    );
    if (status?.exists && !status.isDirectory) {
      file.diskFingerprint = `${status.size}:${status.mtimeMs}`;
      if (file.mergeBaseContent)
        file.mergeBaseFingerprint = file.diskFingerprint;
    }
  }

  async resyncOpenFiles() {
    const pathStatus = this.editor.fileExplorer?.fileOperations?.pathStatus;
    if (!pathStatus) return;

    await Promise.all(
      this.files.map(async (file) => {
        if (!file.path || !file.isLoaded) return;
        const status = await pathStatus.call(
          this.editor.fileExplorer.fileOperations,
          file.path,
        );
        if (!status?.exists || status.isDirectory) {
          if (!file.isSaved) {
            file.cancelAutoSave?.();
            file.externalModified = true;
            this.refresh();
          } else {
            this.markFileAsDeleted(file.path);
          }
          return;
        }
        const fingerprint = `${status.size}:${status.mtimeMs}`;
        if (file.diskFingerprint === fingerprint) return;
        file.diskFingerprint = fingerprint;
        await this.reloadFileFromDisk(file.path);
      }),
    );
    await Promise.all(this.tabs.filter((tab) => [TAB_TYPES.PICTURE, "markdown"].includes(tab.type)).map(async (tab) => {
      if (!tab.path) return;
      const status = await pathStatus.call(this.editor.fileExplorer.fileOperations, tab.path);
      if (!status?.exists || status.isDirectory) {
        tab.diskFingerprint = null;
        if (tab.type === TAB_TYPES.PICTURE) this.editor._pictureView?.invalidate(tab.path);
        else this.editor._markdownView?.invalidate(tab.path);
        return;
      }
      const fingerprint = `${status.size}:${status.mtimeMs}`;
      if (tab.diskFingerprint === fingerprint) return;
      tab.diskFingerprint = fingerprint;
      if (tab.type === TAB_TYPES.PICTURE) {
        this.editor._pictureView?.invalidate(tab.path);
      } else {
        const textTab = tab.textTab;
        if (textTab?.isLoaded && textTab.isSaved) {
          await this.editor.fileLoader.cancelLoading(textTab.path);
          textTab.contentGeneration++;
          await this.editor.highlightController.invalidateFile(textTab);
          textTab.isLoaded = false;
          await textTab.loadLanguage();
          await textTab.loadContent();
        }
        this.editor._markdownView?.invalidate(tab.path);
      }
    }));
  }

  async capturePictureFingerprint(tab) {
    const pathStatus = this.editor.fileExplorer?.fileOperations?.pathStatus;
    if (!tab?.path || !pathStatus) return;
    const status = await pathStatus.call(this.editor.fileExplorer.fileOperations, tab.path);
    if (status?.exists && !status.isDirectory)
      tab.diskFingerprint = `${status.size}:${status.mtimeMs}`;
  }

  scheduleFocusResync() {
    clearTimeout(this.focusResyncTimer);
    this.focusResyncTimer = setTimeout(() => {
      this.focusResyncTimer = null;
      this.resyncOpenFiles().catch((error) =>
        console.error("Error resyncing files after focus:", error),
      );
    }, 150);
  }

  async openFileWithPath(path) {
    if (PictureView.isSupportedPath(path)) return this.openPicture(path);
    let name = NCEPath.basename(path);
    let node = new FileNode(this.editor, this.getNextID(), name, path);
    return this.openFile(node);
  }

  async openPicture(path) {
    if (!PictureView.isPreviewablePath(path)) return null;
    let tab = this.tabs.find((candidate) => candidate.type === TAB_TYPES.PICTURE && NCEPath.equals(candidate.path, path));
    if (!tab) {
      tab = new PictureTab(this.getNextID(), path);
      this.tabs.push(tab);
    }
    await this.setFocusTab(tab);
    return tab;
  }

  async switchActiveTabView(view) {
    const current = this.activeTab;
    const index = this.tabs.indexOf(current);
    if (index < 0 || !current?.path) return null;

    let replacement;
    if (view === "picture" && current.type === TAB_TYPES.FILE &&
        PictureView.isPreviewablePath(current.path)) {
      replacement = new PictureTab(current.id, current.path);
      replacement.textTab = current;
    } else if (view === "markdown" && current.type === TAB_TYPES.FILE &&
        current.largeFileMode !== true && FileType.isMarkdownPath(current.path)) {
      await ensureMarkdownBundle();
      replacement = new MarkdownTab(current.id, current.path);
      replacement.textTab = current;
    } else if (view === "text" && [TAB_TYPES.PICTURE, TAB_TYPES.MARKDOWN].includes(current.type)) {
      replacement = current.textTab || this.getFileByPath(current.path) ||
        new FileNode(this.editor, current.id, NCEPath.basename(current.path), current.path);
    } else {
      return current;
    }

    if (current.type === TAB_TYPES.FILE)
      this.editor.searchController?.saveActiveTabState?.(current);
    this.tabs[index] = replacement;
    await this.setFocusTab(replacement);
    this.refresh();
    return replacement;
  }

  createEmptyFile() {
    const node = new FileNode(
      this.editor,
      this.getNextID(),
      this.emptyName,
      "",
    );
    node.isLoaded = true;
    this.tabs.push(node);
    this.activeTab = node;
    this.refresh();
    void (async () => {
      await node.loadLanguage();
      await this.setFocusFile(node);
      this.editor.events.callEvent(Events.ON_OPEN_FILE, {
        files: [node],
        activeFile: node,
      });
    })();

    return node;
  }

  async selectFile() {
    const file = await this.editor.api.selectFile();
    if (file) {
      let name = NCEPath.basename(file);
      let node = PictureView.isSupportedPath(file)
        ? new PictureTab(this.getNextID(), file)
        : new FileNode(this.editor, this.getNextID(), name, file);
      return node;
    }

    return undefined;
  }

  async selectFiles() {
    const files = await this.editor.api.selectFiles();
    let result = [];

    if (files) {
      for (let file of files) {
        let name = NCEPath.basename(file);
        let node = PictureView.isSupportedPath(file)
          ? new PictureTab(this.getNextID(), file)
          : new FileNode(this.editor, this.getNextID(), name, file);
        result.push(node);
      }
    }

    return result;
  }

  async selectNewFile() {
    return this.editor.api.selectNewFile(
      this.activeFile?.name || this.emptyName,
    );
  }

  createFileOBJ(file) {
    if (!file) return null;

    const li = document.createElement("li");
    li.className = "file-el";
    const titleSpan = document.createElement("span");
    titleSpan.className = "file-el-title";
    li.appendChild(titleSpan);

    const entry = { element: li, title: titleSpan, closeControl: null, dirty: null };
    this.tabElements ||= new Map();
    this.tabElements.set(String(file.id), entry);
    this.updateFileOBJ(file, entry);
    return li;
  }

  createCloseControl(dirty) {
    if (dirty) {
      const indicator = document.createElement("div");
      indicator.className = "file-el-btn file-unsaved";
      return indicator;
    }

    const button = document.createElement("span");
    button.className = "file-el-btn file-saved";
    const img = document.createElement("img");
    img.src = "../assets/icons/close.svg";
    img.alt = "close";
    img.className = "file-el-btn-img";
    img.draggable = false;
    button.appendChild(img);
    return button;
  }

  updateFileOBJ(file, entry) {
    const { element, title } = entry;
    const id = String(file.id);
    const name = String(file.name || "");
    const isActive = this.activeTab?.id === file.id;
    let layoutChanged = false;
    // Auto Save owns persistence while enabled, so its in-flight write should
    // not briefly replace the close affordance with a dirty indicator.
    const dirty = file.type === TAB_TYPES.FILE &&
      typeof file.isVisuallyDirty === "function" && file.isVisuallyDirty();

    if (element.id !== id) element.id = id;
    if (title.textContent !== name) {
      title.textContent = name;
      layoutChanged = true;
    }
    element.classList.toggle("file-active", isActive);

    if (entry.dirty !== dirty || !entry.closeControl?.parentElement) {
      const closeControl = this.createCloseControl(dirty);
      if (entry.closeControl?.parentElement === element) {
        element.replaceChild(closeControl, entry.closeControl);
      } else {
        element.appendChild(closeControl);
      }
      entry.closeControl = closeControl;
      entry.dirty = dirty;
      layoutChanged = true;
    }

    return layoutChanged;
  }

  refreshTabState(file, { refreshScroller = true, ensureVisibility = true } = {}) {
    const entry = file && this.tabElements?.get(String(file.id));
    if (!entry) return false;

    // Text edits only affect the edited file's dirty marker. Avoid walking or
    // rewriting every open tab for this state transition.
    const dirty = file.type === TAB_TYPES.FILE &&
      typeof file.isVisuallyDirty === "function" && file.isVisuallyDirty();
    if (entry.dirty === dirty && entry.closeControl?.parentElement === entry.element)
      return false;

    const closeControl = this.createCloseControl(dirty);
    if (entry.closeControl?.parentElement === entry.element) {
      entry.element.replaceChild(closeControl, entry.closeControl);
    } else {
      entry.element.appendChild(closeControl);
    }
    entry.closeControl = closeControl;
    entry.dirty = dirty;

    const index = this.tabs.indexOf(file);
    const activeIndex = this.tabs.indexOf(this.activeTab);
    if (ensureVisibility && index !== -1 && index <= activeIndex)
      this.ensureActiveTabVisible();
    else if (refreshScroller)
      this.tabScroller?.refresh();
    return true;
  }

  refreshTabStates() {
    const activeIndex = this.tabs.indexOf(this.activeTab);
    let changed = false;
    let activeChanged = false;
    for (let index = 0; index < this.tabs.length; index++) {
      if (!this.refreshTabState(this.tabs[index], {
        refreshScroller: false,
        ensureVisibility: false,
      })) continue;
      changed = true;
      if (index <= activeIndex) activeChanged = true;
    }

    if (activeChanged) this.ensureActiveTabVisible();
    else if (changed) this.tabScroller?.refresh();
    return changed;
  }

  onContextMenu(tabElement) {
    const file = this.getFileByID(tabElement?.id);
    if (!file) return false;
    this.editor.contextMenuManager?.openContextMenu("tab", file);
    return true;
  }

  refresh({ resetWhenEmpty = true, refreshTitle = true } = {}) {
    const ul = getElement(".file-manager .files-ul");
    if (!ul) return;

    this.tabElements ||= new Map();
    const activeKeys = new Set();
    let layoutChanged = false;
    let tabsLayoutChanged = false;
    const activeIndex = this.tabs.indexOf(this.activeTab);
    for (let index = 0; index < this.tabs.length; index++) {
      const tab = this.tabs[index];
      if (!tab) continue;
      const key = String(tab.id);
      activeKeys.add(key);
      let entry = this.tabElements.get(key);
      if (!entry) {
        this.createFileOBJ(tab);
        entry = this.tabElements.get(key);
        tabsLayoutChanged = true;
        if (index <= activeIndex) layoutChanged = true;
      }
      const tabLayoutChanged = this.updateFileOBJ(tab, entry);
      if (tabLayoutChanged) tabsLayoutChanged = true;
      if (tabLayoutChanged && index <= activeIndex) layoutChanged = true;

      const current = ul.children[index] || null;
      if (current !== entry.element) {
        ul.insertBefore(entry.element, current);
        tabsLayoutChanged = true;
        if (index <= activeIndex) layoutChanged = true;
      }
    }

    for (const [key, entry] of this.tabElements) {
      if (activeKeys.has(key)) continue;
      entry.element.remove();
      this.tabElements.delete(key);
      layoutChanged = true;
      tabsLayoutChanged = true;
    }

    const shouldEnsureActiveTab =
      this.activeTab !== this.lastVisibleTab || layoutChanged;
    if (shouldEnsureActiveTab) {
      this.ensureActiveTabVisible();
      this.lastVisibleTab = this.activeTab;
    } else if (tabsLayoutChanged) {
      this.tabScroller?.refresh();
    }

    this.editor.api?.setActiveFileContext?.(Boolean(this.activeFile));
    if (refreshTitle) this.editor.titleBar?.refresh();

    if (this.tabs.length === 0) {
      if (resetWhenEmpty && !this.editor.isOnInit) this.editor.reset();
    } else {
      if (!this.editor.isActive) this.editor.reactive();
    }
  }

  onClick(e) {
    let id = parseInt(e.target.id);
    if (!id && e.target.classList.contains("file-el-title")) {
      id = e.target.parentElement.id;
      if (!id) return;
    }
    let file = this.getFileByID(id);
    this.setFocusTab(file);
  }

  onClickClose(e) {
    const parent = e.target.parentElement;
    let id = parent.id;
    if (!id && e.target.classList.contains("file-el-btn-img")) {
      id = parent.parentElement.id;
      if (!id) return;
    }
    this.closeFile(id);
  }

  getTab(id) {
    return this.tabElements?.get(String(id))?.element ||
      getElement(`.file-manager .file-el[id="${id}"]`);
  }

  hide() {}

  show() {}
}
