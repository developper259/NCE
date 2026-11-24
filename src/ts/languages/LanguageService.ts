import type { PackageRegistry } from "../packages/PackageRegistry";
import type { VersionManagerSnapshot } from "../packages/types";
import { ComponentPlanner, type ComponentChangePlan, type ComponentInstallState } from "./ComponentPlanner";
import type { LanguageComponentInfo, LanguageDefinition, LanguageInfo } from "./types";

/** Renderer-facing view of a language, including the desired-state plan. */
export interface LanguageView extends LanguageInfo {
  plan: ComponentChangePlan;
  /** Ids currently checked in the UI (real state on first load). */
  selected: string[];
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
    };
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
