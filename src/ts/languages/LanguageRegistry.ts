import type { PackageRegistry } from "../packages/PackageRegistry";
import type { LanguageComponentDefinition, LanguageDefinition } from "./types";

const SAFE_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const COMPONENT_TYPES = new Set([
  "runtime",
  "package-manager",
  "language-server",
  "compiler",
  "debugger",
  "toolchain",
]);

const COMPONENT_CAPABILITIES = new Set([
  "execute-scripts",
  "create-virtualenv",
  "manage-packages",
  "language-server",
]);

export class LanguageRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LanguageRegistryError";
  }
}

/**
 * Holds declarative language definitions and validates them against the package
 * registry. It owns no installation state: each component resolves to a managed
 * package through `packageId`, and the PackageManager remains the source of
 * truth for what is actually installed.
 */
export class LanguageRegistry {
  private readonly definitions = new Map<string, LanguageDefinition>();

  constructor(
    definitions: LanguageDefinition[] = [],
    private readonly packages?: PackageRegistry,
  ) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: LanguageDefinition): void {
    this.validate(definition);
    if (this.definitions.has(definition.id))
      throw new LanguageRegistryError(`Language "${definition.id}" is already registered.`);
    this.definitions.set(definition.id, definition);
  }

  get(id: string): LanguageDefinition {
    const definition = typeof id === "string" ? this.definitions.get(id) : undefined;
    if (!definition) throw new LanguageRegistryError(`Unknown language "${String(id)}".`);
    return definition;
  }

  has(id: string): boolean {
    return typeof id === "string" && this.definitions.has(id);
  }

  list(): LanguageDefinition[] {
    return [...this.definitions.values()];
  }

  /** Find the language that owns a component id, if any. */
  findByComponent(componentId: string): LanguageDefinition | undefined {
    return this.list().find((language) =>
      language.components.some((component) => component.id === componentId),
    );
  }

  private validate(definition: LanguageDefinition): void {
    const invalid = (reason: string): never => {
      throw new LanguageRegistryError(`Invalid language definition "${definition?.id}": ${reason}`);
    };
    if (!definition || typeof definition !== "object") invalid("definition is required.");
    if (typeof definition.id !== "string" || !SAFE_TOKEN.test(definition.id)) invalid("id must be a path-safe token.");
    if (typeof definition.name !== "string" || !definition.name.trim()) invalid("name is required.");
    if (typeof definition.description !== "string" || !definition.description.trim()) invalid("description is required.");
    if (!Array.isArray(definition.categories) || definition.categories.length === 0) invalid("at least one category is required.");
    if (!Array.isArray(definition.fileExtensions) || definition.fileExtensions.some((ext) => typeof ext !== "string" || !ext.startsWith("."))) invalid("fileExtensions must be dotted extensions.");
    if (!Array.isArray(definition.components) || definition.components.length === 0) invalid("at least one component is required.");

    const ids = new Set<string>();
    for (const component of definition.components) {
      this.validateComponent(component, ids, invalid);
    }
    for (const component of definition.components) {
      if (component.dependencies?.some((id) => !ids.has(id)))
        invalid(`component "${component.id}" has an unknown dependency.`);
    }
    if (definition.defaultSelection !== undefined) {
      if (!Array.isArray(definition.defaultSelection) || definition.defaultSelection.some((id) => typeof id !== "string" || !ids.has(id)))
        invalid("defaultSelection must reference component ids.");
    }
  }

  private validateComponent(
    component: LanguageComponentDefinition,
    seen: Set<string>,
    invalid: (reason: string) => never,
  ): void {
    if (!component || typeof component !== "object") invalid("component is required.");
    if (typeof component.id !== "string" || !SAFE_TOKEN.test(component.id)) invalid("component id must be a path-safe token.");
    if (seen.has(component.id)) invalid(`duplicate component id "${component.id}".`);
    seen.add(component.id);
    if (typeof component.name !== "string" || !component.name.trim()) invalid("component name is required.");
    if (typeof component.description !== "string" || !component.description.trim()) invalid("component description is required.");
    if (!COMPONENT_TYPES.has(component.type)) invalid(`unknown component type "${component.type}".`);
    if (typeof component.packageId !== "string" || !SAFE_TOKEN.test(component.packageId)) invalid("packageId must be a path-safe token.");
    if (this.packages && !this.packages.has(component.packageId))
      invalid(`component "${component.id}" references unregistered package "${component.packageId}".`);
    if (!Array.isArray(component.platforms) || component.platforms.length === 0) invalid("component platforms are required.");
    if (component.dependencies !== undefined && (!Array.isArray(component.dependencies) || component.dependencies.some((id) => typeof id !== "string" || !SAFE_TOKEN.test(id))))
      invalid("component dependencies must be component ids.");
    if (component.capabilities !== undefined && (!Array.isArray(component.capabilities) || component.capabilities.some((cap) => !COMPONENT_CAPABILITIES.has(cap))))
      invalid("unknown component capability.");
    if (component.fileExtensions !== undefined && (!Array.isArray(component.fileExtensions) || component.fileExtensions.some((ext) => typeof ext !== "string" || !ext.startsWith("."))))
      invalid("component fileExtensions must be dotted extensions.");
  }
}
