class WorkspaceFileManager {
  constructor(agent) {
    this.agent = agent;
  }

  shouldPersistAgentEdit(filePath) {
    const file =
      typeof filePath === "string"
        ? this.agent.editor?.tabManager?.getFileByPath?.(filePath)
        : null;
    if (file && typeof file.autoSave === "boolean") {
      return file.autoSave === true;
    }
    return false;
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
      const readContextValidation = this.agent.validateFileReadContext(
        target.absolutePath,
        previous,
        "",
      );
      if (!readContextValidation.valid) {
        return {
          success: false,
          error: {
            ...readContextValidation.error,
            path: target.relativePath,
          },
        };
      }
      snapshotKey = `create:${target.absolutePath}:${Date.now()}:${Math.random()}`;
      this.agent.fileSnapshots.set(snapshotKey, previous);
    }

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

    if (openFile && overwrite) {
      openFile.isLoaded = false;
      await this.agent.editor?.tabManager?.reloadFileFromDisk?.(target.absolutePath);
    }
    await this.agent.refreshWorkspaceFolders([target.parentPath]);
    const verifiedContent = (
      await this.agent.api?.getFileContent?.([target.absolutePath])
    )?.[target.absolutePath];
    if (typeof verifiedContent !== "string" || verifiedContent !== content) {
      return {
        success: false,
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
    let openedInTabManager = false;
    if (
      !exists &&
      typeof this.agent.editor?.tabManager?.openFileWithPath === "function"
    ) {
      await this.agent.editor.tabManager.openFileWithPath(target.absolutePath);
      openedInTabManager = true;
      const createdFile = this.agent.editor.tabManager.getFileByPath?.(
        target.absolutePath,
      );
      if (createdFile) {
        this.agent.markFileDiffHighlights("", verifiedContent, createdFile);
        this.agent.editor?.lineController?.markDirtyAll?.();
        this.agent.editor?.lineController?.refresh?.(true);
      }
    }
    return {
      success: true,
      operation: "create",
      path: target.relativePath,
      absolutePath: target.absolutePath,
      created: !exists,
      overwritten: Boolean(exists && overwrite),
      openedInTabManager,
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
    const currentContent = (
      await this.agent.api?.getFileContent?.([target.absolutePath])
    )?.[target.absolutePath];
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
          code: "REVISION_MISMATCH",
          message:
            "Le fichier a changé depuis le chunk précédent. Relisez-le avant de continuer.",
          path: target.relativePath,
          expectedRevision,
          actualRevision: currentRevision,
        },
      };
    }

    const updatedContent = `${currentContent}${content}`;
    const savedPath = await this.agent.api?.saveFile?.(
      target.absolutePath,
      updatedContent,
    );
    if (
      AgentPath.normalize(savedPath || "") !==
      AgentPath.normalize(target.absolutePath)
    ) {
      return {
        success: false,
        error: {
          code: "APPEND_FAILED",
          message: "La portion n'a pas pu être enregistrée.",
          path: target.relativePath,
        },
      };
    }
    const verifiedContent = (
      await this.agent.api?.getFileContent?.([target.absolutePath])
    )?.[target.absolutePath];
    if (
      typeof verifiedContent !== "string" ||
      verifiedContent !== updatedContent
    ) {
      return {
        success: false,
        error: {
          code: "APPEND_VERIFICATION_FAILED",
          message:
            "Le contenu du fichier ne correspond pas au résultat attendu après l'ajout.",
          path: target.relativePath,
        },
      };
    }

