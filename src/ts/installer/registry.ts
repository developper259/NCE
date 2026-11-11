import { InstallerError } from "./errors";
import { builtinPackages } from "./packages";
import type { PackageDefinition } from "./types";

export function getPackageDefinition(
  id: string,
  registry: Record<string, PackageDefinition> = builtinPackages,
): PackageDefinition {
  const definition = registry[id];
  if (!definition)
    throw new InstallerError("PACKAGE_NOT_FOUND", `Unknown package "${id}".`);
  return definition;
}