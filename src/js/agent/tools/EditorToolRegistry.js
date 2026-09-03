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
    this.agent.registerTool("get_editor_context", {
      description: "Obtenir le contexte minimal de l'éditeur.",
      readOnly: true,
      execute: () => this.agent.buildEditorContext(),
    });
    this.agent.registerTool("get_cursor", {
      description: "Obtenir la position du curseur.",
      readOnly: true,
      execute: () => ({
        available: Boolean(this.agent.editor?.cursorController),
        position: this.agent.editor?.cursorController
          ? {
              row: this.agent.editor.cursorController.row ?? 1,
              column: this.agent.editor.cursorController.column ?? 0,
            }
          : null,
      }),
    });
    this.agent.registerTool("read_selection", {
      description: "Lire la sélection actuelle.",
      readOnly: true,
      execute: () => this.agent.readSelection(),
    });
    this.agent.registerTool("read_active_file", {
      description: "Lire une portion du fichier actif.",
      readOnly: true,
      parameters: {
        type: "object",
        properties: {
          startLine: { type: "integer" },
          endLine: { type: "integer" },
        },
      },
      execute: (args) => this.agent.readActiveFile(args),
    });
    this.agent.registerTool("search_active_file", {
      description: "Rechercher dans le fichier actif.",
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
      execute: (args) => this.agent.searchActiveFile(args),
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
      description: `
Modifier un fichier du workspace, même s'il n'est pas actif.

Règles de sécurité :
- Le chemin peut être relatif au projet ou absolu.
- Le fichier doit rester dans le workspace ouvert.
- Utilise cet outil pour toute modification, y compris celle du fichier actif.
- oldText doit correspondre à une seule occurrence exacte; sinon la modification est refusée.
- Copie oldText depuis le dernier résultat read_file et choisis un fragment minimal mais unique.
- Une lecture récente de la zone contenant oldText est obligatoire; sinon FILE_CONTEXT_REQUIRED est retourné.
- Ne copie jamais le marqueur de troncature ajouté par NCE dans oldText.
- Les différences CRLF/LF sont normalisées automatiquement, mais aucun autre écart de contenu n'est accepté.
- N'envoie pas de coordonnées : NCE calcule les positions automatiquement.
- Après modification, la commande retourne le chemin relatif et les contenus avant/après.
`,
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
          text: {
            type: "string",
            description: "Alias de newText pour compatibilité.",
          },
        },
        required: ["path", "oldText", "newText"],
      },
      execute: (args) => this.agent.modifyFile(args),
    });
    this.agent.registerTool("modify_active_file", {
      description: `
Modifier précisément une plage du fichier actif.

IMPORTANT :
- Les lignes sont numérotées à partir de 1.
- Les colonnes sont numérotées à partir de 0.
- column 0 correspond au premier caractère de la ligne.
- Une colonne égale à la longueur de la ligne correspond à la fin de la ligne.
- La plage [startLine:startColumn, endLine:endColumn] est remplacée par text.
- start et end sont inclusifs/exclusifs comme une plage JavaScript : le caractère à endColumn n'est PAS remplacé.
- Pour remplacer toute une ligne, utilise startColumn=0 et endColumn=longueur exacte de la ligne.
- Pour INSÉRER du texte sans supprimer de texte, start et end doivent être exactement identiques.
- Pour supprimer du texte, utilise text="".
- Ne devine jamais les coordonnées : lis d'abord le contenu actuel avec read_active_file.
- Après une lecture, utilise exactement les numéros de lignes et colonnes correspondant au contenu lu.
- expectedText doit contenir exactement le texte actuellement présent dans la plage.
- expectedText doit normalement inclure les espaces et tabulations au début de ligne ; si startColumn=0 et qu'il les omet, ils sont conservés automatiquement.
- Si expectedText ne correspond pas, le remplacement sera refusé.
- Pour une modification normale, fournis oldText et newText : les coordonnées seront calculées automatiquement.
- N'envoie jamais une plage partielle ou des valeurs undefined : utilise soit oldText/newText, soit les quatre coordonnées startLine, startColumn, endLine et endColumn.
`,
      parameters: {
        type: "object",
        properties: {
          oldText: {
            type: "string",
            description:
              "Texte exact à remplacer. Une seule occurrence doit exister.",
          },
          newText: {
            type: "string",
            description: "Nouveau texte exact qui remplacera oldText.",
          },
          startLine: {
            type: "integer",
            minimum: 1,
            description: "Numéro de ligne 1-based.",
          },

          startColumn: {
            type: "integer",
            minimum: 0,
            description: "Colonne 0-based. 0 = début de ligne.",
          },

          endLine: {
            type: "integer",
            minimum: 1,
            description: "Numéro de ligne 1-based.",
          },

          endColumn: {
            type: "integer",
            minimum: 0,
            description:
              "Colonne 0-based et exclusive. Une valeur égale à la longueur de la ligne signifie la fin de la ligne.",
          },

          expectedText: {
            type: "string",
            description:
              "Contenu exact attendu dans la plage avant le remplacement.",
          },

          text: {
            type: "string",
            description:
              "Texte de remplacement, conservé pour compatibilité si newText n'est pas fourni.",
          },
        },
      },
      execute: (args) => this.agent.modifyActiveFile(args),
    });
    this.agent.registerTool("replace_text", {
      description:
        "Remplacer une seule occurrence exacte dans le fichier actif. Préférer cet outil pour les modifications simples.",
      parameters: {
        type: "object",
        properties: {
          oldText: { type: "string", description: "Texte exact à remplacer." },
          newText: { type: "string", description: "Nouveau texte." },
        },
        required: ["oldText", "newText"],
      },
      execute: (args) => this.agent.replaceText(args),
    });
    this.agent.registerTool("read_file", {
      description: "Lire un fichier du projet.",
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
        "Retourne une carte compacte de la structure du projet avec les fichiers, leur langage et leur nombre de lignes. Utilise ce tool pour comprendre rapidement l'organisation générale du workspace avant une exploration détaillée.",
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
    this.agent.registerTool("list_project_files", {
      description: "Lister les fichiers du projet.",
      readOnly: true,
      parameters: { type: "object", properties: { path: { type: "string" } } },
      execute: (args) => this.agent.listProjectFiles(args.path),
    });
    this.agent.registerTool("search_project_files", {
      description: "Rechercher dans le projet.",
      readOnly: true,
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      execute: (args) => this.agent.searchProjectFiles(args),
    });
  }

}

window.EditorToolRegistry = EditorToolRegistry;