    if (openFile) {
      openFile.isLoaded = false;
      await this.agent.editor?.tabManager?.reloadFileFromDisk?.(target.absolutePath);
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
    }
    const totalLines = verifiedContent.split(/\r?\n/).length;
    const verificationContext = this.agent.createFileReadContext(
      target.absolutePath,
      verifiedContent,
      Math.max(1, totalLines - 199),
      totalLines,
      "post-chunk-verification",
    );
    return {
      success: true,
      operation: "append",
      path: target.relativePath,
      appendedChars: content.length,
      totalChars: verifiedContent.length,
      previousRevision: currentRevision,
      revision: verificationContext.revision,
      verification: {
        verified: true,
        revision: verificationContext.revision,
      },
    };
  }

  async renameWorkspaceFile(args = {}) {
    const source = this.agent.getWorkspaceFileTarget(args.path);
    if (!source.valid) return { success: false, error: source.error };
    const destination = this.agent.getWorkspaceFileTarget(args.newPath);
    if (!destination.valid) {
      return { success: false, error: destination.error };
    }
    if (
      AgentPath.normalize(source.absolutePath) ===
      AgentPath.normalize(destination.absolutePath)
    ) {
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
    await tabManager?.updateFilePath?.(
      source.absolutePath,
      destination.absolutePath,
    );
    const explorer = this.agent.editor?.fileExplorer;
    if (
      AgentPath.normalize(explorer?.activeFilePath || "") ===
      AgentPath.normalize(source.absolutePath)
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
    await this.agent.refreshWorkspaceFolders([
      source.parentPath,
      destination.parentPath,
    ]);
    const sourceStillExists = await this.agent.api?.pathExists?.(source.absolutePath);
    const destinationExists = await this.agent.api?.pathExists?.(
      destination.absolutePath,
    );
    if (sourceStillExists || !destinationExists) {
      return {
        success: false,
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
    return {
      success: true,
      operation: "rename",
      oldPath: source.relativePath,
      newPath: destination.relativePath,
      oldAbsolutePath: source.absolutePath,
      newAbsolutePath: destination.absolutePath,
      renamed: true,
      verification,
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
      : (await this.agent.api?.getFileContent?.([absolutePath]))?.[absolutePath];
    if (typeof currentText !== "string") {
      return {
        success: false,
        error: {
          code: "READ_FAILED",
          message: `Impossible de lire le fichier : ${relativePath}`,
        },
      };
    }
    const readContextValidation = this.agent.validateFileReadContext(
      absolutePath,
      currentText,
      oldText,
    );
    if (!readContextValidation.valid) {
      return {
        success: false,
        error: {
          ...readContextValidation.error,
          path: this.agent.toProjectRelativePath(absolutePath, root),
        },
      };
    }
    if (this.agent.readAfterFailurePaths.has(absolutePath)) {
      return {
        success: false,
        error: {
          code: "READ_AFTER_NO_MATCH",
          message:
            "Relisez ce fichier avec read_file avant de réessayer après NO_MATCH.",
          path: this.agent.toProjectRelativePath(absolutePath, root),
        },
      };
    }
    const currentRevision = readContextValidation.currentRevision;
    if (
      typeof args.revision === "string" &&
      args.revision !== currentRevision
    ) {
      return {
        success: false,
        error: {
          code: "STALE_CONTEXT",
          message: "Le fichier a changé depuis sa dernière lecture.",
          path: this.agent.toProjectRelativePath(absolutePath, root),
          expectedRevision: args.revision,
          actualRevision: currentRevision,
        },
      };
    }
    const replacementText = this.agent.adaptReplacementLineEndings(
      newText,
      currentText,
    );
    const editorUpdatedText = (updatedText) =>
      updatedText.replace(/\r\n?/g, "\n");

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
      if (
        AgentPath.normalize(openFile.path) !== AgentPath.normalize(absolutePath)
      ) {
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
        this.agent.markFileDiffHighlights(currentText, updatedText, openFile);
        if (this.agent.editor.lineController?.refresh) {
          this.agent.editor.lineController.refresh(true);
        }
        openFile.setIsSaved(false);
        if (persistToDisk && typeof this.agent.api?.saveFile === "function") {
          const savedPath = await this.agent.api.saveFile(absolutePath, updatedText);
          if (savedPath !== absolutePath) {
            return {
              success: false,
              error: {
                code: "SAVE_FAILED",
                message: `Le fichier n'a pas pu être sauvegardé : ${relativePath}`,
                path: relativePath,
              },
            };
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
      this.agent.executedModificationRequests.set(requestKey, result);
      return result;
    }

    const textMatch = this.agent.findUniqueTextMatch(currentText, oldText, nearLine);
    if (textMatch.status === "missing") {
      this.agent.readAfterFailurePaths.add(absolutePath);
      return {
        success: false,
        error: {
          code: "NO_MATCH",
          message:
            "Aucune occurrence trouvée pour oldText. Relisez le fichier et copiez un fragment minimal depuis le dernier résultat de read_file.",
          path: this.agent.toProjectRelativePath(absolutePath, root),
          nearLine: nearLine ?? null,
          readRequired: true,
          hint: "Relisez la zone autour de nearLine et utilisez un oldText exact.",
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
    if (
      AgentPath.normalize(openFile.path) !== AgentPath.normalize(absolutePath)
    ) {
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
      this.agent.markFileDiffHighlights(currentText, updatedText, openFile);
      if (this.agent.editor.lineController?.refresh) {
        this.agent.editor.lineController.refresh(true);
      }
      openFile.setIsSaved(false);
      if (persistToDisk && typeof this.agent.api?.saveFile === "function") {
        const savedPath = await this.agent.api.saveFile(absolutePath, updatedText);
        if (savedPath !== absolutePath) {
          return {
            success: false,
            error: {
              code: "SAVE_FAILED",
              message: `Le fichier n'a pas pu être sauvegardé : ${relativePath}`,
              path: relativePath,
            },
          };
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
    this.agent.executedModificationRequests.set(requestKey, result);
    return result;
  }

  async readFile(filePath, options = {}) {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    const absolute = this.agent.resolveWorkspacePath(filePath, root);
    if (!absolute)
      return {
        success: false,
        error: { code: "INVALID_PATH", message: "Chemin hors du workspace." },
      };
    const openFile = this.agent.editor?.tabManager?.getFileByPath?.(absolute);
    if (openFile) {
      await this.agent.editor?.fileLoader?.waitForFileLoaded?.(openFile);
    }
    const openFileContent = openFile
      ? openFile.lines.map((line) => line.getText()).join("\n")
      : null;
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
        forceRead: this.agent.readAfterFailurePaths.has(absolute),
        currentRevision:
          typeof openFileContent === "string"
            ? this.agent.getContentRevision(openFileContent)
            : null,
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
      return readDecision.result;
    }

    const content =
      typeof openFileContent === "string"
        ? openFileContent
        : (await this.agent.api?.getFileContent?.([absolute]))?.[absolute];
    if (typeof content === "string") {
      this.agent.readAfterFailurePaths.delete(absolute);
      const totalLines = content.split(/\r?\n/).length;
      const startLine = requestedRange.startLine;
      const endLine = Math.min(
        requestedRange.endLine,
        totalLines,
      );
      const readContext = this.agent.createFileReadContext(
        absolute,
        content,
        startLine,
        endLine,
        "read_file",
      );
      this.agent.fileKnowledge.recordRead(absolute, {
        revision: readContext.revision,
        startLine,
        endLine,
        totalLines,
        diskRead: typeof openFileContent !== "string",
        truncated: readContext.truncated,
        knowledgeEndLine: readContext.knowledgeEndLine,
        content: readContext.cacheContent,
      });
      return {
        success: true,
        readDecision: "NEW",
        path: filePath,
        startLine,
        endLine,
        totalLines,
        revision: readContext.revision,
        contentEndLine: readContext.knowledgeEndLine,
        informationSource:
          typeof openFileContent === "string" ? "editor" : "filesystem",
        truncated: endLine < totalLines || readContext.truncated,
        content: readContext.content,
      };
    }
    return {
      success: false,
      error: `Impossible de lire le fichier: ${filePath}`,
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
