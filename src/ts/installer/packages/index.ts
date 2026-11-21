import type { PackageDefinition } from "../types";
import { git } from "./git";
import { node } from "./node";
import { typescript } from "./typescript";
import { typescriptLanguageServer } from "./typescript-language-server";

export const builtinPackages: Record<string, PackageDefinition> = {
  git,
  node,
  typescript,
  "typescript-language-server": typescriptLanguageServer,
};