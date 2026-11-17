import { git } from "./git";
import type { ManagedPackageDefinition } from "./types";

export const builtinManagedPackages: ManagedPackageDefinition[] = [git];