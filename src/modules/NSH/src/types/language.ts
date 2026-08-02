import { TokenType } from './token';

export interface LanguageDefinition {
  name: string;
  extensions: string[];
  tokenTypes?: TokenType[];
  comments?: {
    singleLine?: string;
    multiLine?: {
      start: string;
      end: string;
    };
  };
  strings?: {
    startEnd: string[];
    escapeChar?: string;
  };
  getTokenTypes(): TokenType[];
  getStates(): Record<string, TokenType[]>;
}