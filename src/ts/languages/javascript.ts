import type { LanguageDefinition } from "./types";

/**
 * JavaScript & TypeScript environment.
 *
 * JavaScript and TypeScript share exactly the same three components: the
 * JavaScript runtime (the Node.js distribution), the TypeScript compiler with
 * its tsserver backend, and the TypeScript language server. Two separate
 * language definitions listed the same components twice, so the Version
 * Manager showed two near-identical environments for one toolchain.
 *
 * They are now one language covering both extension families. The compiler and
 * the language server are optional components: a plain JavaScript project only
 * needs the runtime, while a TypeScript project selects all three.
 */
export const javascript: LanguageDefinition = {
  id: "javascript",
  name: "JavaScript & TypeScript",
  description: "JavaScript runtime, TypeScript compiler and language server for JavaScript and TypeScript projects.",
  categories: ["language"],
  icon: "fi fi-brands-js",
  fileExtensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"],
  components: [
    {
      id: "javascript.runtime",
      name: "JavaScript Runtime",
      description: "JavaScript runtime (Node.js) with npm and npx for running scripts and tools.",
      type: "runtime",
      packageId: "node",
      platforms: ["darwin", "win32"],
      capabilities: ["execute-scripts", "manage-packages"],
      fileExtensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"],
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
      fileExtensions: [".ts", ".tsx", ".mts", ".cts"],
      defaultSelected: true,
    },
    {
      id: "javascript.lsp",
      name: "TypeScript Language Server",
      description: "LSP server for JavaScript and TypeScript diagnostics, completion and navigation.",
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
  defaultSelection: ["javascript.runtime", "javascript.typescript", "javascript.lsp"],
};
