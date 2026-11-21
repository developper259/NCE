import type { InstallerArchitecture, InstallerPlatform } from "../installer/types";

/** What role a component plays inside a language environment. */
export type LanguageComponentType =
  | "runtime"
  | "package-manager"
  | "language-server"
  | "compiler"
  | "debugger"
  | "toolchain";

/** Capability a component advertises to the editor once installed. */
export type LanguageComponentCapability =
  | "execute-scripts"
  | "create-virtualenv"
  | "manage-packages"
  | "language-server";

/**
 * Declarative description of one installable component of a language.
 *
 * It does not duplicate installation logic: `packageId` points to the existing
 * ManagedPackageDefinition that owns the download, verification and uninstall
 * strategy. Dependencies are declared here as component ids and resolved by the
 * planner; they must mirror the package-level dependencies used by the Installer.
 */
export interface LanguageComponentDefinition {
  /** Stable id, namespaced under the language (e.g. "python.runtime"). */
  id: string;
  name: string;
  description: string;
  type: LanguageComponentType;
  /** Id of the ManagedPackageDefinition in PackageRegistry that installs it. */
  packageId: string;
  platforms: InstallerPlatform[];
  architectures?: InstallerArchitecture[];
  /** Ids of other components in the same language required by this one. */
  dependencies?: string[];
  capabilities?: LanguageComponentCapability[];
  /** Id of the LSP server definition this component provides, if any. */
  lspServerId?: string;
  /** File extensions this component can serve (runtime or language server). */
  fileExtensions?: string[];
  /** Included by default when the user first selects the language. */
  defaultSelected?: boolean;
}

/** A language is a named group of independently installable components. */
export interface LanguageDefinition {
  id: string;
  name: string;
  description: string;
  categories: string[];
  icon?: string;
  fileExtensions: string[];
  components: LanguageComponentDefinition[];
  defaultSelection?: string[];
}

/** Component enriched with the state of its underlying managed package. */
export interface LanguageComponentInfo extends LanguageComponentDefinition {
  installableVersion: string;
  supported: boolean;
}

/** Language enriched with resolved component state for the renderer. */
export interface LanguageInfo extends Omit<LanguageDefinition, "components"> {
  components: LanguageComponentInfo[];
}
