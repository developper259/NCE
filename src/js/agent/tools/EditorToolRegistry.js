class EditorToolRegistry {
  constructor(agent) {
    this.agent = agent;
  }

  getLimit(name, field, fallback) {
    return this.agent.toolLimits?.[name]?.[field] ?? fallback;
  }

  getPathLimit() {
    return this.agent.toolLimits?.common?.pathCharacters || 4000;
  }

  getCreateFileToolDescription() {
    const safeLimit = this.agent.largeFileWriting.recommendedChunkCharacters;
    const hardLimit = this.agent.largeFileWriting.maxChunkCharacters;
    return `Crée un fichier petit ou moyen. Cible recommandée <= ${safeLimit} caractères ; limite technique absolue ${hardLimit}. Pour un gros fichier, crée le fichier vide ou avec une première portion sûre, puis continue avec write_file_chunk. Une cible de recovery indiquée par NCE est une recommandation de taille, jamais une nouvelle limite technique. Ne réessaie jamais la même création monolithique si elle est tronquée ou rejetée. Utilise modify_file si le fichier existe déjà.`;
  }

  getWriteFileChunkToolDescription() {
    const safeLimit = this.agent.largeFileWriting.recommendedChunkCharacters;
    const hardLimit = this.agent.largeFileWriting.maxChunkCharacters;
    return `Ajoute exactement la prochaine portion à la fin d'un gros fichier. Limite recommandée <= ${safeLimit} caractères ; limite runtime absolue ${hardLimit}. Le recoveryTarget indiqué par NCE peut être plus petit. expectedRevision est obligatoire : utilise la revision retournée par le chunk précédent. Après le dernier chunk, valide avec read_file.`;
  }

  updateLargeFileToolDefinitions() {
    const maxChunkCharacters = this.agent.largeFileWriting.maxChunkCharacters;
    const createFile = this.agent.getTool("create_file");
    if (createFile) {
      createFile.description = this.agent.getCreateFileToolDescription();
      if (createFile.parameters?.properties?.content) {
        createFile.parameters.properties.content.maxLength = maxChunkCharacters;
      }
    }
    const writeFileChunk = this.agent.getTool("write_file_chunk");
    if (writeFileChunk) {
      writeFileChunk.description =
        this.agent.getWriteFileChunkToolDescription();
      if (writeFileChunk.parameters?.properties?.content) {
        writeFileChunk.parameters.properties.content.maxLength =
          maxChunkCharacters;
      }
    }
  }

  registerEditorTools() {
    this.agent.registerTool("run_tests", {
      description: `Détecte et exécute uniquement un environnement de test déjà présent dans le workspace, sans installer de dépendance ni exécuter de commande arbitraire. Sans path, valide le projet; avec un dossier, valide ce projet; avec un fichier JS/Python/PHP explicite, exécute un contrôle standalone avec le runtime disponible. Sans environnement, retourne NO_TEST_ENVIRONMENT et une guidance pour create_file puis run_tests(path). Sortie <= ${this.getLimit("run_tests", "outputCharacters", 12000)} caractères ; timeout <= ${this.getLimit("run_tests", "timeoutMs", 120000)} ms. Un résultat FAILED est une validation exécutée et doit être corrigé avant task_complete.`,
      readOnly: true,
      serializesWithMutations: true,
      executesCode: true,
      mayMutateWorkspace: true,
      codeOnly: true,
      capabilities: ["command_execution"],
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            maxLength: this.getPathLimit(),
            description:
              "Fichier de validation explicite (standalone), dossier de projet, ou sous-dossier du workspace dans lequel lancer les tests.",
          },
        },
      },
      execute: (args = {}) => this.agent.runTests(args),
    });
    this.agent.registerTool("task_complete", {
      description: `Termine la tâche après implémentation et validation. summary <= ${this.getLimit("task_complete", "summaryCharacters", 2000)} ; validation <= ${this.getLimit("task_complete", "validationCharacters", 2000)}. Ne l'appelle pas si un travail requis ou un échec reste non résolu.`,
      readOnly: true,
      codeOnly: true,
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            maxLength: this.getLimit(
              "task_complete",
              "summaryCharacters",
              2000,
            ),
            description: "Résumé concis du travail réellement terminé.",
          },
          validation: {
            type: "string",
            maxLength: this.getLimit(
              "task_complete",
              "validationCharacters",
              2000,
            ),
            description:
              "Vérifications effectuées et éventuelles limites de validation.",
          },
        },
      },
      execute: (args = {}) => {
        return {
          success: true,
          taskCompleteRequested: true,
          summary: typeof args.summary === "string" ? args.summary.trim() : "",
          validation:
            typeof args.validation === "string" ? args.validation.trim() : "",
          changedFiles:
            this.agent.runChangeTracker?.current?.changes?.size ?? 0,
        };
      },
    });
    this.agent.registerTool("get_changed_files", {
      description:
        "Retourne la liste compacte des fichiers affectés, sans leur contenu. Utilise get_diff pour la review.",
      readOnly: true,
      codeOnly: true,
      parameters: { type: "object", properties: {} },
      execute: (args = {}) => {
        const result = this.agent.getChangedFiles(args);
        if (result?.success !== false) {
          this.agent.runChangeTracker?.markReviewChangedFiles?.();
        }
        return result;
      },
    });
    this.agent.registerTool("get_diff", {
      description: `Retourne le diff local, éventuellement filtré par path. Sortie <= ${this.getLimit("get_diff", "outputCharacters", 12000)} caractères ; si le diff global est tronqué, utilise get_diff(path).`,
      readOnly: true,
      codeOnly: true,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            maxLength: this.getPathLimit(),
          },
        },
      },
      execute: (args = {}) => {
        const result = this.agent.getDiff(args);
        if (result?.success !== false) {
          const tracker = this.agent.runChangeTracker;
          tracker?.markReviewDiff?.(args?.path, result);
          result.unreviewedPaths = tracker?.getUnreviewedPaths?.() || [];
          result.reviewComplete = result.unreviewedPaths.length === 0;
          if (!args?.path && result.truncated) {
            result.reviewInstruction =
              "The global diff was truncated. Review the remaining changed files with get_diff({ path }) before task_complete.";
          }
        }
        return result;
      },
    });
    this.agent.registerTool("create_file", {
      description: this.agent.getCreateFileToolDescription(),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            maxLength: this.getPathLimit(),
            description: "Chemin du nouveau fichier relatif au workspace.",
          },
          content: {
            type: "string",
            maxLength: this.agent.largeFileWriting.maxChunkCharacters,
            description: `Contenu complet d'un petit/moyen fichier, ou première portion d'un gros fichier. Cible sûre : <= ${this.agent.largeFileWriting.recommendedChunkCharacters} caractères. Vide par défaut.`,
          },
          overwrite: {
            type: "boolean",
            description:
              "Écrase explicitement un fichier existant. false par défaut; préfère modify_file pour un fichier existant.",
          },
          revision: {
            type: "string",
            minLength: 1,
            description:
              "Revision actuelle obligatoire uniquement avec overwrite=true sur un fichier existant.",
          },
        },
        required: ["path"],
      },
      execute: (args) => this.agent.createWorkspaceFile(args),
    });
    this.agent.registerTool("write_file_chunk", {
      description: this.agent.getWriteFileChunkToolDescription(),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            maxLength: this.getPathLimit(),
            description: "Chemin du fichier existant relatif au workspace.",
          },
          content: {
            type: "string",
            minLength: 1,
            maxLength: this.agent.largeFileWriting.maxChunkCharacters,
            description: `Nouvelle portion à ajouter exactement à la fin du fichier. Cible sûre : <= ${this.agent.largeFileWriting.recommendedChunkCharacters} caractères.`,
          },
          expectedRevision: {
            type: "string",
            minLength: 1,
            description:
              "Révision retournée par create_file ou par le write_file_chunk précédent.",
          },
        },
        required: ["path", "content", "expectedRevision"],
      },
      execute: (args) => this.agent.writeWorkspaceFileChunk(args),
    });
    this.agent.registerTool("rename_file", {
      description:
        "Renomme ou déplace un fichier existant dans le workspace. Si le fichier est importé ailleurs, recherche ses références et mets à jour les chemins concernés.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            maxLength: this.getPathLimit(),
            description: "Chemin actuel du fichier dans le workspace.",
          },
          newPath: {
            type: "string",
            minLength: 1,
            maxLength: this.getPathLimit(),
            description:
              "Nouveau chemin du fichier dans le workspace. Le dossier parent doit exister.",
          },
        },
        required: ["path", "newPath"],
      },
      execute: (args) => this.agent.renameWorkspaceFile(args),
    });
    this.agent.registerTool("delete_file", {
      description:
        "Supprime un fichier existant du workspace uniquement lorsque sa disparition est requise. Les dossiers, fichiers dirty et chemins dangereux sont refusés.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            maxLength: this.getPathLimit(),
            description: "Chemin du fichier à supprimer, relatif au workspace.",
          },
        },
        required: ["path"],
      },
      execute: (args) => this.agent.deleteWorkspaceFile(args),
    });
    this.agent.registerTool("create_folder", {
      description: "Crée un dossier dans le workspace. Le parent doit exister.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            maxLength: this.getPathLimit(),
          },
        },
        required: ["path"],
      },
      execute: (args) => this.agent.createWorkspaceFolder(args),
    });
    this.agent.registerTool("delete_folder", {
      description: "Supprime un dossier et son contenu du workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            maxLength: this.getPathLimit(),
          },
        },
        required: ["path"],
      },
      execute: (args) => this.agent.deleteWorkspaceFolder(args),
    });
    this.agent.registerTool("modify_file", {
      description: `Remplace une occurrence à la revision fournie. path <= ${this.getPathLimit()} caractères ; oldText/newText n'ont pas de maxLength artificiel. Pour une grosse modification, préfère plusieurs edits ciblés.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            maxLength: this.getPathLimit(),
            description:
              "Chemin du fichier à modifier, relatif au workspace ou absolu.",
          },
          oldText: {
            type: "string",
            description: "Texte exact à remplacer dans le fichier cible.",
          },
          newText: {
            type: "string",
            description: "Nouveau texte exact à enregistrer.",
          },
          nearLine: {
            type: "integer",
            minimum: 1,
            description:
              "Numéro de ligne approximatif 1-based. Sert uniquement à choisir une occurrence en cas d'ambiguïté.",
          },
          revision: {
            type: "string",
            description:
              "Révision retournée par read_file. Le write est refusé si le fichier a changé depuis cette lecture.",
          },
        },
        required: ["path", "revision", "oldText", "newText"],
      },
      execute: (args) => this.agent.modifyFile(args),
    });
    this.agent.registerTool("read_file", {
      description: `Lit <= ${this.getLimit("read_file", "outputCharacters", 4000)} caractères. startLine/endLine sont 1-based, startColumn 0-based. Suivez nextStartLine + nextStartColumn, y compris pour continuer une longue ligne. Une plage visible n'est pas renvoyée ; une demande partiellement visible est réduite à sa partie manquante.`,
      readOnly: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", maxLength: this.getPathLimit() },
          startLine: { type: "integer", minimum: 1 },
          startColumn: {
            type: "integer",
            minimum: 0,
            description:
              "Colonne 0-based utilisée pour continuer une ligne tronquée.",
          },
          endLine: { type: "integer", minimum: 1 },
        },
        required: ["path"],
      },
      execute: (args) => this.agent.readFile(args.path, args),
    });
    this.agent.registerTool("get_project_map", {
      description: `Carte compacte du workspace. maxDepth <= ${this.getLimit("get_project_map", "maxDepth", 20)}, sortie <= ${this.getLimit("get_project_map", "outputCharacters", 4000)} caractères ; réduis path/profondeur si nécessaire.`,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            maxLength: this.getPathLimit(),
            description:
              "Sous-dossier relatif au workspace. La racine du projet est utilisée par défaut.",
          },
          maxDepth: {
            type: "integer",
            minimum: 1,
            maximum: this.getLimit("get_project_map", "maxDepth", 20),
            description: "Profondeur maximale de l'arborescence. 6 par défaut.",
          },
        },
      },
      readOnly: true,
      execute: (args) => this.agent.getProjectMap(args),
    });
    this.agent.registerTool("search_code", {
      description: `Recherche workspace : query <= ${this.getLimit("search_code", "queryCharacters", 500)}, limit <= ${this.getLimit("search_code", "maxResults", 100)}, offset <= ${this.getLimit("search_code", "maxOffset", 100000)}, sortie <= ${this.getLimit("search_code", "outputCharacters", 4000)}. Utilise nextOffset si tronqué.`,
      readOnly: true,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: this.getLimit("search_code", "queryCharacters", 500),
          },
          offset: {
            type: "integer",
            minimum: 0,
            maximum: this.getLimit("search_code", "maxOffset", 100000),
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: this.getLimit("search_code", "maxResults", 100),
          },
        },
        required: ["query"],
      },
      execute: (args) => this.agent.searchProjectFiles(args),
    });
  }
}

window.EditorToolRegistry = EditorToolRegistry;
