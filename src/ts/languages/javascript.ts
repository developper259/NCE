import type { LanguageDefinition } from "./types";

/**
 * JavaScript & TypeScript environment.
 *
 * JavaScript and TypeScript share one language definition covering both
 * extension families. The Node.js runtime used by NCE's language servers is
 * shipped with the app, so it is no longer a component the user installs, and
 * it is not the runtime their project runs on: this environment adds code
 * intelligence, not an execution runtime. The TypeScript compiler and language
 * server remain installable components.
 */
export const javascript: LanguageDefinition = {
  id: "javascript",
  name: "JavaScript & TypeScript",
  description: "Ajoutez les suggestions de code, la navigation et la détection des erreurs pour vos projets JavaScript et TypeScript.",
  summary: "Suggestions de code, navigation et détection des erreurs pour vos projets JavaScript et TypeScript.",
  benefits: [
    {
      title: "Suggestions de code",
      description: "Complétion et informations au survol pendant que vous écrivez.",
      icon: "fi-rr-sparkles",
    },
    {
      title: "Détection des erreurs",
      description: "Les erreurs de type et de syntaxe apparaissent dans le panneau Problèmes.",
      icon: "fi-rr-triangle-warning",
    },
    {
      title: "Navigation dans le code",
      description: "Définitions, références et renommage dans tout le projet.",
      icon: "fi-rr-search-alt",
    },
  ],
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
