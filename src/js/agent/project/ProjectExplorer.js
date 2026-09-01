class ProjectExplorer {
  constructor(agent) {
    this.agent = agent;
  }

  async getProjectMap(args = {}) {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    if (!root) return { success: false, error: "Pas de projet ouvert." };
    const requestedPath = typeof args.path === "string" ? args.path.trim() : "";
    const target = requestedPath
      ? this.agent.resolveWorkspacePath(requestedPath, root)
      : AgentPath.normalize(root);
    if (!target) {
      return {
        success: false,
        error: { code: "INVALID_PATH", message: "Chemin hors du workspace." },
      };
    }
    if (typeof this.agent.api?.getProjectMap !== "function") {
      return {
        success: false,
        error: {
          code: "PROJECT_MAP_UNAVAILABLE",
          message: "Le service de carte du projet est indisponible.",
        },
      };
    }
    const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : 6;
    const map = await this.agent.api.getProjectMap(root, target, {
      maxDepth,
      maxFiles: 1000,
    });
    if (!map?.success || !Array.isArray(map.entries)) {
      return (
        map || {
          success: false,
          error: {
            code: "PROJECT_MAP_FAILED",
            message: "Impossible de construire la carte du projet.",
          },
        }
      );
    }
    const entries = await this.agent.addProjectMapLanguages(map.entries);
    const tree = this.agent.buildProjectMapTree(entries);
    const rootLabel = `${AgentPath.basename(target) || "project"}/`;
    return {
      success: true,
      root: map.root,
      files: map.files,
      directories: map.directories,
      truncated: map.truncated === true,
      maxDepth: map.maxDepth,
      maxFiles: map.maxFiles,
      tree,
      text: this.agent.formatProjectMapText(rootLabel, tree, map),
    };
  }

  async addProjectMapLanguages(entries = []) {
    const languageByExtension = new Map();
    const enriched = [];
    for (const entry of entries) {
      if (entry?.type !== "file") {
        enriched.push({ ...entry, children: [] });
        continue;
      }
      const extension = this.agent.getProjectMapExtension(entry.name);
      if (!languageByExtension.has(extension)) {
        languageByExtension.set(
          extension,
          await this.agent.detectProjectMapLanguage(entry.name, extension),
        );
      }
      enriched.push({
        name: entry.name,
        path: entry.path,
        relativePath: entry.relativePath,
        type: "file",
        language: languageByExtension.get(extension),
        lineCount: Number.isInteger(entry.lineCount) ? entry.lineCount : null,
        binary: entry.binary === true,
      });
    }
    return enriched;
  }

  getProjectMapExtension(fileName) {
    const name = typeof fileName === "string" ? fileName.toLowerCase() : "";
    const index = name.lastIndexOf(".");
    return index > 0 ? name.slice(index) : "";
  }

  async detectProjectMapLanguage(fileName, extension) {
    const specificLanguages = {
      ".jsx": "javascriptreact",
      ".tsx": "typescriptreact",
      ".cjs": "javascript",
      ".scss": "scss",
      ".md": "markdown",
      ".c": "c",
      ".h": "cpp",
      ".cpp": "cpp",
      ".cc": "cpp",
      ".cxx": "cpp",
      ".hpp": "cpp",
      ".sh": "shell",
      ".sql": "sql",
      ".rs": "rust",
      ".go": "go",
    };
    if (specificLanguages[extension]) return specificLanguages[extension];
    const detected =
      await this.agent.editor?.highlightController?.detectLanguage?.(fileName);
    const normalized =
      typeof detected === "string" ? detected.trim().toLowerCase() : "";
    return normalized && normalized !== "plaintext" ? normalized : "unknown";
  }

  buildProjectMapTree(entries = []) {
    const root = { children: [], directories: new Map() };
    for (const entry of entries) {
      const parts = String(entry.relativePath || entry.name || "")
        .split("/")
        .filter(Boolean);
      if (!parts.length) continue;
      let parent = root;
      for (let index = 0; index < parts.length; index += 1) {
        const name = parts[index];
        const isLeaf = index === parts.length - 1;
        if (isLeaf && entry.type === "file") {
          parent.children.push({ ...entry, name });
          continue;
        }
        let directory = parent.directories.get(name);
        if (!directory) {
          const directoryPath = parts.slice(0, index + 1).join("/");
          directory = {
            name,
            path:
              entry.type === "directory" && isLeaf ? entry.path : directoryPath,
            type: "directory",
            children: [],
            directories: new Map(),
          };
          parent.directories.set(name, directory);
          parent.children.push(directory);
        }
        parent = directory;
      }
    }
    const stripIndexes = (nodes) =>
      nodes.map((node) =>
        node.type === "directory"
          ? {
              name: node.name,
              path: node.path,
              type: "directory",
              children: stripIndexes(node.children),
            }
          : node,
      );
    return stripIndexes(root.children);
  }

  formatProjectMapText(rootLabel, tree, map = {}) {
    const lines = [rootLabel];
    const append = (nodes, prefix = "") => {
      nodes.forEach((node, index) => {
        const last = index === nodes.length - 1;
        const branch = last ? "└─ " : "├─ ";
        if (node.type === "directory") {
          lines.push(`${prefix}${branch}${node.name}/`);
          append(node.children, `${prefix}${last ? "   " : "│  "}`);
          return;
        }
        const details = node.binary
          ? "binary · lines unavailable"
          : `${node.language} · ${node.lineCount === null ? "lines unavailable" : `${node.lineCount} ${node.lineCount === 1 ? "line" : "lines"}`}`;
        lines.push(`${prefix}${branch}${node.name} [${details}]`);
      });
    };
    append(tree);
    if (map.truncated) {
      lines.push(
        `\nMap truncated after ${map.maxFiles} files or depth ${map.maxDepth}. Use path to inspect a narrower directory.`,
      );
    }
    return lines.join("\n");
  }

  async searchProjectFiles(args = {}) {
    const root = this.agent.editor?.fileExplorer?.rootPath;
    if (!root || !args.query)
      return { success: false, error: "Projet ou requête indisponible." };
    return this.agent.editor.api.searchInFiles(root, args.query, {
      ...args,
      offset: args.offset,
      limit: args.limit,
    });
  }

}

window.ProjectExplorer = ProjectExplorer;
