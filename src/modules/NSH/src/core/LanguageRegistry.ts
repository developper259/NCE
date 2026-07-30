import { LanguageDefinition } from '../types/language';

export class LanguageRegistry {
  private languages: Map<string, LanguageDefinition>;

  constructor() {
    this.languages = new Map();
  }

  public registerLanguage(language: LanguageDefinition): void {
    this.languages.set(language.name, language);
  }

  public getLanguage(name: string): LanguageDefinition | undefined {
    return this.languages.get(name);
  }

  public getLanguageByExtension(extension: string): LanguageDefinition | undefined {
    for (const language of this.languages.values()) {
      if (language.extensions.includes(extension)) {
        return language;
      }
    }
    return undefined;
  }

  public listLanguages(): string[] {
    return Array.from(this.languages.keys());
  }
}
