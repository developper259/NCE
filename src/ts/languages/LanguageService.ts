import type { PackageRegistry } from "../packages/PackageRegistry";
import type { VersionManagerSnapshot } from "../packages/types";
import { ComponentPlanner, type ComponentChangePlan, type ComponentInstallState } from "./ComponentPlanner";
import type { LanguageComponentInfo, LanguageDefinition, LanguageInfo } from "./types";

/** Renderer-facing view of a language, including the desired-state plan. */
export interface LanguageView extends LanguageInfo {
  plan: ComponentChangePlan;
  /** Ids currently checked in the UI (real state on first load). */
  selected: string[];
  /**
   * Components that will be installed because a selected component needs them,
   * not because the user ticked them. The UI marks these as required instead of
   * showing them as independently installed.
   */
  requiredBySelection: string[];
  /**
   * Packages that will be installed as dependencies of the selected components
   * even though they are not components of this language themselves. Node.js is
   * no longer installable: NCE ships its own runtime for language servers.
   */
  packageDependencies: PackageDependencyNotice[];
}

export interface PackageDependencyNotice {
  packageId: string;
  packageName: string;
  /** Component of this language that needs it. */
  requiredBy: string;
  installed: boolean;
}

/**
 * Bridges declarative language definitions with the real installation state
 * reported by PackageManager. It owns no install logic: it only derives what is
 * installed and what a given selection would change.
 */
export class LanguageService {
  private readonly planner = new ComponentPlanner();

