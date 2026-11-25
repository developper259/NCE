import { git } from "./git";
import { pyright } from "./pyright";
import { python } from "./python";
import { typescript } from "./typescript";
import { typescriptLanguageServer } from "./typescript-language-server";
import type { ManagedPackageDefinition } from "./types";

export const builtinManagedPackages: ManagedPackageDefinition[] = [
  git,
  python,
  pyright,
  typescript,
  typescriptLanguageServer,
];