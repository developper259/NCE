import { HighlightOptions } from "./highlighter";
import { Token } from "./token";

export interface HighlightRequest {
  id: string;
  requestType: 'highlight' | 'highlightLine' | 'supportedLanguages' | 'detectLanguage';

  code?: string;
  language?: string;
  responseType?: 'html' | 'tokens' | 'both';

  initialState?: string[];
  lineIndex?: number;

  ext?: string;
  path?: string;
  fileName?: string;

  options?: HighlightOptions;
}

export interface HighlightResponse {
  id: string;
  success: boolean;
  tokens?: Token[];
  html?: string;
  finalState?: string[];
  error?: string;
}

export interface DetectLanguageResponse {
  id: string;
  success: boolean;
  language?: string;
  error?: string;
}

export interface SupportedLanguageResponse {
  id: string;
  success: boolean;
  languages?: string[];
  error?: string;
}