  constructor(
    private readonly languages: LanguageDefinition[],
    private readonly packages: PackageRegistry,
    /**
     * Platform used for component support and planning. Injectable so tests can
     * assert a specific platform instead of inheriting the host one, which made
     * the suite pass on macOS and Windows but fail on Linux.
     */
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** Language metadata with component versions and platform support. */
  list(): LanguageInfo[] {
    return this.languages.map((language) => ({
      id: language.id,
      name: language.name,
      description: language.description,
      categories: [...language.categories],
      icon: language.icon,
      fileExtensions: [...language.fileExtensions],
      components: language.components.map((component) => this.componentInfo(component)),
    }));
  }

  /** Build a view for one language from the real PackageManager snapshot. */
  view(languageId: string, snapshot: VersionManagerSnapshot, selected?: string[]): LanguageView | null {
    const language = this.languages.find((item) => item.id === languageId);
    if (!language) return null;
    const state = this.installedState(snapshot);
    const selection = selected ?? this.defaultSelection(language, state);
    const info = this.list().find((item) => item.id === languageId)!;
    return {
      ...info,
      selected: selection,
      plan: this.planner.plan({
        language,
        selected: selection,
        installed: state,
        platform: this.platform,
      }),
      requiredBySelection: this.requiredBySelection(language, selection, state),
      packageDependencies: this.packageDependencies(language, selection, snapshot),
    };
  }

  /**
   * Package-level dependencies of the selected components that are not
   * components of this language.
   *
   * The component graph and the package graph are separate: `python.lsp`
   * depends on `python.runtime` as a component, while package-level
   * dependencies are declared on the packages themselves. This keeps any such
   * extra download visible to the user.
   */
  private packageDependencies(
    language: LanguageDefinition,
    selection: string[],
    snapshot: VersionManagerSnapshot,
  ): PackageDependencyNotice[] {
    const componentPackages = new Set(language.components.map((component) => component.packageId));
    const installedPackages = new Set(
      snapshot.packages
        .filter((info) => info.state === "installed")
        .map((info) => info.id),
    );
    const notices = new Map<string, PackageDependencyNotice>();

    const visitPackage = (packageId: string, requiredBy: string, seen: Set<string>) => {
      if (seen.has(packageId) || !this.packages.has(packageId)) return;
      seen.add(packageId);
      const definition = this.packages.get(packageId);
      for (const dependencyId of definition.dependencies ?? []) {
        if (!this.packages.has(dependencyId)) continue;
        const dependency = this.packages.get(dependencyId);
        // Only report packages that are not already part of this language: a
        // component of the language is shown in its own row.
        if (!componentPackages.has(dependencyId) && !notices.has(dependencyId)) {
          notices.set(dependencyId, {
            packageId: dependencyId,
            packageName: dependency.name,
            requiredBy,
            installed: installedPackages.has(dependencyId),
          });
        }
        visitPackage(dependencyId, requiredBy, seen);
      }
    };

    for (const componentId of selection) {
      const component = language.components.find((entry) => entry.id === componentId);
      if (!component) continue;
      visitPackage(component.packageId, component.name, new Set());
    }
    return [...notices.values()];
  }

  /**
   * Selected components that are only in the plan because another selected
   * component depends on them.
   *
   * Without this, a runtime pulled in as a dependency of a language server was
   * indistinguishable from one the user ticked, and the UI reported it as
   * already installed before anything had been downloaded.
   */
  private requiredBySelection(
    language: LanguageDefinition,
    selection: string[],
    state: Map<string, ComponentInstallState>,
  ): string[] {
    const byId = new Map(language.components.map((component) => [component.id, component]));
    const explicit = new Set(selection);
    const required = new Set<string>();
    const visit = (id: string, seen: Set<string>) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const dependency of byId.get(id)?.dependencies ?? []) {
        if (!byId.has(dependency)) continue;
        // Only components that are not installed yet are worth flagging: an
        // installed dependency is genuinely installed.
        if ((state.get(dependency) ?? "not-installed") !== "installed") required.add(dependency);
        visit(dependency, seen);
      }
    };
    for (const id of explicit) visit(id, new Set());
    return [...required].filter((id) => !explicit.has(id));
  }

  /** Raw declarative definition, for callers that need component metadata. */
  languageDefinition(languageId: string): LanguageDefinition | null {
    return this.languages.find((item) => item.id === languageId) ?? null;
  }

  /** Which language owns a managed package, if any (for the detail page). */
  languageForPackage(packageId: string): string | null {
    const owns = (language: LanguageDefinition) =>
      language.components.some((component) => component.packageId === packageId);
    // A language whose id matches the package wins over shared components.
    const exact = this.languages.find((language) => language.id === packageId && owns(language));
    if (exact) return exact.id;
    return this.languages.find(owns)?.id ?? null;
  }

  /** Component ids for a language, mapped to their managed package ids. */
  packageIdsFor(languageId: string): string[] {
    const language = this.languages.find((item) => item.id === languageId);
    return language ? language.components.map((component) => component.packageId) : [];
  }

  private componentInfo(component: LanguageDefinition["components"][number]): LanguageComponentInfo {
    const definition = this.packages.has(component.packageId)
      ? this.packages.get(component.packageId)
      : null;
    return {
      ...component,
      platforms: [...component.platforms],
      dependencies: component.dependencies ? [...component.dependencies] : undefined,
      capabilities: component.capabilities ? [...component.capabilities] : undefined,
      fileExtensions: component.fileExtensions ? [...component.fileExtensions] : undefined,
      installableVersion: definition?.installableVersion ?? "—",
      supported: Boolean(definition?.platforms.includes(this.platform as NodeJS.Platform)),
    };
  }

  private installedState(snapshot: VersionManagerSnapshot): Map<string, ComponentInstallState> {
    const byPackage = new Map(snapshot.packages.map((info) => [info.id, info]));
    const state = new Map<string, ComponentInstallState>();
    for (const language of this.languages) {
      for (const component of language.components) {
        const info = byPackage.get(component.packageId);
        if (!info) {
          state.set(component.id, "not-installed");
          continue;
        }
        state.set(component.id, this.mapState(info.state));
      }
    }
    return state;
  }

  private mapState(value: string): ComponentInstallState {
    switch (value) {
      case "installed":
      case "installing":
      case "uninstalling":
      case "corrupted":
      case "unknown":
        return value;
      default:
        return "not-installed";
    }
  }

  private defaultSelection(language: LanguageDefinition, _state: Map<string, ComponentInstallState>): string[] {
    // The declared default is the desired state. The real installed state is
    // used separately by the planner to compute what must change: if a default
    // component is missing, it appears in toInstall rather than being silently
    // dropped from the selection.
    return language.defaultSelection ? [...language.defaultSelection] : [];
  }
}
