import { HighlightOptions } from "./highlighter";
import { Token } from "./token";

export interface HighlightRequest {
  id: string;
  requestType: 'highlight' | 'supportedLanguages' | 'detectLanguage';

  //highlight
  code?: string;
  language?: string;
  responseType?: 'html' | 'tokens' | 'both';

  //detectLanguage
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