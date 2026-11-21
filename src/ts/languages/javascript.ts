import type { LanguageDefinition } from "./types";

/**
 * JavaScript and TypeScript share one language environment: the same Node.js
 * runtime and the same typescript-language-server. Components map to managed
 * packages, so their lifecycle stays in the existing PackageManager.
 */
export const javascript: LanguageDefinition = {
  id: "javascript",
  name: "JavaScript / TypeScript",
  description: "Node.js runtime and TypeScript language tooling for JavaScript and TypeScript projects.",
  categories: ["language"],
  icon: "fi fi-brands-nodejs",
  fileExtensions: [
    ".js", ".jsx", ".mjs", ".cjs",
    ".ts", ".tsx", ".mts", ".cts",
  ],
  components: [
    {
      id: "javascript.runtime",
      name: "Node.js Runtime",
      description: "Node.js with npm and npx for running scripts and tools.",
      type: "runtime",
      packageId: "node",
      platforms: ["darwin", "win32"],
      capabilities: ["execute-scripts", "manage-packages"],
      fileExtensions: [".js", ".mjs", ".cjs"],
      defaultSelected: true,
    },
    {
      id: "javascript.typescript",
      name: "TypeScript",
      description: "TypeScript compiler and tsserver backend.",
      type: "compiler",
      packageId: "typescript",
      platforms: ["darwin", "win32", "linux"],
      dependencies: ["javascript.runtime"],
    },
    {
      id: "javascript.lsp",
      name: "TypeScript Language Server",
      description: "LSP server for JavaScript and TypeScript diagnostics and navigation.",
      type: "language-server",
      packageId: "typescript-language-server",
      platforms: ["darwin", "win32", "linux"],
      dependencies: ["javascript.typescript"],
      capabilities: ["language-server"],
      lspServerId: "typescript-language-server",
      fileExtensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"],
      defaultSelected: true,
    },
  ],
  defaultSelection: ["javascript.runtime", "javascript.lsp"],
};
