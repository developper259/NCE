import { git } from "./git";
import { node } from "./node";
import { typescript } from "./typescript";
import { typescriptLanguageServer } from "./typescript-language-server";
import type { ManagedPackageDefinition } from "./types";

export const builtinManagedPackages: ManagedPackageDefinition[] = [
  git,
  node,
  typescript,
  typescriptLanguageServer,
];