export interface Token {
  type: string;
  value: string;
  line: number;
  column: number;
}

export interface TokenType {
  name: string;
  pattern: RegExp;
  className?: string;
}
