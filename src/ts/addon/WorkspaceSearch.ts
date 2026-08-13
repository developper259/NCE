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
    ".next",
    ".cache",
    ".turbo",
  ]);

  private readonly maxFileSize = 5 * 1024 * 1024;
  private readonly maxResults = 10000;

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

    let filesSearched = 0;

    const walk = async (directory: string): Promise<void> => {
      if (results.length >= this.maxResults) {
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
        if (results.length >= this.maxResults) {
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
            if (results.length >= this.maxResults) {
              return;
            }

            const line = lines[lineIndex];

            const matches = matcher(line);

            for (const match of matches) {
              if (results.length >= this.maxResults) {
                return;
              }

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
      totalMatches: results.length,
      filesSearched,
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
