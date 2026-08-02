import { Token } from "../types/token";
import { LanguageDefinition } from "../types/language";

export class Tokenizer {
  private language: LanguageDefinition;

  private static readonly DEFAULT_STATE: string[] = ["root"];

  constructor(language: LanguageDefinition) {
    this.language = language;
  }

  public tokenize(code: string): Token[] {
    return this.tokenizeWithState(code).tokens;
  }

  public tokenizeWithState(
    code: string,
    initialStateStack: string[] = Tokenizer.DEFAULT_STATE,
  ): { tokens: Token[]; finalStateStack: string[] } {
    const lines = code.split("\n");
    let currentState: string[] =
      initialStateStack && initialStateStack.length > 0
        ? [...initialStateStack]
        : [...Tokenizer.DEFAULT_STATE];
    let allTokens: Token[] = [];

    for (let i = 0; i < lines.length; i++) {
      const result = this.tokenizeLine(lines[i], currentState, i);
      allTokens.push(...result.tokens);
      currentState = result.finalStateStack;
    }
    return { tokens: allTokens, finalStateStack: currentState };
  }

  public tokenizeLine(
    line: string,
    initialStateStack: string[],
    lineIndex: number,
  ): { tokens: Token[]; finalStateStack: string[] } {
    const tokens: Token[] = [];
    const states =
      typeof this.language.getStates === "function"
        ? this.language.getStates()
        : { root: this.language.getTokenTypes() };

    const stateStack =
      initialStateStack && initialStateStack.length > 0
        ? [...initialStateStack]
        : [...Tokenizer.DEFAULT_STATE];
    let position = 0;

    while (position < line.length) {
      const currentState = stateStack[stateStack.length - 1];
      const currentRules = states[currentState] || states["root"] || [];
      let matched = false;

      for (const rule of currentRules) {
        rule.pattern.lastIndex = position;
        const match = rule.pattern.exec(line);

        if (match && match.index === position) {
          if (match[0].length === 0) continue;

          tokens.push({
            type: rule.name,
            value: match[0],
            line: lineIndex + 1,
            column: position + 1,
          });

          position += match[0].length;
          matched = true;

          if (rule.pop && stateStack.length > 1) {
            stateStack.pop();
          }
          if (rule.push) {
            stateStack.push(rule.push);
          }

          break;
        }
      }

      if (!matched) {
        position++;
      }
    }

    return { tokens, finalStateStack: stateStack };
  }

  public setLanguage(language: LanguageDefinition): void {
    this.language = language;
  }
}