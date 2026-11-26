import type { LanguageDefinition } from "./types";

/** Python language environment: CPython runtime plus the Pyright LSP. */
export const python: LanguageDefinition = {
  id: "python",
  name: "Python",
  description: "CPython runtime and Pyright language server for Python projects.",
  summary: "Tout le nécessaire pour coder en Python dans NCE.",
  benefits: [
    {
      title: "Exécuter vos programmes",
      description: "Lancez vos fichiers et projets Python.",
      icon: "fi-rr-play",
    },
    {
      title: "Aide à l'écriture",
      description: "Suggestions de code, détection des erreurs et navigation.",
      icon: "fi-rr-sparkles",
    },
  ],
  categories: ["language"],
  icon: "fi fi-brands-python",
  fileExtensions: [".py", ".pyi", ".pyw"],
  components: [
    {
      id: "python.runtime",
      name: "Python Runtime",
      description: "CPython interpreter and standard library.",
      type: "runtime",
      packageId: "python",
      platforms: ["darwin", "win32", "linux"],
      capabilities: ["execute-scripts", "create-virtualenv", "manage-packages"],
      fileExtensions: [".py", ".pyi", ".pyw"],
      defaultSelected: true,
    },
    {
      id: "python.lsp",
      name: "Pyright Language Server",
      description: "LSP server for Python diagnostics and navigation.",
      type: "language-server",
      packageId: "pyright",
      platforms: ["darwin", "win32", "linux"],
      dependencies: ["python.runtime"],
      capabilities: ["language-server"],
      lspServerId: "pyright",
      fileExtensions: [".py", ".pyi", ".pyw"],
      defaultSelected: true,
    },
  ],
  defaultSelection: ["python.runtime", "python.lsp"],
};
