import { builtinManagedPackages } from "./index";
import type { ManagedPackageDefinition, PackageCategory } from "./types";
import { PACKAGE_CATEGORIES } from "./types";

const SAFE_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export class PackageRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageRegistryError";
  }
}

/** Knows which packages NCE can manage. Independent from any UI or filesystem state. */
export class PackageRegistry {
  private readonly definitions = new Map<string, ManagedPackageDefinition>();

  constructor(definitions: ManagedPackageDefinition[] = builtinManagedPackages) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ManagedPackageDefinition): void {
    validateManagedDefinition(definition);
    if (this.definitions.has(definition.id))
      throw new PackageRegistryError(`Package "${definition.id}" is already registered.`);
    this.definitions.set(definition.id, definition);
  }

  get(id: string): ManagedPackageDefinition {
    const definition = typeof id === "string" ? this.definitions.get(id) : undefined;
    if (!definition) throw new PackageRegistryError(`Unknown package "${String(id)}".`);
    return definition;
  }

  has(id: string): boolean {
    return typeof id === "string" && this.definitions.has(id);
  }

  list(): ManagedPackageDefinition[] {
    return [...this.definitions.values()];
  }

  listByCategory(category: PackageCategory): ManagedPackageDefinition[] {
    return this.list().filter((definition) => definition.categories.includes(category));
  }
}

export function validateManagedDefinition(definition: ManagedPackageDefinition): void {
  const invalid = (reason: string): never => {
    throw new PackageRegistryError(`Invalid package definition "${definition?.id}": ${reason}`);
  };
  if (!definition || typeof definition !== "object") invalid("definition is required.");
  if (typeof definition.id !== "string" || !SAFE_TOKEN.test(definition.id)) invalid("id must be a path-safe token.");
  if (typeof definition.name !== "string" || !definition.name.trim()) invalid("name is required.");
  if (typeof definition.description !== "string" || !definition.description.trim()) invalid("description is required.");
  if (!Array.isArray(definition.categories) || definition.categories.length === 0) invalid("at least one category is required.");
  if (definition.categories.some((category) => !PACKAGE_CATEGORIES.includes(category))) invalid("unknown category.");
  if (!Array.isArray(definition.platforms) || definition.platforms.length === 0) invalid("at least one platform is required.");
  if (!Array.isArray(definition.capabilities)) invalid("capabilities must be an array.");
  if (definition.capabilities.some((capability) => !["install", "uninstall", "verify"].includes(capability))) invalid("unknown capability.");
  if (typeof definition.installerPackageId !== "string" || !SAFE_TOKEN.test(definition.installerPackageId)) invalid("installerPackageId must be a path-safe token.");
  if (typeof definition.installableVersion !== "string" || !SAFE_TOKEN.test(definition.installableVersion)) invalid("installableVersion must be a path-safe token.");
  if (typeof definition.installationRoot !== "string" || !isSafeRelativePath(definition.installationRoot)) invalid("installationRoot must be a relative path inside tools/.");
  if (definition.uninstall?.strategy !== "installer-directory") invalid("unsupported uninstall strategy.");
  if (definition.managedSettings !== undefined && (!Array.isArray(definition.managedSettings) || definition.managedSettings.some((key) => typeof key !== "string" || !key.trim()))) invalid("managedSettings must be setting keys.");
  if (definition.versionPattern !== undefined) {
    if (typeof definition.versionPattern !== "string") invalid("versionPattern must be a string.");
    try { new RegExp(definition.versionPattern); } catch { invalid("versionPattern is not a valid regular expression."); }
  }
  if (definition.dependencies !== undefined && (!Array.isArray(definition.dependencies) || definition.dependencies.some((id) => typeof id !== "string" || !SAFE_TOKEN.test(id)))) invalid("dependencies must be package ids.");
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\0")) return false;
  if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) return false;
  return value.split(/[\\/]+/).every((segment) => segment && segment !== "." && segment !== "..");
}