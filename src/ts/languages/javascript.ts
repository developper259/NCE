import type { LanguageDefinition } from "./types";

/**
 * JavaScript & TypeScript environment.
 *
 * JavaScript and TypeScript share one language definition covering both
 * extension families. The Node.js runtime used by NCE's language servers is
 * shipped with the app, so it is no longer a component the user installs.
 * The TypeScript compiler and language server remain installable components.
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
      id: "javascript.typescript",
      name: "TypeScript Compiler",
      description: "Compiler and tsserver backend required by the language server.",
      type: "compiler",
      packageId: "typescript",
      platforms: ["darwin", "win32", "linux"],
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
  defaultSelection: ["javascript.typescript", "javascript.lsp"],
};
