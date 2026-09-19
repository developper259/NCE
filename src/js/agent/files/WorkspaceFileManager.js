class WorkspaceFileManager {
  constructor(agent) {
    this.agent = agent;
  }

  shouldPersistAgentEdit(filePath) {
    return this.agent.editor?.getAutoSaveState?.() === true;
  }

  async persistAgentEdit({
    openFile,
    absolutePath,
    relativePath,
    content,
    editVersion,
  }) {
    const failed = (error) => {
      openFile.saveError = error;
      return { saved: false, error };
    };
    if (typeof this.agent.api?.saveFile !== "function") {
      return failed({
        code: "SAVE_FAILED",
        message: `Le fichier n'a pas pu être sauvegardé : ${relativePath}`,
        path: relativePath,
      });
    }
    const saveGuard = this.agent.getMutationGuardError();
    if (saveGuard) return failed(saveGuard);
    if (typeof openFile.enqueueSaveSnapshot === "function") {
      const queued = await openFile.enqueueSaveSnapshot(
        content,
        editVersion,
        this.agent.api.saveFile.bind(this.agent.api),
      );
      if (!queued?.saved) {
        return failed(
          queued?.stale
            ? {
                code: "CONCURRENT_EDIT",
                message: "Le fichier a changé pendant la sauvegarde Agent.",
                path: relativePath,
              }
            : queued?.error || {
                code: "SAVE_FAILED",
                message: `Le fichier n'a pas pu être sauvegardé : ${relativePath}`,
                path: relativePath,
              },
        );
      }
      if (
        typeof queued.result === "string" &&
        !AgentPath.samePath(queued.result, absolutePath)
      ) {
        return failed({
          code: "SAVE_FAILED",
          message: `Le fichier n'a pas pu être sauvegardé : ${relativePath}`,
          path: relativePath,
        });
      }
      openFile.saveError = null;
      return { saved: true };
    }

    let savedPath;
    try {
      savedPath = await this.agent.api.saveFile(absolutePath, content);
    } catch (error) {
      return failed({
        code: "SAVE_FAILED",
        message:
          error?.message ||
          `Le fichier n'a pas pu être sauvegardé : ${relativePath}`,
        path: relativePath,
      });
    }
    if (!AgentPath.samePath(savedPath || "", absolutePath)) {
      return failed({
        code: "SAVE_FAILED",
        message: `Le fichier n'a pas pu être sauvegardé : ${relativePath}`,
        path: relativePath,
      });
    }
    if ((openFile.editVersion || 0) !== editVersion) {
      return failed({
        code: "CONCURRENT_EDIT",
        message: "Le fichier a changé pendant la sauvegarde Agent.",
        path: relativePath,
      });
    }
    openFile.saveError = null;
    openFile.setIsSaved(true);
    this.agent.editor.historyController?.markSaved?.(openFile);
    return { saved: true };
  }

  getWorkspaceFileTarget(filePath) {
    const input = typeof filePath === "string" ? filePath.trim() : "";
    const root = this.agent.editor?.fileExplorer?.rootPath;
    if (
      !input ||
      /[\\/]$/.test(input) ||
      input.includes("\0") ||
      typeof root !== "string" ||
      !root.trim()
    ) {
      return {
        valid: false,
        error: {
          code: "INVALID_PATH",
          message: "Un chemin de fichier et un workspace ouvert sont requis.",
          path: input,
        },
      };
    }
    const absolutePath = this.agent.resolveWorkspacePath(input, root);
    if (!absolutePath) {
      return {
        valid: false,
        error: {
          code: "OUTSIDE_WORKSPACE",
          message: "Le chemin doit rester dans le workspace ouvert.",
          path: input,
        },
      };
    }
    if (
      AgentPath.normalize(absolutePath) === AgentPath.normalize(root) ||
      !AgentPath.basename(absolutePath)
    ) {
      return {
        valid: false,
        error: {
          code: "INVALID_PATH",
          message: "Le chemin doit désigner un fichier.",
          path: input,
        },
      };
    }
    return {
      valid: true,
      input,
      root: AgentPath.normalize(root),
      absolutePath,
      relativePath: this.agent.toProjectRelativePath(absolutePath, root),
      parentPath: AgentPath.dirname(absolutePath),
      fileName: AgentPath.basename(absolutePath),
    };
  }

  getWorkspaceFolderTarget(folderPath) {
    const input = typeof folderPath === "string" ? folderPath.trim() : "";
    const root = this.agent.editor?.fileExplorer?.rootPath;
    if (
      !input ||
      input.includes("\0") ||
      typeof root !== "string" ||
      !root.trim()
    ) {
      return {
        valid: false,
        error: {
          code: "INVALID_PATH",
          message: "Un chemin de dossier et un workspace ouvert sont requis.",
          path: input,
        },
      };
    }
    const absolutePath = this.agent.resolveWorkspacePath(input, root);
    if (!absolutePath) {
      return {
        valid: false,
        error: {
          code: "OUTSIDE_WORKSPACE",
          message: "Le chemin doit rester dans le workspace ouvert.",
          path: input,
        },
      };
    }
    if (AgentPath.samePath(absolutePath, root)) {
      return {
        valid: false,
        error: {
          code: "INVALID_PATH",
          message: "Le chemin doit désigner un sous-dossier du workspace.",
          path: input,
        },
      };
    }
    return {
      valid: true,
      input,
      root: AgentPath.normalize(root),
      absolutePath,
      relativePath: this.agent.toProjectRelativePath(absolutePath, root),
      parentPath: AgentPath.dirname(absolutePath),
      folderName: AgentPath.basename(absolutePath),
    };
  }

  getFileOperationError(result, fallbackCode, fallbackMessage, path) {
    const code = typeof result?.code === "string" ? result.code : fallbackCode;
    return {
      code,
      message:
        typeof result?.error === "string" && result.error
          ? result.error
          : fallbackMessage,
      path,
    };
  }

  async refreshWorkspaceFolders(paths = []) {
    const explorer = this.agent.editor?.fileExplorer;
    if (typeof explorer?.refreshFolder !== "function") return;
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    for (const folderPath of uniquePaths) {
      await explorer.refreshFolder(folderPath);
    }
  }

  async createWorkspaceFile(args = {}) {
    const target = this.agent.getWorkspaceFileTarget(args.path);
    if (!target.valid) return { success: false, error: target.error };

    const content = typeof args.content === "string" ? args.content : "";
    const hardLimit = this.agent.largeFileWriting.maxChunkCharacters;
    if (content.length > hardLimit) {
      return {
        success: false,
        error: {
          code: "FILE_WRITE_CONTENT_TOO_LARGE",
          message: `content dépasse la limite absolue de ${hardLimit} caractères. Créez une première portion plus petite puis utilisez write_file_chunk.`,
          path: target.relativePath,
          actualCharacters: content.length,
          maxCharacters: hardLimit,
          recovery: "chunked_write_required",
        },
      };
    }
    const overwrite = args.overwrite === true;
    const exists = await this.agent.api?.pathExists?.(target.absolutePath);
    if (exists && !overwrite) {
      return {
        success: false,
        error: {
          code: "FILE_ALREADY_EXISTS",
          message:
            "Le fichier existe déjà. Utilisez modify_file pour le modifier.",
          path: target.relativePath,
        },
      };
    }

    const openFile = this.agent.editor?.tabManager?.getFileByPath?.(
      target.absolutePath,
    );
    if (exists && overwrite && openFile && !openFile.isSaved) {
      return {
        success: false,
        error: {
          code: "PERMISSION_DENIED",
          message:
            "Le fichier ouvert contient des modifications non sauvegardées et ne peut pas être écrasé.",
          path: target.relativePath,
        },
      };
    }

    let snapshotKey = null;
    if (exists && overwrite) {
      const previous = (
        await this.agent.api?.getFileContent?.([target.absolutePath])
      )?.[target.absolutePath];
      if (typeof previous !== "string") {
        return {
          success: false,
          error: {
            code: "CREATE_FAILED",
            message: "Le contenu existant n'a pas pu être sauvegardé.",
            path: target.relativePath,
          },
        };
      }
      const revisionValidation = this.agent.validateExpectedRevision(
        previous,
        args.revision,
      );
      if (!revisionValidation.valid) {
        return {
          success: false,
          error: {
            ...revisionValidation.error,
            path: target.relativePath,
          },
        };
      }
      snapshotKey = `create:${target.absolutePath}:${Date.now()}:${Math.random()}`;
      this.agent.fileSnapshots.set(snapshotKey, previous);
    }

    const createGuard = this.agent.getMutationGuardError();
    if (createGuard) return { success: false, error: createGuard };
    const operation = await this.agent.api?.createFile?.(
      target.parentPath,
      target.fileName,
      content,
      overwrite,
    );
    if (!operation?.success) {
      if (snapshotKey) this.agent.fileSnapshots.delete(snapshotKey);
      return {
        success: false,
        error: this.agent.getFileOperationError(
          operation,
          "CREATE_FAILED",
          "La création du fichier a échoué.",
          target.relativePath,
        ),
      };
    }

    const uiWarnings = [];
    if (openFile && overwrite) {
      try {
        openFile.isLoaded = false;
        await this.agent.editor?.tabManager?.reloadFileFromDisk?.(
          target.absolutePath,
        );
      } catch {
        uiWarnings.push("tab_reload_failed");
      }
    }
    try {
      await this.agent.refreshWorkspaceFolders([target.parentPath]);
    } catch {
      uiWarnings.push("explorer_refresh_failed");
    }
    let verifiedContent;
    try {
      verifiedContent = (
        await this.agent.api?.getFileContent?.([target.absolutePath])
      )?.[target.absolutePath];
    } catch {
      verifiedContent = undefined;
    }
    if (typeof verifiedContent !== "string" || verifiedContent !== content) {
      let existsAfterCreate = null;
      try {
        const observed = await this.agent.api?.pathExists?.(
          target.absolutePath,
        );
        if (typeof observed === "boolean") existsAfterCreate = observed;
      } catch {}
      if (existsAfterCreate !== false) {
        this.agent.runChangeTracker?.addChange?.({
          path: target.relativePath,
          status: exists ? "modified" : "created",
          beforeContent: snapshotKey
            ? (this.agent.fileSnapshots.get(snapshotKey) ?? null)
            : null,
          afterContent: null,
          created: !exists,
          modified: exists,
        });
        return {
          success: true,
          operation: "create",
          path: target.relativePath,
          absolutePath: target.absolutePath,
          created: !exists,
          overwritten: Boolean(exists && overwrite),
          mutationOutcome: "APPLIED_BUT_UNCERTAIN",
          verification: {
            verified: false,
            exists: existsAfterCreate,
            reason: "content_unavailable_or_mismatch",
          },
          uiWarnings,
        };
      }
      return {
        success: false,
        mutationOutcome: "NOT_APPLIED",
        error: {
          code: "CREATE_VERIFICATION_FAILED",
          message:
            "Le contenu du fichier créé ne correspond pas au contenu demandé.",
          path: target.relativePath,
        },
      };
    }
    const verificationContext = this.agent.createFileReadContext(
      target.absolutePath,
      verifiedContent,
      1,
      Math.min(200, verifiedContent.split(/\r?\n/).length),
      "post-create-verification",
    );
    this.agent.runChangeTracker?.recordCreate?.({
      success: true,
      path: target.relativePath,
      overwritten: Boolean(exists && overwrite),
      beforeText: snapshotKey
        ? (this.agent.fileSnapshots.get(snapshotKey) ?? null)
        : null,
      content: verifiedContent,
      revision: verificationContext.revision,
      verification: {
        revision: verificationContext.revision,
        content: verifiedContent,
      },
    });
    let openedInTabManager = false;
    if (
      !exists &&
      typeof this.agent.editor?.tabManager?.openFileWithPath === "function"
    ) {
      try {
        await this.agent.editor.tabManager.openFileWithPath(
          target.absolutePath,
        );
        openedInTabManager = true;
        const createdFile = this.agent.editor.tabManager.getFileByPath?.(
          target.absolutePath,
        );
        if (createdFile) {
          this.agent.markFileDiffHighlights("", verifiedContent, createdFile);
          this.agent.editor?.lineController?.markDirtyAll?.();
          this.agent.editor?.lineController?.refresh?.(true);
        }
      } catch {
        uiWarnings.push("tab_open_failed");
      }
    }
    return {
      success: true,
      operation: "create",
      path: target.relativePath,
      absolutePath: target.absolutePath,
      created: !exists,
      overwritten: Boolean(exists && overwrite),
      lineCount:
        verifiedContent === "" ? 0 : verifiedContent.split(/\r?\n/).length,
      openedInTabManager,
      mutationOutcome: "APPLIED_AND_VERIFIED",
      uiWarnings,
      snapshotKey,
      revision: verificationContext.revision,
      verification: {
        verified: true,
        revision: verificationContext.revision,
        content: verificationContext.content,
      },
    };
  }

  async writeWorkspaceFileChunk(args = {}) {
    const target = this.agent.getWorkspaceFileTarget(args.path);
    if (!target.valid) return { success: false, error: target.error };
    if (!(await this.agent.api?.pathExists?.(target.absolutePath))) {
      return {
        success: false,
        error: {
          code: "FILE_NOT_FOUND",
          message:
            "Le fichier n'existe pas. Utilisez create_file avant write_file_chunk.",
          path: target.relativePath,
        },
      };
    }

    const content = typeof args.content === "string" ? args.content : "";
    const expectedRevision =
      typeof args.expectedRevision === "string"
        ? args.expectedRevision.trim()
        : "";
    if (!content || !expectedRevision) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "content et expectedRevision sont obligatoires.",
          path: target.relativePath,
        },
      };
    }
    const uncertainKey = `append:${target.relativePath}:${expectedRevision}:${this.agent.getContentRevision(content)}`;
    if (content.length > this.agent.largeFileWriting.maxChunkCharacters) {
      return {
        success: false,
        error: {
          code: "FILE_WRITE_CONTENT_TOO_LARGE",
          message: `La portion dépasse la limite absolue de ${this.agent.largeFileWriting.maxChunkCharacters} caractères. Découpez-la en portions plus petites.`,
          path: target.relativePath,
          maxCharacters: this.agent.largeFileWriting.maxChunkCharacters,
          actualCharacters: content.length,
          recovery: "chunked_write_required",
        },
      };
    }
    const openFile = this.agent.editor?.tabManager?.getFileByPath?.(
      target.absolutePath,
    );
    if (openFile && !openFile.isSaved) {
      return {
        success: false,
        error: {
          code: "PERMISSION_DENIED",
          message:
            "Le fichier contient des modifications non sauvegardées et ne peut pas recevoir un chunk.",
          path: target.relativePath,
        },
      };
    }
    let currentContent;
    try {
      currentContent = (
        await this.agent.api?.getFileContent?.([target.absolutePath])
      )?.[target.absolutePath];
    } catch {
      currentContent = undefined;
    }
    const uncertain = this.agent.uncertainMutations?.get(uncertainKey);
    if (uncertain) {
      if (currentContent === uncertain.expectedAfterContent) {
        this.agent.uncertainMutations.delete(uncertainKey);
        const revision = this.agent.getContentRevision(currentContent);
        const reconciled = {
          success: true,
          operation: "append",
          path: target.relativePath,
          appendedChars: content.length,
          totalChars: currentContent.length,
          previousRevision: uncertain.beforeRevision,
          revision,
          beforeText: uncertain.beforeContent,
          afterText: currentContent,
          mutationOutcome: "APPLIED_AND_VERIFIED",
          reconciled: true,
          safeToRetry: false,
          verification: { verified: true, revision },
        };
        this.agent.runChangeTracker?.recordModify?.(reconciled);
        return reconciled;
      }
      if (currentContent !== uncertain.beforeContent) {
        return {
          success: false,
          mutationOutcome: "APPLIED_BUT_UNCERTAIN",
          safeToRetry: false,
          error: {
            code:
              typeof currentContent === "string"
                ? "EXTERNAL_CHANGE"
                : "APPEND_STATE_UNCERTAIN",
            message:
              "Le chunk précédent ne peut pas être réappliqué sans risque de duplication.",
            path: target.relativePath,
          },
        };
      }
      this.agent.uncertainMutations.delete(uncertainKey);
    }
    if (typeof currentContent !== "string") {
      return {
        success: false,
        error: {
          code: "READ_FAILED",
          message: "Le contenu actuel du fichier n'a pas pu être lu.",
          path: target.relativePath,
        },
      };
    }
    const currentRevision = this.agent.getContentRevision(currentContent);
    if (expectedRevision !== currentRevision) {
      return {
        success: false,
        error: {
          code: "STALE_REVISION",
          message:
            "Le fichier a changé depuis le chunk précédent. Relisez-le avant de continuer.",
          path: target.relativePath,
          expectedRevision,
          actualRevision: currentRevision,
        },
      };
    }

    const updatedContent = `${currentContent}${content}`;
    const chunkGuard = this.agent.getMutationGuardError();
    if (chunkGuard) return { success: false, error: chunkGuard };
    const savedPath = await this.agent.api?.saveFile?.(
      target.absolutePath,
      updatedContent,
    );
    if (!AgentPath.samePath(savedPath || "", target.absolutePath)) {
      return {
        success: false,
        error: {
          code: "APPEND_FAILED",
          message: "La portion n'a pas pu être enregistrée.",
          path: target.relativePath,
        },
      };
    }
    let verifiedContent;
    try {
      verifiedContent = (
        await this.agent.api?.getFileContent?.([target.absolutePath])
      )?.[target.absolutePath];
    } catch {
      verifiedContent = undefined;
    }
    if (
      typeof verifiedContent !== "string" ||
      verifiedContent !== updatedContent
    ) {
      this.agent.uncertainMutations?.set(uncertainKey, {
        operation: "append",
        path: target.relativePath,
        beforeContent: currentContent,
        expectedAfterContent: updatedContent,
        beforeRevision: currentRevision,
        expectedRevisionAfter: this.agent.getContentRevision(updatedContent),
        chunkContent: content,
      });
      return {
        success: false,
        mutationOutcome: "APPLIED_BUT_UNCERTAIN",
        safeToRetry: false,
        error: {
          code: "APPEND_VERIFICATION_FAILED",
          message:
            "Le contenu du fichier ne correspond pas au résultat attendu après l'ajout.",
          path: target.relativePath,
          actualRevision:
            typeof verifiedContent === "string"
              ? this.agent.getContentRevision(verifiedContent)
              : null,
        },
      };
    }

    if (openFile) {
      try {
        openFile.isLoaded = false;
        await this.agent.editor?.tabManager?.reloadFileFromDisk?.(
          target.absolutePath,
        );
        const refreshedFile = this.agent.editor?.tabManager?.getFileByPath?.(
          target.absolutePath,
        );
        if (refreshedFile) {
          this.agent.markFileDiffHighlights(
            currentContent,
            verifiedContent,
            refreshedFile,
          );
          this.agent.editor?.lineController?.refresh?.(true);
        }
      } catch {}
    }
    const totalLines = verifiedContent.split(/\r?\n/).length;
    const appendedLines = content.split(/\r?\n/).length;
    const appendStartsOnNewLine =
      content.startsWith("\n") || content.startsWith("\r\n");
    const additions =
      currentContent === ""
        ? totalLines
        : appendStartsOnNewLine
          ? Math.max(0, appendedLines - 1)
          : appendedLines;
    const deletions = currentContent !== "" && !appendStartsOnNewLine ? 1 : 0;
    const verificationContext = this.agent.createFileReadContext(
      target.absolutePath,
      verifiedContent,
      Math.max(1, totalLines - 199),
      totalLines,
      "post-chunk-verification",
    );
    const result = {
      success: true,
      operation: "append",
      path: target.relativePath,
      appendedChars: content.length,
      totalChars: verifiedContent.length,
      totalLines,
      additions,
      deletions,
      previousRevision: currentRevision,
      revision: verificationContext.revision,
      beforeText: currentContent,
      afterText: verifiedContent,
      mutationOutcome: "APPLIED_AND_VERIFIED",
      verification: {
        verified: true,
        revision: verificationContext.revision,
      },
    };
    this.agent.runChangeTracker?.recordModify?.(result);
    return result;
  }

  async renameWorkspaceFile(args = {}) {
    const source = this.agent.getWorkspaceFileTarget(args.path);
    if (!source.valid) return { success: false, error: source.error };
    const destination = this.agent.getWorkspaceFileTarget(args.newPath);
    if (!destination.valid) {
      return { success: false, error: destination.error };
    }
    if (AgentPath.samePath(source.absolutePath, destination.absolutePath)) {
      return {
        success: false,
        error: {
          code: "INVALID_PATH",
          message: "Le nouveau chemin doit être différent du chemin actuel.",
          path: destination.relativePath,
        },
      };
    }
    if (!(await this.agent.api?.pathExists?.(source.absolutePath))) {
      return {
        success: false,
        error: {
          code: "FILE_NOT_FOUND",
          message: "Le fichier source n'existe pas.",
          path: source.relativePath,
        },
      };
    }
    if (await this.agent.api?.pathExists?.(destination.absolutePath)) {
      return {
        success: false,
        error: {
          code: "DESTINATION_EXISTS",
          message: "La destination existe déjà.",
          path: destination.relativePath,
        },
      };
    }
    if (!(await this.agent.api?.pathExists?.(destination.parentPath))) {
      return {
        success: false,
        error: {
          code: "PARENT_NOT_FOUND",
          message: "Le dossier de destination n'existe pas.",
          path: destination.relativePath,
        },
      };
    }

    const renameGuard = this.agent.getMutationGuardError();
    if (renameGuard) return { success: false, error: renameGuard };
    const operation = await this.agent.api?.renameEntry?.(
      source.absolutePath,
      destination.absolutePath,
    );
    if (!operation?.success) {
      return {
        success: false,
        error: this.agent.getFileOperationError(
          operation,
          "RENAME_FAILED",
          "Le renommage du fichier a échoué.",
          source.relativePath,
        ),
      };
    }

    const tabManager = this.agent.editor?.tabManager;
    const uiWarnings = [];
    try {
      await tabManager?.updateFilePath?.(
        source.absolutePath,
        destination.absolutePath,
      );
    } catch {
      uiWarnings.push("tab_path_update_failed");
    }
    const explorer = this.agent.editor?.fileExplorer;
    if (
      AgentPath.samePath(explorer?.activeFilePath || "", source.absolutePath)
    ) {
      explorer.activeFilePath = destination.absolutePath;
    }
    if (this.agent.readFileContexts.has(source.absolutePath)) {
      this.agent.readFileContexts.set(
        destination.absolutePath,
        this.agent.readFileContexts.get(source.absolutePath),
      );
      this.agent.readFileContexts.delete(source.absolutePath);
    }
    try {
      await this.agent.refreshWorkspaceFolders([
        source.parentPath,
        destination.parentPath,
      ]);
    } catch {
      uiWarnings.push("explorer_refresh_failed");
    }
    let sourceStillExists = null;
    let destinationExists = null;
    try {
      sourceStillExists = await this.agent.api?.pathExists?.(
        source.absolutePath,
      );
      destinationExists = await this.agent.api?.pathExists?.(
        destination.absolutePath,
      );
    } catch {}
    if (sourceStillExists === null || destinationExists === null) {
      this.agent.runChangeTracker?.recordRename?.({
        success: true,
        oldPath: source.relativePath,
        newPath: destination.relativePath,
        verification: { verified: false },
      });
      return {
        success: true,
        operation: "rename",
        oldPath: source.relativePath,
        newPath: destination.relativePath,
        mutationOutcome: "APPLIED_BUT_UNCERTAIN",
        verification: { verified: false, sourceStillExists, destinationExists },
        uiWarnings,
      };
    }
    if (sourceStillExists || !destinationExists) {
      return {
        success: false,
        mutationOutcome:
          !sourceStillExists || destinationExists
            ? "APPLIED_BUT_UNCERTAIN"
            : "NOT_APPLIED",
        error: {
          code: "RENAME_VERIFICATION_FAILED",
          message: "Le renommage n'a pas pu être vérifié dans le workspace.",
          path: source.relativePath,
          newPath: destination.relativePath,
        },
      };
    }
    const renamedContent = (
      await this.agent.api?.getFileContent?.([destination.absolutePath])
    )?.[destination.absolutePath];
    let verification = { verified: true };
    if (typeof renamedContent === "string") {
      const verificationContext = this.agent.createFileReadContext(
        destination.absolutePath,
        renamedContent,
        1,
        Math.min(200, renamedContent.split(/\r?\n/).length),
        "post-rename-verification",
      );
      verification = {
        verified: true,
        revision: verificationContext.revision,
        content: verificationContext.content,
      };
    }
    this.agent.runChangeTracker?.recordRename?.({
      success: true,
      oldPath: source.relativePath,
      newPath: destination.relativePath,
      verification,
      renamed: true,
      mutationOutcome: "APPLIED_AND_VERIFIED",
      uiWarnings,
    });
    return {
      success: true,
      operation: "rename",
      oldPath: source.relativePath,
      newPath: destination.relativePath,
      oldAbsolutePath: source.absolutePath,
      newAbsolutePath: destination.absolutePath,
      renamed: true,
      mutationOutcome: "APPLIED_AND_VERIFIED",
      uiWarnings,
      verification,
    };
  }

  async deleteWorkspaceFile(args = {}) {
    const target = this.agent.getWorkspaceFileTarget(args.path);
    if (!target.valid) return { success: false, error: target.error };

    const status = await this.agent.api?.pathStatus?.(target.absolutePath);
    if (!status?.exists) {
      return {
        success: false,
        error: {
          code: "FILE_NOT_FOUND",
          message: "Le fichier à supprimer n'existe pas.",
          path: target.relativePath,
        },
      };
    }
    if (status.isDirectory) {
      return {
        success: false,
        error: {
          code: "NOT_A_FILE",
          message: "delete_file ne peut pas supprimer un dossier.",
          path: target.relativePath,
        },
      };
    }

    const tabManager = this.agent.editor?.tabManager;
    const openFile = tabManager?.getFileByPath?.(target.absolutePath);
    if (openFile && !openFile.isSaved) {
      return {
        success: false,
        error: {
          code: "DIRTY_FILE",
          message:
            "Le fichier contient des modifications non sauvegardées et ne peut pas être supprimé.",
          path: target.relativePath,
        },
      };
    }

    const beforeContent = openFile?.lines
      ? openFile.lines.map((line) => line.getText()).join("\n")
      : ((await this.agent.api?.getFileContent?.([target.absolutePath]))?.[
          target.absolutePath
        ] ?? null);
    const beforeRevision =
      typeof beforeContent === "string"
        ? this.agent.getContentRevision(beforeContent)
        : null;
    const deleteGuard = this.agent.getMutationGuardError();
    if (deleteGuard) return { success: false, error: deleteGuard };
    const operation = await this.agent.api?.deleteEntry?.(target.absolutePath);
    if (!operation?.success) {
      return {
        success: false,
        error: this.agent.getFileOperationError(
          operation,
          "DELETE_FAILED",
          "La suppression du fichier a échoué.",
          target.relativePath,
        ),
      };
    }

    let existsAfterDelete = null;
    try {
      const observed = await this.agent.api?.pathExists?.(target.absolutePath);
      if (typeof observed === "boolean") existsAfterDelete = observed;
    } catch {}
    if (existsAfterDelete === true) {
      return {
        success: false,
        mutationOutcome: "NOT_APPLIED",
        error: {
          code: "DELETE_VERIFICATION_FAILED",
          message: "La disparition du fichier n'a pas pu être vérifiée.",
          path: target.relativePath,
        },
      };
    }

    const uiWarnings = [];
    if (openFile) {
      try {
        const closed = await tabManager?.closeFile?.(openFile.id);
        if (!closed) tabManager?.markFileAsDeleted?.(target.absolutePath);
      } catch (error) {
        uiWarnings.push("tab_close_failed");
        console.warn("[NCE Agent delete] tab synchronization failed", {
          message: String(error?.message || error).slice(0, 240),
        });
      }
    }
    this.agent.readFileContexts.delete(target.absolutePath);
    try {
      this.agent.editor?.quickOpen?.invalidate?.(target.root);
    } catch {
      uiWarnings.push("quick_open_invalidation_failed");
    }
    try {
      await this.agent.refreshWorkspaceFolders([target.parentPath]);
    } catch {
      uiWarnings.push("explorer_refresh_failed");
    }

    this.agent.runChangeTracker?.recordDelete?.(
      { success: true, path: target.relativePath },
      beforeContent,
    );
    return {
      success: true,
      operation: "delete",
      path: target.relativePath,
      absolutePath: target.absolutePath,
      deleted: true,
      beforeContent,
      beforeRevision,
      mutationOutcome:
        existsAfterDelete === false
          ? "APPLIED_AND_VERIFIED"
          : "APPLIED_BUT_UNCERTAIN",
      verification: {
        verified: existsAfterDelete === false,
        kind: "absence",
        exists: existsAfterDelete,
      },
      uiWarnings,
    };
  }

  async createWorkspaceFolder(args = {}) {
    const target = this.agent.getWorkspaceFolderTarget(args.path);
    if (!target.valid) return { success: false, error: target.error };
    if (!(await this.agent.api?.pathExists?.(target.parentPath))) {
      return {
        success: false,
        error: {
          code: "PARENT_NOT_FOUND",
          message: "Le dossier parent n'existe pas.",
          path: target.relativePath,
        },
      };
    }
    if (await this.agent.api?.pathExists?.(target.absolutePath)) {
      return {
        success: false,
        error: {
          code: "FOLDER_ALREADY_EXISTS",
          message: "Le dossier existe déjà.",
          path: target.relativePath,
        },
      };
    }
    const guard = this.agent.getMutationGuardError();
    if (guard) return { success: false, error: guard };
    const operation = await this.agent.api?.createFolder?.(
      target.parentPath,
      target.folderName,
    );
    if (!operation?.success) {
      return {
        success: false,
        error: this.agent.getFileOperationError(
          operation,
          "CREATE_FOLDER_FAILED",
          "La création du dossier a échoué.",
          target.relativePath,
        ),
      };
    }
    let exists = null;
    try {
      exists = await this.agent.api?.pathExists?.(target.absolutePath);
    } catch {}
    const uiWarnings = [];
    try {
      await this.agent.refreshWorkspaceFolders([target.parentPath]);
    } catch {
      uiWarnings.push("explorer_refresh_failed");
    }
    return {
      success: true,
      operation: "create_folder",
      path: target.relativePath,
      absolutePath: target.absolutePath,
      created: true,
      mutationOutcome:
        exists === true ? "APPLIED_AND_VERIFIED" : "APPLIED_BUT_UNCERTAIN",
      verification: { verified: exists === true, exists },
      uiWarnings,
    };
  }

  async deleteWorkspaceFolder(args = {}) {
    const target = this.agent.getWorkspaceFolderTarget(args.path);
    if (!target.valid)
      return {
        success: false,
        mutationOutcome: "NOT_APPLIED",
        error: target.error,
      };
    let status;
    try {
      status = await this.agent.api?.pathStatus?.(target.absolutePath);
    } catch (error) {
      console.warn("[NCE Agent delete_folder] path_status failed", {
        path: target.relativePath,
        error,
      });
      return {
        success: false,
        mutationOutcome: "NOT_APPLIED",
        error: {
          code: "FOLDER_STATUS_FAILED",
          message: "Le statut du dossier n'a pas pu être vérifié.",
          path: target.relativePath,
          stage: "path_status",
        },
      };
    }
    if (!status?.exists) {
      return {
        success: false,
        mutationOutcome: "NOT_APPLIED",
        error: {
          code: "FOLDER_NOT_FOUND",
          message: "Le dossier à supprimer n'existe pas.",
          path: target.relativePath,
        },
      };
    }
    if (!status.isDirectory) {
      return {
        success: false,
        mutationOutcome: "NOT_APPLIED",
        error: {
          code: "NOT_A_FOLDER",
          message: "delete_folder ne peut supprimer qu'un dossier.",
          path: target.relativePath,
        },
      };
    }
    const guard = this.agent.getMutationGuardError();
    if (guard)
      return { success: false, mutationOutcome: "NOT_APPLIED", error: guard };
    let operation;
    let deletionError = null;
    try {
      operation = await this.agent.api?.deleteEntry?.(
        target.absolutePath,
        true,
      );
    } catch (error) {
      deletionError = error;
      console.warn("[NCE Agent delete_folder] filesystem_delete failed", {
        path: target.relativePath,
        error,
      });
    }
    let exists = null;
    try {
      const observed = await this.agent.api?.pathExists?.(target.absolutePath);
      if (typeof observed === "boolean") exists = observed;
    } catch (error) {
      console.warn(
        "[NCE Agent delete_folder] post_delete_verification failed",
        { path: target.relativePath, error },
      );
    }
    if (exists === true || (!operation?.success && exists !== false)) {
      return {
        success: false,
        mutationOutcome:
          exists === true ? "NOT_APPLIED" : "APPLIED_BUT_UNCERTAIN",
        error: {
          ...this.agent.getFileOperationError(
            operation,
            "DELETE_FOLDER_FAILED",
            "La suppression du dossier a échoué.",
            target.relativePath,
          ),
          stage:
            deletionError || !operation?.success
              ? "filesystem_delete"
              : "post_delete_verification",
        },
      };
    }
    const uiWarnings = [];
    if (deletionError || !operation?.success)
      uiWarnings.push("filesystem_delete_reported_error_but_absence_verified");
    const tabManager = this.agent.editor?.tabManager;
    try {
      const openFiles = [...(tabManager?.files || [])].filter((file) =>
        AgentPath.isInside(file.path, target.absolutePath),
      );
      for (const openFile of openFiles) {
        try {
          const closed = await tabManager?.closeFile?.(openFile.id);
          if (!closed) tabManager?.markFileAsDeleted?.(openFile.path);
        } catch (error) {
          uiWarnings.push("tab_close_failed");
          console.warn("[NCE Agent delete_folder] tab_cleanup failed", {
            path: openFile.path,
            error,
          });
        }
      }
    } catch (error) {
      uiWarnings.push("tab_cleanup_failed");
      console.warn("[NCE Agent delete_folder] tab_cleanup failed", {
        path: target.relativePath,
        error,
      });
    }
    try {
      for (const contextPath of this.agent.readFileContexts.keys()) {
        if (AgentPath.isInside(contextPath, target.absolutePath)) {
          this.agent.readFileContexts.delete(contextPath);
        }
      }
    } catch (error) {
      uiWarnings.push("context_cleanup_failed");
      console.warn("[NCE Agent delete_folder] context_cleanup failed", {
        path: target.relativePath,
        error,
      });
    }
    try {
      this.agent.editor?.quickOpen?.invalidate?.(target.root);
    } catch (error) {
      uiWarnings.push("quick_open_invalidation_failed");
      console.warn("[NCE Agent delete_folder] quick_open_cleanup failed", {
        path: target.relativePath,
        error,
      });
    }
    try {
      await this.agent.refreshWorkspaceFolders([target.parentPath]);
    } catch (error) {
      uiWarnings.push("explorer_refresh_failed");
      console.warn("[NCE Agent delete_folder] explorer_refresh failed", {
        path: target.relativePath,
        error,
      });
    }
    try {
      const tracker = this.agent.runChangeTracker;
      for (const changePath of [...(tracker?.current?.changes.keys() || [])]) {
        if (AgentPath.isInside(changePath, target.relativePath)) {
          tracker.recordDelete({ success: true, path: changePath });
        }
      }
    } catch (error) {
      uiWarnings.push("change_tracking_failed");
      console.warn("[NCE Agent delete_folder] change_tracking failed", {
        path: target.relativePath,
        error,
      });
    }
    return {
      success: true,
      operation: "delete_folder",
      path: target.relativePath,
      absolutePath: target.absolutePath,
      deleted: true,
      mutationOutcome:
        exists === false ? "APPLIED_AND_VERIFIED" : "APPLIED_BUT_UNCERTAIN",
      verification: { verified: exists === false, exists },
      uiWarnings,
    };
  }

  async modifyFile(args = {}) {
    const relativePath = typeof args.path === "string" ? args.path.trim() : "";
    if (!relativePath) {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Le chemin du fichier est obligatoire.",
        },
      };
    }

    const root = this.agent.editor?.fileExplorer?.rootPath;
    const absolutePath = this.agent.resolveWorkspacePath(relativePath, root);
    if (!absolutePath) {
      return {
        success: false,
        error: {
          code: "INVALID_PATH",
          message: "Chemin hors du workspace.",
        },
      };
    }

    const oldText = typeof args.oldText === "string" ? args.oldText : "";
    const newText =
      typeof args.newText === "string"
        ? args.newText
        : typeof args.text === "string"
          ? args.text
          : "";
    const nearLine =
      Number.isInteger(args.nearLine) && args.nearLine > 0
        ? args.nearLine
        : undefined;

    if (typeof oldText !== "string" || typeof newText !== "string") {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "oldText et newText doivent être des chaînes.",
        },
      };
    }

    const requestKey = JSON.stringify({
      path: absolutePath,
      oldText,
      newText,
      nearLine: nearLine ?? null,
      revision: args.revision ?? null,
    });
    if (this.agent.executedModificationRequests.has(requestKey)) {
      return {
        success: false,
        error: {
          code: "DUPLICATE_MODIFICATION",
          message: "Cette modification de fichier a déjà été exécutée.",
        },
      };
    }

    const tabManager = this.agent.editor?.tabManager;
    const alreadyOpen = tabManager?.getFileByPath?.(absolutePath);
    if (alreadyOpen) {
      await this.agent.editor?.fileLoader?.waitForFileLoaded?.(alreadyOpen);
    }
    if (!alreadyOpen && typeof this.agent.api?.pathExists === "function") {
      const exists = await this.agent.api.pathExists(absolutePath);
      if (!exists) {
        return {
          success: false,
          error: {
            code: "FILE_NOT_FOUND",
            message: `Le fichier n'existe pas : ${relativePath}`,
            path: relativePath,
          },
        };
      }
    }

    const persistToDisk = this.agent.shouldPersistAgentEdit(absolutePath);
    const currentText = alreadyOpen
      ? alreadyOpen.lines.map((line) => line.getText()).join("\n")
      : (await this.agent.api?.getFileContent?.([absolutePath]))?.[
          absolutePath
        ];
    if (typeof currentText !== "string") {
      return {
        success: false,
        error: {
          code: "READ_FAILED",
          message: `Impossible de lire le fichier : ${relativePath}`,
        },
      };
    }
    const revisionValidation = this.agent.validateExpectedRevision(
      currentText,
      args.revision,
    );
    if (!revisionValidation.valid) {
      return {
        success: false,
        error: {
          ...revisionValidation.error,
          path: this.agent.toProjectRelativePath(absolutePath, root),
        },
      };
    }
    if (oldText.includes("[... contenu tronqué par NCE ...]")) {
      return {
        success: false,
        error: {
          code: "INVALID_OLD_TEXT",
          message:
            "oldText ne peut pas contenir le marqueur de troncature NCE.",
          path: this.agent.toProjectRelativePath(absolutePath, root),
        },
      };
    }
    const currentRevision = revisionValidation.currentRevision;
    const replacementText = this.agent.adaptReplacementLineEndings(
      newText,
      currentText,
    );
    const editorUpdatedText = (updatedText) =>
      updatedText.replace(/\r\n?/g, "\n");
    const getConcurrentChangeError = (openFile) => {
      const liveText = openFile?.lines
        ?.map((line) => line.getText())
        .join("\n");
      if (
        typeof liveText !== "string" ||
        liveText === editorUpdatedText(currentText)
      ) {
        return null;
      }
      return {
        code: "STALE_REVISION",
        message: "Le fichier a changé pendant la préparation de l'écriture.",
        path: this.agent.toProjectRelativePath(absolutePath, root),
        expectedRevision: currentRevision,
        actualRevision: this.agent.getContentRevision(liveText),
      };
    };

    if (oldText.length === 0 && replacementText === "") {
      return {
        success: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Le remplacement ne peut pas être vide si oldText est vide.",
        },
      };
    }
    if (
      oldText.length > 0 &&
      replacementText.includes(`${oldText}${oldText}`)
    ) {
      return {
        success: false,
        error: {
          code: "SUSPECTED_DUPLICATION",
          message:
            "The replacement contains two consecutive copies of oldText.",
        },
      };
    }

    if (oldText.length === 0) {
      const updatedText = `${replacementText}${currentText}`;
      const normalizedUpdatedText = editorUpdatedText(updatedText);
      const result = {
        success: true,
        operation: "replace",
        path: this.agent.toProjectRelativePath(absolutePath, root),
        absolutePath,
        beforeText: currentText,
        afterText: updatedText,
        match: "insert-start",
        nearLine: nearLine ?? null,
        previousRevision: currentRevision,
        revision: this.agent.getContentRevision(updatedText),
      };

      if (tabManager && !alreadyOpen) {
        await tabManager.openFileWithPath(absolutePath);
      }
      const openFile = tabManager?.getFileByPath?.(absolutePath);
      if (!openFile) {
        this.agent.executedModificationRequests.delete(requestKey);
        return {
          success: false,
          error: {
            code: "TARGET_FILE_NOT_OPEN",
            message: `Le fichier cible n'a pas pu être ouvert : ${relativePath}`,
          },
        };
      }
      if (!AgentPath.samePath(openFile.path, absolutePath)) {
        this.agent.executedModificationRequests.delete(requestKey);
        return {
          success: false,
          error: {
            code: "TARGET_PATH_MISMATCH",
            message: `Le tab ouvert ne correspond pas au fichier cible : ${relativePath}`,
          },
        };
      }
      if (openFile) {
        const concurrentChange = getConcurrentChangeError(openFile);
        if (concurrentChange)
          return { success: false, error: concurrentChange };
        openFile.isLoaded = false;
        await tabManager.setFocusFile(openFile);
        this.agent.editor.lineController?.loadContent?.(normalizedUpdatedText);
        if (openFile) {
          openFile.lines = normalizedUpdatedText
            .split("\n")
            .map((line) => new LineNode(line));
          openFile.totalLines = openFile.lines.length;
          openFile.maxLineLength = 0;
        }
        const writtenText = openFile.lines
          .map((line) => line.getText())
          .join("\n");
        if (writtenText !== normalizedUpdatedText) {
          this.agent.editor.lineController?.loadContent?.(
            editorUpdatedText(currentText),
          );
          return {
            success: false,
            error: {
              code: "VERIFICATION_FAILED",
              message:
                "Le contenu écrit ne correspond pas au remplacement demandé.",
              path: relativePath,
            },
          };
        }
        await this.agent.editor.highlightController?.syncDocumentFromEditor?.(
          openFile,
          currentText,
        );
        this.agent.markFileDiffHighlights(currentText, updatedText, openFile);
        if (this.agent.editor.lineController?.refresh) {
          this.agent.editor.lineController.refresh(true);
        }
        const editVersion = (openFile.editVersion || 0) + 1;
        openFile.editVersion = editVersion;
        openFile.setIsSaved(false);
        if (persistToDisk) {
          const persistence = await this.persistAgentEdit({
            openFile,
            absolutePath,
            relativePath,
            content: updatedText,
            editVersion,
          });
          if (!persistence.saved) {
            const applied = {
              ...result,
              success: true,
              revision: this.agent.getContentRevision(normalizedUpdatedText),
              mutationOutcome: "APPLIED_BUT_UNCERTAIN",
              persistence,
              verification: this.agent.buildModificationVerification(
                absolutePath,
                normalizedUpdatedText,
                0,
                replacementText,
              ),
            };
            this.agent.runChangeTracker?.recordModify?.(applied);
            return applied;
          }
        }
      }
      result.revision = this.agent.getContentRevision(normalizedUpdatedText);
      result.verification = this.agent.buildModificationVerification(
        absolutePath,
        normalizedUpdatedText,
        0,
        replacementText,
      );
      result.mutationOutcome = "APPLIED_AND_VERIFIED";
      result.persistence = { saved: persistToDisk };
      this.agent.runChangeTracker?.recordModify?.(result);
      this.agent.executedModificationRequests.set(requestKey, result);
      return result;
    }

    const textMatch = this.agent.findUniqueTextMatch(
      currentText,
      oldText,
      nearLine,
    );
    if (textMatch.status === "missing") {
      return {
        success: false,
        error: {
          code: "OLD_TEXT_NOT_FOUND",
          message:
            "Aucune occurrence exacte de oldText n'existe dans le fichier à cette revision.",
          path: this.agent.toProjectRelativePath(absolutePath, root),
          nearLine: nearLine ?? null,
        },
      };
    }

    if (textMatch.status === "ambiguous") {
      return {
        success: false,
        error: {
          code: "AMBIGUOUS_MATCH",
          message:
            "oldText est présent plusieurs fois dans ce fichier. Le remplacement est refusé.",
          occurrences: textMatch.occurrences,
          nearestLines: textMatch.nearestLines || [],
        },
      };
    }

    const updatedText =
      currentText.slice(0, textMatch.startIndex) +
      replacementText +
      currentText.slice(textMatch.endIndex);
    const normalizedUpdatedText = editorUpdatedText(updatedText);

    const result = {
      success: true,
      operation: "replace",
      path: this.agent.toProjectRelativePath(absolutePath, root),
      absolutePath,
      beforeText: currentText,
      afterText: updatedText,
      match: textMatch.match,
      nearLine: nearLine ?? null,
      previousRevision: currentRevision,
      revision: this.agent.getContentRevision(updatedText),
    };

    if (tabManager && !alreadyOpen) {
      await tabManager.openFileWithPath(absolutePath);
    }
    const openFile = tabManager?.getFileByPath?.(absolutePath);
    if (!openFile) {
      this.agent.executedModificationRequests.delete(requestKey);
      return {
        success: false,
        error: {
          code: "TARGET_FILE_NOT_OPEN",
          message: `Le fichier cible n'a pas pu être ouvert : ${relativePath}`,
        },
      };
    }
    if (!AgentPath.samePath(openFile.path, absolutePath)) {
      this.agent.executedModificationRequests.delete(requestKey);
      return {
        success: false,
        error: {
          code: "TARGET_PATH_MISMATCH",
          message: `Le tab ouvert ne correspond pas au fichier cible : ${relativePath}`,
        },
      };
    }
    if (openFile) {
      const concurrentChange = getConcurrentChangeError(openFile);
      if (concurrentChange) return { success: false, error: concurrentChange };
      openFile.isLoaded = false;
      await tabManager.setFocusFile(openFile);
      this.agent.editor.lineController?.loadContent?.(normalizedUpdatedText);
      if (openFile) {
        openFile.lines = normalizedUpdatedText
          .split("\n")
          .map((line) => new LineNode(line));
        openFile.totalLines = openFile.lines.length;
        openFile.maxLineLength = 0;
      }
      const writtenText = openFile.lines
        .map((line) => line.getText())
        .join("\n");
      if (writtenText !== normalizedUpdatedText) {
        this.agent.editor.lineController?.loadContent?.(
          editorUpdatedText(currentText),
        );
        return {
          success: false,
          error: {
            code: "VERIFICATION_FAILED",
            message:
              "Le contenu écrit ne correspond pas au remplacement demandé.",
            path: relativePath,
          },
        };
      }
      await this.agent.editor.highlightController?.syncDocumentFromEditor?.(
        openFile,
        currentText,
      );
      this.agent.markFileDiffHighlights(currentText, updatedText, openFile);
      if (this.agent.editor.lineController?.refresh) {
        this.agent.editor.lineController.refresh(true);
      }
      const editVersion = (openFile.editVersion || 0) + 1;
      openFile.editVersion = editVersion;
      openFile.setIsSaved(false);
      if (persistToDisk) {
        const persistence = await this.persistAgentEdit({
          openFile,
          absolutePath,
          relativePath,
          content: updatedText,
          editVersion,
        });
        if (!persistence.saved) {
          const applied = {
            ...result,
            success: true,
            revision: this.agent.getContentRevision(normalizedUpdatedText),
            mutationOutcome: "APPLIED_BUT_UNCERTAIN",
            persistence,
            verification: this.agent.buildModificationVerification(
              absolutePath,
              normalizedUpdatedText,
              editorUpdatedText(currentText.slice(0, textMatch.startIndex))
                .length,
              replacementText.replace(/\r\n?/g, "\n"),
            ),
          };
          this.agent.runChangeTracker?.recordModify?.(applied);
          return applied;
        }
      }
    }
    result.revision = this.agent.getContentRevision(normalizedUpdatedText);
    result.verification = this.agent.buildModificationVerification(
      absolutePath,
      normalizedUpdatedText,
      editorUpdatedText(currentText.slice(0, textMatch.startIndex)).length,
      replacementText.replace(/\r\n?/g, "\n"),
    );
    result.mutationOutcome = "APPLIED_AND_VERIFIED";
    result.persistence = { saved: persistToDisk };
    this.agent.runChangeTracker?.recordModify?.(result);
    this.agent.executedModificationRequests.set(requestKey, result);
    return result;
  }

  async resolveReadSource(absolutePath, openFile) {
    const loader = this.agent.editor?.fileLoader;
    let state = openFile
      ? openFile.loadingState || loader?.getState?.(openFile.path)
      : null;
    let fallbackReason = null;
    if (openFile && state?.status === "loading") {
      try {
        await loader?.waitForFileLoaded?.(openFile);
      } catch (error) {
        fallbackReason = error?.code || "FILE_NOT_FULLY_LOADED";
      }
      state = openFile.loadingState || loader?.getState?.(openFile.path);
    }
    const editorComplete =
      openFile &&
      (state
        ? state.status === "loaded" &&
          state.loadedLineCount === state.expectedTotalLines &&
          Array.isArray(openFile.lines)
        : typeof loader?.getState !== "function" &&
          (openFile.isSaved === false || openFile.isLoaded !== false) &&
          Array.isArray(openFile.lines));
    if (editorComplete) {
      const result = {
        kind: "editor",
        content: openFile.lines.map((line) => line.getText()).join("\n"),
      };
      this.logReadSource(absolutePath, openFile, true, result);
      return result;
    }

    if (openFile) {
      fallbackReason ||=
        state?.status === "failed"
          ? state.error?.code || "FILE_LOAD_FAILED"
          : "FILE_NOT_FULLY_LOADED";
    }
    let content;
    let filesystemError = null;
    try {
      content = (await this.agent.api?.getFileContent?.([absolutePath]))?.[
        absolutePath
      ];
    } catch (error) {
      filesystemError = error;
    }
    const result = {
      kind: "filesystem",
      content,
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(filesystemError ? { filesystemError } : {}),
    };
    this.logReadSource(absolutePath, openFile, false, result);
    return result;
  }

  logReadSource(absolutePath, openFile, editorLoaded, source) {
    console.info("[NCE Agent read source]", {
      path: this.agent.toProjectRelativePath(
        absolutePath,
        this.agent.editor?.fileExplorer?.rootPath,
      ),
      editorOpen: Boolean(openFile),
      editorLoaded,
      selectedSource: source.kind,
      ...(source.fallbackReason
        ? { fallbackReason: source.fallbackReason }
        : {}),
    });
  }

  withReadSourceMetadata(result, source) {
    if (!source.fallbackReason) return result;
    return {
      ...result,
      editorFallback: true,
      editorFallbackReason: source.fallbackReason,
    };
  }

  async readFile(filePath, options = {}) {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    const absolute = this.agent.resolveWorkspacePath(filePath, root);
    if (!absolute)
      return {
        success: false,
        error: { code: "INVALID_PATH", message: "Chemin hors du workspace." },
      };
    if (/\.asar$/i.test(absolute))
      return {
        success: false,
        error: {
          code: "BINARY_FILE",
          message: "Les archives ASAR sont des fichiers opaques.",
        },
      };
    const openFile = this.agent.editor?.tabManager?.getFileByPath?.(absolute);
    const source = await this.resolveReadSource(absolute, openFile);
    const openFileContent = source.kind === "editor" ? source.content : null;
    const currentContent = source.content;
    if (typeof currentContent !== "string") {
      return {
        success: false,
        error: {
          code: "FILE_READ_FAILED",
          message: source.fallbackReason
            ? `Impossible de lire le fichier depuis l'éditeur (${source.fallbackReason}) ou le filesystem: ${filePath}`
            : `Impossible de lire le fichier depuis le filesystem: ${filePath}`,
        },
        ...(source.fallbackReason
          ? {
              editorFallback: true,
              editorFallbackReason: source.fallbackReason,
            }
          : {}),
      };
    }
    const requestedRange = this.agent.fileKnowledge.normalizeRange(
      options.startLine,
      options.endLine,
    );
    const readDecision = this.agent.fileKnowledge.checkRead(
      absolute,
      requestedRange.startLine,
      requestedRange.endLine,
      {
        toolName: "read_file",
        startColumn: Number.isInteger(options.startColumn)
          ? Math.max(0, options.startColumn)
          : 0,
        currentRevision: this.agent.getContentRevision(currentContent),
      },
    );
    if (readDecision.alreadyKnown) {
      if (readDecision.cachedContext) {
        this.agent.restoreFileReadContext(
          absolute,
          readDecision.cachedContext,
          readDecision.entry.revision,
          "runtime-cache",
        );
      }
      const restored = readDecision.result;
      const nextLine = restored?.nextStartLine;
      const readLimit =
        this.agent.toolLimits?.read_file?.outputCharacters || 4000;
      const remainingBudget = readLimit - (restored?.content?.length || 0) - 1;
      if (
        restored?.restoredFromCache === true &&
        !restored.partialSegment &&
        Number.isInteger(nextLine) &&
        nextLine <= requestedRange.endLine &&
        remainingBudget > 0 &&
        !readDecision.entry?.contentLines?.has(nextLine)
      ) {
        const visible = this.agent.fileKnowledge.modelVisibleFiles.get(
          AgentPath.normalize(absolute),
        );
        const alreadyVisible =
          visible?.revision === restored.revision &&
          visible.ranges?.some(
            (range) => range.startLine <= nextLine && range.endLine >= nextLine,
          );
        if (!alreadyVisible) {
          const continuationContent = currentContent;
          if (typeof continuationContent === "string") {
            const revision = this.agent.getContentRevision(continuationContent);
            if (revision !== restored.revision) {
              this.agent.fileKnowledge.invalidateFile(
                absolute,
                revision,
                "new_revision",
              );
              return this.readFile(filePath, options);
            }
            const lines = continuationContent.split(/\r?\n/);
            const fresh = [];
            let chars = 0;
            for (
              let line = nextLine;
              line <= Math.min(requestedRange.endLine, lines.length);
              line++
            ) {
              if (
                readDecision.entry?.contentLines?.has(line) ||
                (visible?.revision === revision &&
                  visible.ranges?.some(
                    (range) => range.startLine <= line && range.endLine >= line,
                  ))
              )
                break;
              const value = lines[line - 1];
              const required = value.length + (fresh.length ? 1 : 0);
              if (chars + required > remainingBudget) break;
              fresh.push(value);
              chars += required;
            }
            if (fresh.length) {
              const end = nextLine + fresh.length - 1;
              const added = fresh.join("\n");
              this.agent.fileKnowledge.recordRead(absolute, {
                revision,
                toolName: "read_file",
                startLine: nextLine,
                endLine: end,
                requestedStartLine: requestedRange.startLine,
                requestedEndLine: requestedRange.endLine,
                knowledgeEndLine: end,
                totalLines: lines.length,
                content: added,
                diskRead: typeof openFileContent !== "string",
              });
              return this.withReadSourceMetadata(
                {
                  ...restored,
                  readDecision: "RESTORED_AND_NEW",
                  informationGain: "PARTIAL_NEW_CONTENT",
                  content: `${restored.content}\n${added}`,
                  contentEndLine: end,
                  endLine: end,
                  completeLineRange: {
                    startLine: restored.contentStartLine,
                    endLine: end,
                  },
                  deliveredRange: {
                    startLine: restored.contentStartLine,
                    endLine: end,
                  },
                  nextStartLine:
                    end < requestedRange.endLine && end < lines.length
                      ? end + 1
                      : null,
                  hasMore: end < requestedRange.endLine,
                  informationSource:
                    typeof openFileContent === "string"
                      ? "runtime_cache+editor"
                      : "runtime_cache+filesystem",
                },
                source,
              );
            }
          }
        }
      }
      return this.withReadSourceMetadata(restored, source);
    }

    const informationSource =
      source.kind === "editor" ? "editor" : "filesystem";
    const content = currentContent;
    if (typeof content === "string") {
      this.agent.fileKnowledge.setTransientSource(
        absolute,
        this.agent.getContentRevision(content),
        content,
      );
      const contentLines = content.split(/\r?\n/);
      const totalLines = contentLines.length;
      const effectiveReadRange = readDecision.range || requestedRange;
      const startLine = effectiveReadRange.startLine;
      const endLine = Math.min(effectiveReadRange.endLine, totalLines);
      const startColumn = Number.isInteger(options.startColumn)
        ? Math.max(0, readDecision.range?.startColumn ?? options.startColumn)
        : 0;
      const firstLine = contentLines[startLine - 1] || "";
      if (startColumn > firstLine.length) {
        return {
          success: false,
          error: {
            code: "INVALID_RANGE",
            message: "startColumn dépasse la ligne demandée.",
          },
        };
      }
      if (startColumn === firstLine.length) {
        if (startLine < endLine) {
          return this.readFile(filePath, {
            ...options,
            startLine: startLine + 1,
            startColumn: 0,
          });
        }
        return {
          success: true,
          readDecision: "NEW",
          path: filePath,
          requestedStartLine: requestedRange.startLine,
          requestedEndLine: requestedRange.endLine,
          requestedStartColumn: startColumn,
          requestedRange: { ...requestedRange, startColumn },
          deliveredRange: null,
          startLine,
          endLine: startLine,
          contentStartLine: startLine,
          contentEndLine: startLine,
          completeLineRange: null,
          totalLines,
          revision: this.agent.getContentRevision(content),
          informationSource,
          ...(source.fallbackReason
            ? {
                editorFallback: true,
                editorFallbackReason: source.fallbackReason,
              }
            : {}),
          truncated: false,
          hasMore: false,
          nextStartLine: null,
          nextStartColumn: null,
          content: "",
        };
      }
      if (
        startColumn > 0 ||
        firstLine.length - startColumn >
          (this.agent.toolLimits?.read_file?.outputCharacters || 4000)
      ) {
        const readLimit =
          this.agent.toolLimits?.read_file?.outputCharacters || 4000;
        const visible = firstLine.slice(startColumn, startColumn + readLimit);
        const endColumn = startColumn + visible.length;
        const truncated = endColumn < firstLine.length;
        const revision = this.agent.getContentRevision(content);
        this.agent.fileKnowledge.recordPartialSegment(absolute, {
          revision,
          toolName: "read_file",
          line: startLine,
          startColumn,
          endColumn,
          lineLength: firstLine.length,
          content: visible,
          totalLines,
          requestedStartLine: requestedRange.startLine,
          requestedEndLine: requestedRange.endLine,
          diskRead: typeof openFileContent !== "string",
        });
        return {
          success: true,
          readDecision: "NEW",
          informationGain: "PARTIAL_NEW_CONTENT",
          path: filePath,
          requestedStartLine: requestedRange.startLine,
          requestedEndLine: requestedRange.endLine,
          requestedStartColumn: startColumn,
          requestedRange: { ...requestedRange, startColumn },
          deliveredRange: {
            startLine,
            endLine: startLine,
            startColumn,
            endColumn,
          },
          startLine,
          endLine: startLine,
          contentStartLine: startLine,
          contentStartColumn: startColumn,
          contentEndLine: startLine,
          contentEndColumn: endColumn,
          completeLineRange: null,
          partialSegment: {
            line: startLine,
            startColumn,
            endColumn,
            lineLength: firstLine.length,
          },
          lineTruncated: true,
          totalLines,
          revision,
          informationSource,
          ...(source.fallbackReason
            ? {
                editorFallback: true,
                editorFallbackReason: source.fallbackReason,
              }
            : {}),
          truncated,
          hasMore: truncated || startLine < endLine,
          nextStartLine: truncated
            ? startLine
            : startLine < endLine
              ? startLine + 1
              : null,
          nextStartColumn: truncated ? endColumn : null,
          content: visible,
        };
      }
      const readContext = this.agent.createFileReadContext(
        absolute,
        content,
        startLine,
        endLine,
        "read_file",
      );
      this.agent.fileKnowledge.recordRead(absolute, {
        revision: readContext.revision,
        toolName: "read_file",
        startLine,
        endLine,
        requestedStartLine: requestedRange.startLine,
        requestedEndLine: requestedRange.endLine,
        totalLines,
        diskRead: typeof openFileContent !== "string",
        truncated: readContext.truncated,
        knowledgeEndLine: readContext.knowledgeEndLine,
        content: readContext.cacheContent,
      });
      return {
        success: true,
        readDecision: "NEW",
        informationGain:
          readDecision.informationGain === "PARTIAL_NEW_CONTENT"
            ? "PARTIAL_NEW_CONTENT"
            : "NEW_CONTENT",
        path: filePath,
        requestedStartLine: requestedRange.startLine,
        requestedEndLine: requestedRange.endLine,
        requestedRange,
        deliveredRange: {
          startLine,
          endLine: readContext.knowledgeEndLine ?? startLine,
        },
        startLine,
        endLine: readContext.knowledgeEndLine ?? startLine,
        contentStartLine: startLine,
        completeLineRange: readContext.knowledgeEndLine
          ? { startLine, endLine: readContext.knowledgeEndLine }
          : null,
        totalLines,
        revision: readContext.revision,
        contentEndLine: readContext.knowledgeEndLine,
        informationSource,
        ...(source.fallbackReason
          ? {
              editorFallback: true,
              editorFallbackReason: source.fallbackReason,
            }
          : {}),
        truncated:
          readContext.truncated ||
          (readContext.knowledgeEndLine ?? startLine) < totalLines,
        hasMore: (readContext.knowledgeEndLine ?? startLine) < endLine,
        nextStartLine:
          (readContext.knowledgeEndLine ?? startLine) < endLine
            ? (readContext.knowledgeEndLine ?? startLine) + 1
            : null,
        nextStartColumn:
          (readContext.knowledgeEndLine ?? startLine) < endLine ? 0 : null,
        content: readContext.content,
      };
    }
    return {
      success: false,
      error: {
        code: "FILE_READ_FAILED",
        message: `Impossible de lire le fichier: ${filePath}`,
      },
    };
  }

  async listProjectFiles(path = "") {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    if (!root) return { success: false, error: "Pas de projet ouvert." };
    const target = path ? this.agent.resolveWorkspacePath(path, root) : root;
    if (!target)
      return {
        success: false,
        error: { code: "INVALID_PATH", message: "Chemin hors du workspace." },
      };
    const cacheDecision =
      this.agent.fileKnowledge.getProjectListDecision(target);
    if (cacheDecision.cached) return cacheDecision.result;
    const files = await this.agent.api?.getFolderContent?.(target);
    if (Array.isArray(files)) {
      const result = {
        success: true,
        path,
        total: files.length,
        files: files.slice(0, 200).map((item) => ({
          name: item.name,
          type: item.type,
          path: this.agent.toProjectRelativePath(item.path, root),
        })),
      };
      this.agent.fileKnowledge.recordProjectList(cacheDecision.key, result);
      return result;
    }
    return { success: false, error: "Impossible de lire le dossier." };
  }

  resolveWorkspacePath(filePath, rootPath) {
    if (typeof filePath !== "string" || typeof rootPath !== "string")
      return null;

    const root = AgentPath.normalize(rootPath);
    const candidate = AgentPath.isAbsolute(filePath)
      ? AgentPath.normalize(filePath)
      : AgentPath.normalize(`${root}/${filePath}`);
    const relative = AgentPath.relative(root, candidate);

    if (!relative || relative === ".") return candidate;
    if (relative.startsWith("..") || AgentPath.isAbsolute(relative))
      return null;
    return candidate;
  }
}

window.WorkspaceFileManager = WorkspaceFileManager;
