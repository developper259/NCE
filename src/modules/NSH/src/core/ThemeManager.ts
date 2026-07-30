export class ThemeManager {
  private themes: Map<string, string>;

  constructor() {
    this.themes = new Map();
    this.loadBuiltinThemes();
  }

  public registerTheme(name: string, cssPath: string): void {
    this.themes.set(name, cssPath);
  }

  public getTheme(name: string): string | undefined {
    return this.themes.get(name);
  }

  public getThemeCSS(name: string): string {
    const cssPath = this.themes.get(name);
    return cssPath || '';
  }

  public listThemes(): string[] {
    return Array.from(this.themes.keys());
  }

  public removeTheme(name: string): boolean {
    return this.themes.delete(name);
  }

  private loadBuiltinThemes(): void {
    this.registerTheme('light', './themes/css/light.css');
    this.registerTheme('dark', './themes/css/dark.css');
  }
}
