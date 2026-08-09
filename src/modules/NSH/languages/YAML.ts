import { LanguageDefinition } from "../types/language";
import { TokenType } from "../types/token";
import {
  createKeywordToken,
  createStringToken,
  createNumberToken,
  STRING_PATTERNS,
  NUMBER_PATTERNS,
} from "./shared";

export class Yaml implements LanguageDefinition {
  name = "yaml";
  extensions = [".yml", ".yaml"];

  private yamlKeywords = ["true", "false", "null", "yes", "no", "on", "off"];

  public tokenTypes: TokenType[] = [
    {
      name: "comment",
      pattern: /#.*/g,
      className: "nsh-comment",
    },
    createStringToken([
      STRING_PATTERNS.doubleQuote,
      STRING_PATTERNS.singleQuote,
    ]),
    createKeywordToken(this.yamlKeywords),
    createNumberToken([NUMBER_PATTERNS.integer, NUMBER_PATTERNS.decimal]),
    {
      name: "yaml-key",
      pattern: /[a-zA-ZÀ-ÿ0-9_-]+(?=\s*:)/g,
      className: "nsh-variable",
    },
    {
      name: "yaml-value",
      pattern: /[a-zA-ZÀ-ÿ_-][a-zA-ZÀ-ÿ0-9_-]*(?!\s*:)/g,
      className: "nsh-string",
    },
    {
      name: "operator",
      pattern: /[:\-|>]/g,
      className: "nsh-operator",
    },
  ];

  public getTokenTypes(): TokenType[] {
    return this.tokenTypes;
  }

  public getStates(): Record<string, TokenType[]> {
    return {
      root: this.tokenTypes,
    };
  }

  comments = { singleLine: "#" };
  strings = { startEnd: ['"', "'"], escapeChar: "\\" };
}
