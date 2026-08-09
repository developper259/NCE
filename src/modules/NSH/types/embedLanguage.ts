import { LanguageDefinition } from "./language";

export interface EmbeddedLanguageOptions {
  language: LanguageDefinition;
  exitRule: {
    name: string;
    pattern: RegExp;
    className: string;
  };
  prefix: string;
}
