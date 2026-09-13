class EditorToolRegistry {
  constructor(agent) {
    this.agent = agent;
  }

  getCreateFileToolDescription() {
    const safeLimit = this.agent.largeFileWriting.recommendedChunkCharacters;
    const hardLimit = this.agent.largeFileWriting.maxChunkCharacters;
    return `Crée un fichier petit ou moyen. Garde le contenu initial <= ${safeLimit} caractères (limite runtime absolue : ${hardLimit}) afin de laisser une marge à l'échappement JSON. Pour un gros fichier, crée le fichier vide ou avec une première portion sûre, puis continue avec write_file_chunk. Ne réessaie jamais la même création monolithique si elle est tronquée ou rejetée. Utilise modify_file si le fichier existe déjà.`;
  }

  getWriteFileChunkToolDescription() {
    const safeLimit = this.agent.largeFileWriting.recommendedChunkCharacters;
    const hardLimit = this.agent.largeFileWriting.maxChunkCharacters;
    return `Ajoute exactement la prochaine portion à la fin d'un gros fichier. Garde content <= ${safeLimit} caractères (limite runtime absolue : ${hardLimit}) et passe la dernière revision dans expectedRevision. Chaque succès retourne la revision requise par le chunk suivant. Après le dernier chunk, valide avec read_file.`;
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
      writeFileChunk.description = this.agent.getWriteFileChunkToolDescription();
      if (writeFileChunk.parameters?.properties?.content) {
        writeFileChunk.parameters.properties.content.maxLength =
          maxChunkCharacters;
      }
    }
  }

  registerEditorTools() {
    this.agent.registerTool("task_complete", {
      description:
        "Indique explicitement que la tâche est terminée après implémentation et validation raisonnable. Ne l'appelle pas tant qu'un travail requis ou un échec de validation connu reste non résolu.",
      readOnly: true,
      codeOnly: true,
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            maxLength: 2000,
            description: "Résumé concis du travail réellement terminé.",
          },
          validation: {
            type: "string",
            maxLength: 2000,
            description:
              "Vérifications effectuées et éventuelles limites de validation.",
          },
        },
      },
      execute: (args) => ({
        success: true,
        taskCompleteRequested: true,
        summary: typeof args.summary === "string" ? args.summary.trim() : "",
        validation:
          typeof args.validation === "string" ? args.validation.trim() : "",
      }),
    });
    this.agent.registerTool("create_file", {
      description: this.agent.getCreateFileToolDescription(),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description: "Chemin du nouveau fichier relatif au workspace.",
          },
          content: {
            type: "string",
            maxLength: this.agent.largeFileWriting.maxChunkCharacters,
            description:
              `Contenu complet d'un petit/moyen fichier, ou première portion d'un gros fichier. Cible sûre : <= ${this.agent.largeFileWriting.recommendedChunkCharacters} caractères. Vide par défaut.`,
          },
          overwrite: {
            type: "boolean",
            description:
              "Écrase explicitement un fichier existant. false par défaut; préfère modify_file pour un fichier existant.",
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
            maxLength: 4000,
            description: "Chemin du fichier existant relatif au workspace.",
          },
          content: {
            type: "string",
            minLength: 1,
            maxLength: this.agent.largeFileWriting.maxChunkCharacters,
            description:
              `Nouvelle portion à ajouter exactement à la fin du fichier. Cible sûre : <= ${this.agent.largeFileWriting.recommendedChunkCharacters} caractères.`,
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
            maxLength: 4000,
            description: "Chemin actuel du fichier dans le workspace.",
          },
          newPath: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description:
              "Nouveau chemin du fichier dans le workspace. Le dossier parent doit exister.",
          },
        },
        required: ["path", "newPath"],
      },
      execute: (args) => this.agent.renameWorkspaceFile(args),
    });
    this.agent.registerTool("modify_file", {
      description:
        "Modifie exactement une occurrence dans un fichier du workspace. Lis d'abord la zone ciblée avec read_file et fournis sa revision; les écritures obsolètes ou ambiguës sont refusées.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
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
        required: ["path", "oldText", "newText"],
      },
      execute: (args) => this.agent.modifyFile(args),
    });
    this.agent.registerTool("read_file", {
      description:
        "Lit une plage de lignes d'un fichier du workspace et retourne sa revision.",
      readOnly: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
        required: ["path"],
      },
      execute: (args) => this.agent.readFile(args.path, args),
    });
    this.agent.registerTool("get_project_map", {
      description:
        "Retourne une carte compacte du workspace avec fichiers, langages et nombres de lignes.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            maxLength: 4000,
            description:
              "Sous-dossier relatif au workspace. La racine du projet est utilisée par défaut.",
          },
          maxDepth: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            description: "Profondeur maximale de l'arborescence. 6 par défaut.",
          },
        },
      },
      readOnly: true,
      execute: (args) => this.agent.getProjectMap(args),
    });
    this.agent.registerTool("search_code", {
      description: "Recherche du texte dans les fichiers du workspace.",
      readOnly: true,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 500 },
          offset: { type: "integer", minimum: 0, maximum: 100000 },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["query"],
      },
      execute: (args) => this.agent.searchProjectFiles(args),
    });
  }

}

window.EditorToolRegistry = EditorToolRegistry;
