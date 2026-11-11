import type { PackageDefinition } from "../types";
import { git } from "./git";

export const builtinPackages: Record<string, PackageDefinition> = { git };