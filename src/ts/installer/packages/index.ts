import type { PackageDefinition } from "../types";
import { git } from "./git";
import { pyright } from "./pyright";
import { python } from "./python";
import { typescript } from "./typescript";
import { typescriptLanguageServer } from "./typescript-language-server";

export const builtinPackages: Record<string, PackageDefinition> = {
  git,
  python,
  pyright,
  typescript,
  "typescript-language-server": typescriptLanguageServer,
};