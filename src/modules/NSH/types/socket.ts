import { HighlightOptions } from "./highlighter";
import { Token } from "./token";

export interface HighlightRequest {
  id: string;
  requestType: 'highlight' | 'highlightLine' | 'supportedLanguages' | 'detectLanguage';

  // highlight (code complet) ET highlightLine (une seule ligne) :
  // pour highlightLine, `code` contient le texte de la ligne à tokenizer.
  code?: string;
  language?: string;
  responseType?: 'html' | 'tokens' | 'both';

  // highlightLine uniquement :
  // `initialState` = pile de states renvoyée par le `finalState` de la requête
  // précédente (ou omis / [] pour la toute première ligne du fichier).
  // `lineIndex` = index (0-based) de la ligne, utilisé pour numéroter les tokens.
  initialState?: string[];
  lineIndex?: number;

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