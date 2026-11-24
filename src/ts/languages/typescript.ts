import type { LanguageDefinition } from "./types";

/**
 * TypeScript environment: the JavaScript runtime (the Node.js distribution), the
 * TypeScript compiler and the TypeScript language server. Components map to the
 * same managed packages as the JavaScript language; installation state stays in
 * PackageManager.
 */
export const typescript: LanguageDefinition = {
  id: "typescript",
  name: "TypeScript",
  description: "TypeScript compiler, tsserver backend and language server for TypeScript projects.",
  categories: ["language"],
  icon: "fi fi-brands-typescript",
  fileExtensions: [".ts", ".tsx", ".mts", ".cts"],
  components: [
    {
      id: "typescript.runtime",
      name: "JavaScript Runtime",
      description: "JavaScript runtime (Node.js) required to run the TypeScript compiler and language server.",
      type: "runtime",
      packageId: "node",
      platforms: ["darwin", "win32"],
      capabilities: ["execute-scripts", "manage-packages"],
      fileExtensions: [".js", ".mjs", ".cjs"],
      defaultSelected: true,
    },
    {
      id: "typescript.compiler",
      name: "TypeScript Compiler",
      description: "TypeScript compiler and tsserver backend.",
      type: "compiler",
      packageId: "typescript",
      platforms: ["darwin", "win32", "linux"],
      dependencies: ["typescript.runtime"],
      fileExtensions: [".ts", ".tsx", ".mts", ".cts"],
      defaultSelected: true,
    },
    {
      id: "typescript.lsp",
      name: "TypeScript Language Server",
      description: "LSP server for TypeScript diagnostics, completion and navigation.",
      type: "language-server",
      packageId: "typescript-language-server",
      platforms: ["darwin", "win32", "linux"],
      dependencies: ["typescript.compiler"],
      capabilities: ["language-server"],
      lspServerId: "typescript-language-server",
      fileExtensions: [".ts", ".tsx", ".mts", ".cts"],
      defaultSelected: true,
    },
  ],
  defaultSelection: ["typescript.runtime", "typescript.compiler", "typescript.lsp"],
};
