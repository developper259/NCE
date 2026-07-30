import { Token } from '../types/token';
import { LanguageDefinition } from '../types/language';

export class Tokenizer {
  private language: LanguageDefinition;

  constructor(language: LanguageDefinition) {
    this.language = language;
  }

  public tokenize(code: string): Token[] {
    const tokens: Token[] = [];
    const lines = code.split('\n');
    const tokenTypes = this.language.getTokenTypes();

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      let position = 0;
      let matched = false;

      while (position < line.length) {
        matched = false;

        for (const tokenType of tokenTypes) {
          const pattern = new RegExp(tokenType.pattern.source, tokenType.pattern.flags);
          pattern.lastIndex = position;
          const match = pattern.exec(line);

          if (match && match.index === position) {
            tokens.push({
              type: tokenType.name,
              value: match[0],
              line: lineIndex + 1,
              column: position + 1
            });
            position += match[0].length;
            matched = true;
            break;
          }
        }

        if (!matched) {
          position++;
        }
      }
    }

    return tokens;
  }

  public setLanguage(language: LanguageDefinition): void {
    this.language = language;
  }

  private matchToken(line: string, position: number): Token | null {
    return null;
  }

  private skipWhitespace(line: string, position: number): number {
    return position;
  }
}
