import { Token } from '../types/token';

export interface ParsedLine {
  lineNumber: number;
  tokens: Token[];
}

export interface ParsedCode {
  lines: ParsedLine[];
  totalLines: number;
}

export class Parser {
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  public parse(): ParsedCode {
    const linesMap = new Map<number, Token[]>();

    for (const token of this.tokens) {
      if (!linesMap.has(token.line)) {
        linesMap.set(token.line, []);
      }
      linesMap.get(token.line)!.push(token);
    }

    const lines: ParsedLine[] = [];
    const totalLines = Math.max(...Array.from(linesMap.keys()), 0);

    for (let i = 1; i <= totalLines; i++) {
      lines.push({
        lineNumber: i,
        tokens: linesMap.get(i) || []
      });
    }

    return {
      lines,
      totalLines
    };
  }

  public setTokens(tokens: Token[]): void {
    this.tokens = tokens;
  }

  private parseStatement(): any {
    return null;
  }

  private parseExpression(): any {
    return null;
  }
}
