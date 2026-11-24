import type { LanguageDefinition } from "./types";

/**
 * JavaScript environment: the JavaScript runtime (the Node.js distribution) and
 * the TypeScript language server. The compiler is a component because the
 * language server needs its tsserver backend. TypeScript has its own definition
 * (typescript.ts); both map to the same managed packages so their lifecycle
 * stays in PackageManager.
 */
export const javascript: LanguageDefinition = {
  id: "javascript",
  name: "JavaScript",
  description: "JavaScript runtime and TypeScript language tooling for JavaScript projects.",
  categories: ["language"],
  icon: "fi fi-brands-js",
  fileExtensions: [".js", ".jsx", ".mjs", ".cjs"],
  components: [
    {
      id: "javascript.runtime",
      name: "JavaScript Runtime",
      description: "JavaScript runtime (Node.js) with npm and npx for running scripts and tools.",
      type: "runtime",
      packageId: "node",
      platforms: ["darwin", "win32"],
      capabilities: ["execute-scripts", "manage-packages"],
      fileExtensions: [".js", ".mjs", ".cjs"],
      defaultSelected: true,
    },
    {
      id: "javascript.typescript",
      name: "TypeScript Compiler",
      description: "Compiler and tsserver backend required by the language server.",
      type: "compiler",
      packageId: "typescript",
      platforms: ["darwin", "win32", "linux"],
      dependencies: ["javascript.runtime"],
    },
    {
      id: "javascript.lsp",
      name: "TypeScript Language Server",
      description: "LSP server for JavaScript diagnostics, completion and navigation.",
      type: "language-server",
      packageId: "typescript-language-server",
      platforms: ["darwin", "win32", "linux"],
      dependencies: ["javascript.typescript"],
      capabilities: ["language-server"],
      lspServerId: "typescript-language-server",
      fileExtensions: [".js", ".jsx", ".mjs", ".cjs"],
      defaultSelected: true,
    },
  ],
  defaultSelection: ["javascript.runtime", "javascript.lsp"],
};
