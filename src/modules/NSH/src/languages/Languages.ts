import { LanguageDefinition } from '../types/language';
import { JavaScript } from './JavaScript';
import { TypeScript } from './TypeScript';
import { Python } from './Python';
import { HTML } from './HTML';
import { CSS } from './CSS';

export const languages: Record<string, LanguageDefinition> = {
  javascript: new JavaScript(),
  typescript: new TypeScript(),
  python: new Python(),
  html: new HTML(),
  css: new CSS()
};