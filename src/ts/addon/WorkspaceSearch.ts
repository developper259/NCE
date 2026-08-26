import { ipcMain } from "electron";
import { promises as fs } from "fs";
import path from "path";
import { Window } from "../Window";

interface SearchOptions {
  include?: string;
  exclude?: string;
  caseSensitive?: boolean;
  useRegex?: boolean;
  wholeWord?: boolean;
  offset?: number;
  limit?: number;
}

interface SearchResult {
  path: string;
  relativePath: string;
  name: string;
  line: number;
  column: number;
  preview: string;
  matchStart: number;
  matchLength: number;
}

interface SearchResponse {
  results: SearchResult[];
  totalMatches: number;
  filesSearched: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

interface ProjectMapOptions {
  maxDepth?: number;
  maxFiles?: number;
}

interface ProjectMapEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
  depth: number;
  lineCount: number | null;
  binary: boolean;
}

interface ProjectMapResponse {
  success: boolean;
  root: string;
  entries: ProjectMapEntry[];
  files: number;
  directories: number;
  truncated: boolean;
  maxDepth: number;
  maxFiles: number;
  error?: { code: string; message: string };
}

export class WorkspaceSearch {
  window: Window;

  private readonly ignoredDirectories = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    "temp",
    "tmp",
    ".next",
    ".cache",
    ".turbo",
  ]);

  private readonly maxFileSize = 5 * 1024 * 1024;
  private readonly maxResults = 10000;
  private readonly binaryExtensions = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
    ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar", ".exe", ".dll",
    ".so", ".dylib", ".woff", ".woff2", ".ttf", ".otf", ".mp3",
    ".wav", ".ogg", ".mp4", ".mov", ".avi", ".webm",
  ]);

  constructor(window: Window) {
    this.window = window;
  }

  handleIPC() {
    ipcMain.handle(
      "WorkspaceSearch:search",
      async (
        _event,
        rootPath: string,
        query: string,
        options: SearchOptions = {},
      ) => {
        return await this.search(rootPath, query, options);
      },
    );
    ipcMain.handle(
      "WorkspaceSearch:projectMap",
      async (
        _event,
        rootPath: string,
        targetPath: string,
        options: ProjectMapOptions = {},
      ) => this.getProjectMap(rootPath, targetPath, options),
    );
  }

  async getProjectMap(
    rootPath: string,
    targetPath: string,
    options: ProjectMapOptions = {},
  ): Promise<ProjectMapResponse> {
    const maxDepth = Math.min(
      20,
      Math.max(1, Math.floor(options.maxDepth ?? 6)),
    );
    const maxFiles = Math.min(
      5000,
      Math.max(1, Math.floor(options.maxFiles ?? 1000)),
    );
    const root = path.resolve(rootPath || "");
    const target = path.resolve(targetPath || root);
    const empty = (code: string, message: string): ProjectMapResponse => ({
      success: false,
      root: "",
      entries: [],
      files: 0,
      directories: 0,
      truncated: false,
      maxDepth,
      maxFiles,
      error: { code, message },
    });
    if (!rootPath || !this.isPathInside(root, target)) {
      return empty("INVALID_PATH", "Le chemin doit rester dans le workspace.");
    }
    try {
      const [realRoot, realTarget] = await Promise.all([
        fs.realpath(root),
        fs.realpath(target),
      ]);
      if (!this.isPathInside(realRoot, realTarget)) {
        return empty("INVALID_PATH", "Le chemin doit rester dans le workspace.");
      }
      if (!(await fs.stat(realTarget)).isDirectory()) {
        return empty("NOT_A_DIRECTORY", "Le chemin demandé n'est pas un dossier.");
      }
    } catch {
      return empty("DIRECTORY_NOT_FOUND", "Le dossier demandé est introuvable.");
    }

    const entries: ProjectMapEntry[] = [];
    let files = 0;
    let directories = 0;
    let truncated = false;
    const walk = async (directory: string, depth: number): Promise<void> => {
      let children;
      try {
        children = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      children.sort((left, right) => {
        const typeOrder = Number(left.isFile()) - Number(right.isFile());
        if (typeOrder) return typeOrder;
        return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
      });
      for (const child of children) {
        if (files >= maxFiles) {
          truncated = true;
          return;
        }
        if (child.isSymbolicLink()) continue;
        const absolutePath = path.join(directory, child.name);
        const relativePath = this.normalizeRelative(
          path.relative(target, absolutePath),
        );
        const workspacePath = this.normalizeRelative(
          path.relative(root, absolutePath),
        );
        if (child.isDirectory()) {
          if (this.ignoredDirectories.has(child.name)) continue;
          directories += 1;
          entries.push({
            name: child.name,
            path: workspacePath,
            relativePath,
            type: "directory",
            depth,
            lineCount: null,
            binary: false,
          });
          if (depth >= maxDepth) {
            truncated = true;
          } else {
            await walk(absolutePath, depth + 1);
          }
          continue;
        }
        if (!child.isFile()) continue;
        const inspection = await this.inspectProjectMapFile(absolutePath);
        files += 1;
        entries.push({
          name: child.name,
          path: workspacePath,
          relativePath,
          type: "file",
          depth,
          lineCount: inspection.lineCount,
          binary: inspection.binary,
        });
      }
    };
    await walk(target, 1);
    return {
      success: true,
      root: this.normalizeRelative(path.relative(root, target)) || ".",
      entries,
      files,
      directories,
      truncated,
      maxDepth,
      maxFiles,
    };
  }

  private isPathInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  }

  private async inspectProjectMapFile(
    filePath: string,
  ): Promise<{ binary: boolean; lineCount: number | null }> {
    if (this.binaryExtensions.has(path.extname(filePath).toLowerCase())) {
      return { binary: true, lineCount: null };
    }
    let handle;
    try {
      handle = await fs.open(filePath, "r");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      let lineFeeds = 0;
      let lastByte: number | null = null;
      let binary = false;
      while (true) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          position,
        );
        if (bytesRead === 0) break;
        const sampleLimit = Math.min(bytesRead, Math.max(0, 8192 - position));
        for (let index = 0; index < bytesRead; index += 1) {
          if (index < sampleLimit && buffer[index] === 0) binary = true;
          if (buffer[index] === 10) lineFeeds += 1;
        }
        if (binary) return { binary: true, lineCount: null };
        position += bytesRead;
        lastByte = buffer[bytesRead - 1];
      }
      return {
        binary: false,
        lineCount: position === 0 ? 0 : lineFeeds + (lastByte === 10 ? 0 : 1),
      };
    } catch {
      return { binary: false, lineCount: null };
    } finally {
      await handle?.close();
    }
  }

  async search(
    rootPath: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResponse> {
    const empty: SearchResponse = {
      results: [],
      totalMatches: 0,
      filesSearched: 0,
      offset: 0,
      limit: 50,
      hasMore: false,
    };

    if (!rootPath || !query) {
      return empty;
    }

    const root = path.resolve(rootPath);

    try {
      const stat = await fs.stat(root);

      if (!stat.isDirectory()) {
        return empty;
      }
    } catch {
      return empty;
    }

    const matcher = this.createMatcher(query, options);

    if (!matcher) {
      return empty;
    }

    const includePatterns = this.splitPatterns(options.include);
    const excludePatterns = this.splitPatterns(options.exclude);

    const results: SearchResult[] = [];
    const offset = Math.max(0, Math.floor(options.offset || 0));
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit || 50)));
    let totalMatches = 0;

    let filesSearched = 0;

    const walk = async (directory: string): Promise<void> => {
      if (totalMatches >= this.maxResults) {
        return;
      }

      let entries;

      try {
        entries = await fs.readdir(directory, {
          withFileTypes: true,
        });
      } catch {
        return;
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (totalMatches >= this.maxResults) {
          return;
        }

        const fullPath = path.join(directory, entry.name);

        const relativePath = this.normalizeRelative(
          path.relative(root, fullPath),
        );

        if (entry.isDirectory()) {
          if (this.ignoredDirectories.has(entry.name)) {
            continue;
          }

          if (this.matchesAny(relativePath, excludePatterns)) {
            continue;
          }

          await walk(fullPath);

          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        if (this.matchesAny(relativePath, excludePatterns)) {
          continue;
        }

        if (
          includePatterns.length > 0 &&
          !this.matchesAny(relativePath, includePatterns)
        ) {
          continue;
        }

        try {
          const stat = await fs.stat(fullPath);

          if (stat.size > this.maxFileSize) {
            continue;
          }

          const buffer = await fs.readFile(fullPath);

          if (this.isBinary(buffer)) {
            continue;
          }

          const content = buffer.toString("utf8");

          filesSearched++;

          const lines = content.split(/\r?\n/);

          for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            if (totalMatches >= this.maxResults) {
              return;
            }

            const line = lines[lineIndex];

            const matches = matcher(line);

            for (const match of matches) {
              totalMatches++;
              if (totalMatches <= offset || results.length >= limit) continue;

              const preview = this.createPreview(
                line,
                match.index,
                match.length,
              );

              results.push({
                path: fullPath,

                relativePath,

                name: entry.name,

                line: lineIndex + 1,

                column: match.index,

                preview: preview.text,

                matchStart: preview.matchStart,

                matchLength: match.length,
              });
            }
          }
        } catch {
          console.error('fail to fetch file');
        }
      }
    };

    await walk(root);

    return {
      results,
      totalMatches,
      filesSearched,
      offset,
      limit,
      hasMore: offset + results.length < totalMatches,
    };
  }

  private createMatcher(
    query: string,
    options: SearchOptions,
  ):
    | ((line: string) => {
        index: number;
        length: number;
      }[])
    | null {
    const flags = options.caseSensitive ? "g" : "gi";

    if (options.useRegex) {
      try {
        const regex = new RegExp(
          options.wholeWord ? `\\b(?:${query})\\b` : query,
          flags,
        );

        return (line) => this.findAllMatches(regex, line);
      } catch {
        return null;
      }
    }

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const expression = options.wholeWord ? `\\b${escaped}\\b` : escaped;

    const regex = new RegExp(expression, flags);

    return (line) => this.findAllMatches(regex, line);
  }

  private findAllMatches(
    regex: RegExp,
    line: string,
  ): {
    index: number;
    length: number;
  }[] {
    const matches: {
      index: number;
      length: number;
    }[] = [];

    regex.lastIndex = 0;

    let match: RegExpExecArray | null;

    while ((match = regex.exec(line)) !== null) {
      const value = match[0];

      matches.push({
        index: match.index,
        length: value.length,
      });

      if (value.length === 0) {
        regex.lastIndex++;
      }
    }

    regex.lastIndex = 0;

    return matches;
  }

  private splitPatterns(value?: string): string[] {
    if (!value) {
      return [];
    }

    return value
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private matchesAny(value: string, patterns: string[]): boolean {
    return patterns.some((pattern) => this.matchGlob(value, pattern));
  }

  private matchGlob(value: string, pattern: string): boolean {
    const normalizedValue = this.normalizeRelative(value);

    let normalizedPattern = this.normalizeRelative(pattern);

    if (normalizedPattern.startsWith("./")) {
      normalizedPattern = normalizedPattern.slice(2);
    }

    const regexSource = normalizedPattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "§§DOUBLESTAR§§")
      .replace(/\*/g, "[^/]*")
      .replace(/§§DOUBLESTAR§§/g, ".*")
      .replace(/\?/g, "[^/]");

    const regex = new RegExp(`^${regexSource}$`, "i");

    if (regex.test(normalizedValue)) {
      return true;
    }

    const basename = path.posix.basename(normalizedValue);

    return regex.test(basename);
  }

  private normalizeRelative(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\/+/, "");
  }

  private isBinary(buffer: Buffer): boolean {
    const sampleLength = Math.min(buffer.length, 8192);

    for (let i = 0; i < sampleLength; i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }

    return false;
  }

  private createPreview(
    line: string,
    matchIndex: number,
    matchLength: number,
  ): {
    text: string;
    matchStart: number;
  } {
    const maxLength = 180;
    const padding = 70;

    let start = Math.max(0, matchIndex - padding);

    let end = Math.min(line.length, matchIndex + matchLength + padding);

    if (end - start > maxLength) {
      const desiredStart = Math.max(0, matchIndex - Math.floor(maxLength / 2));

      start = desiredStart;

      end = Math.min(line.length, start + maxLength);
    }

    const text = line.slice(start, end);

    return {
      text,
      matchStart: matchIndex - start,
    };
  }
}
