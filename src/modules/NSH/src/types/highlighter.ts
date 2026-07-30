import { Token } from './token';

export interface HighlightOptions {
  theme?: string;
  lineNumbers?: boolean;
  language?: string;
  includeClasses?: boolean;
}

export interface HighlightResult {
  html: string;
  tokens: Token[];
}
