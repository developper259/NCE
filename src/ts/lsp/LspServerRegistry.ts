import path from "node:path";
import { promises as fs } from "node:fs";

export interface LspCommandCandidate {
  command: string;
  args: string[];
}

export interface LspServerDefinition {
  id: string;
  name: string;
  description: string;
  languages: string[];
  extensions: string[];
  commands: LspCommandCandidate[];
  rootMarkers: string[];
  priority: number;
  defaultEnabled: boolean;
  requiresConfiguration?: boolean;
  initializationOptions?: Record<string, unknown>;
}

const SERVER_DEFINITIONS: LspServerDefinition[] = [
  {
    id: "typescript-language-server",
    name: "TypeScript Language Server",
    description: "TypeScript and JavaScript language features.",
    languages: ["javascript", "typescript"],
    extensions: [".js", ".mjs", ".ts"],
    commands: [{ command: "typescript-language-server", args: ["--stdio"] }],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
    priority: 100,
    defaultEnabled: true,
  },
  {
    id: "eslint-language-server",
    name: "ESLint Language Server",
    description: "ESLint diagnostics and quick fixes.",
    languages: ["javascript", "typescript"],
    extensions: [".js", ".mjs", ".ts"],
    commands: [{ command: "vscode-eslint-language-server", args: ["--stdio"] }],
    rootMarkers: [".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", "eslint.config.js", "eslint.config.mjs", "package.json"],
    priority: 40,
    defaultEnabled: false,
  },
  {
    id: "basedpyright",
    name: "BasedPyright",
    description: "Python type checking and language features.",
    languages: ["python"],
    extensions: [".py", ".pyw"],
    commands: [
      { command: "basedpyright-langserver", args: ["--stdio"] },
      { command: "pyright-langserver", args: ["--stdio"] },
    ],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
    priority: 100,
    defaultEnabled: true,
  },
  {
    id: "ruff",
    name: "Ruff",
    description: "Fast Python linting and formatting.",
    languages: ["python"],
    extensions: [".py", ".pyw"],
    commands: [
      { command: "ruff", args: ["server"] },
      { command: "ruff-lsp", args: [] },
    ],
    rootMarkers: ["pyproject.toml", "ruff.toml", ".ruff.toml"],
    priority: 30,
    defaultEnabled: false,
  },
  {
    id: "clangd",
    name: "clangd",
    description: "C and C++ language server.",
    languages: ["c", "cpp"],
    extensions: [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"],
    commands: [{ command: "clangd", args: [] }],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt"],
    priority: 100,
    defaultEnabled: true,
  },
  {
    id: "html-language-server",
    name: "HTML Language Server",
    description: "HTML language features.",
    languages: ["html"],
    extensions: [".html", ".htm"],
    commands: [{ command: "vscode-html-language-server", args: ["--stdio"] }],
    rootMarkers: ["package.json"],
    priority: 100,
    defaultEnabled: true,
  },
  {
    id: "css-language-server",
    name: "CSS Language Server",
    description: "CSS language features.",
    languages: ["css"],
    extensions: [".css"],
    commands: [{ command: "vscode-css-language-server", args: ["--stdio"] }],
    rootMarkers: ["package.json"],
    priority: 100,
    defaultEnabled: true,
  },
  {
    id: "json-language-server",
    name: "JSON Language Server",
    description: "JSON validation and language features.",
    languages: ["json"],
    extensions: [".json", ".geojson"],
    commands: [{ command: "vscode-json-language-server", args: ["--stdio"] }],
    rootMarkers: ["package.json"],
    priority: 100,
    defaultEnabled: true,
  },
  {
    id: "yaml-language-server",
    name: "YAML Language Server",
    description: "YAML validation and completion.",
    languages: ["yaml"],
    extensions: [".yaml", ".yml"],
    commands: [{ command: "yaml-language-server", args: ["--stdio"] }],
    rootMarkers: [],
    priority: 100,
    defaultEnabled: true,
  },
  {
    id: "intelephense",
    name: "Intelephense",
    description: "PHP language features.",
    languages: ["php"],
    extensions: [".php", ".phtml"],
    commands: [{ command: "intelephense", args: ["--stdio"] }],
    rootMarkers: ["composer.json"],
    priority: 100,
    defaultEnabled: true,
  },
  {
    id: "phpactor",
    name: "Phpactor",
    description: "Alternative PHP language server.",
    languages: ["php"],
    extensions: [".php", ".phtml"],
    commands: [{ command: "phpactor", args: ["language-server"] }],
    rootMarkers: ["composer.json"],
    priority: 40,
    defaultEnabled: false,
  },
  {
    id: "eclipse-jdtls",
    name: "Eclipse JDT Language Server",
    description: "Java language features.",
    languages: ["java"],
    extensions: [".java"],
    commands: [{ command: "jdtls", args: [] }],
    rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", ".project", ".classpath"],
    priority: 100,
    defaultEnabled: true,
    requiresConfiguration: true,
  },
  {
    id: "lemminx",
    name: "Eclipse LemMinX",
    description: "XML language features.",
    languages: ["xml"],
    extensions: [".xml", ".xsd", ".xsl", ".xslt", ".svg"],
    commands: [{ command: "lemminx", args: [] }],
    rootMarkers: [],
    priority: 100,
    defaultEnabled: true,
  },
];

const EXTENSION_LANGUAGE = new Map<string, string>([
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".ts", "typescript"],
  [".py", "python"],
  [".pyw", "python"],
  [".html", "html"],
  [".htm", "html"],
  [".css", "css"],
  [".json", "json"],
  [".geojson", "json"],
  [".php", "php"],
  [".phtml", "php"],
  [".xml", "xml"],
  [".xsd", "xml"],
  [".xsl", "xml"],
  [".xslt", "xml"],
  [".svg", "xml"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".java", "java"],
  [".c", "c"],
  [".h", "c"],
  [".cpp", "cpp"],
  [".cc", "cpp"],
  [".cxx", "cpp"],
  [".hpp", "cpp"],
  [".hh", "cpp"],
  [".hxx", "cpp"],
]);

export function languageIdForPath(filePath: string): string | null {
  return EXTENSION_LANGUAGE.get(path.extname(filePath).toLowerCase()) || null;
}

export function getServerDefinitions(): readonly LspServerDefinition[] {
  return SERVER_DEFINITIONS;
}

export function getServerDefinition(id: string): LspServerDefinition | null {
  return SERVER_DEFINITIONS.find((definition) => definition.id === id) || null;
}

export function serversForLanguage(languageId: string): LspServerDefinition[] {
  return SERVER_DEFINITIONS.filter((definition) =>
    definition.languages.includes(languageId));
}

export function isKnownServerId(id: string): boolean {
  return SERVER_DEFINITIONS.some((definition) => definition.id === id);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Effective project root for a document: the nearest ancestor inside the
 * workspace that contains one of the server markers, otherwise the workspace.
 */
export async function resolveServerRoot(
  definition: LspServerDefinition,
  documentPath: string,
  workspaceRoot: string,
): Promise<string> {
  if (!definition.rootMarkers.length) return workspaceRoot;
  let directory = path.dirname(documentPath);
  const boundary = path.resolve(workspaceRoot);
  while (true) {
    for (const marker of definition.rootMarkers) {
      if (await pathExists(path.join(directory, marker))) return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    const relative = path.relative(boundary, parent);
    if (relative.startsWith("..") || path.isAbsolute(relative)) break;
    if (path.resolve(directory) === boundary) break;
    directory = parent;
  }
  return workspaceRoot;
}
