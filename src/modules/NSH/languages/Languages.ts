import { LanguageDefinition } from '../types/language';
import { JavaScript } from './JavaScript';
import { TypeScript } from './TypeScript';
import { Python } from './Python';
import { HTML } from './HTML';
import { CSS } from './CSS';
import { Json } from './JSON';
import { Yaml } from './YAML';
import { PHP } from './PHP';

export const languages: Record<string, LanguageDefinition> = {
  javascript: new JavaScript(),
  typescript: new TypeScript(),
  python: new Python(),
  html: new HTML(),
  css: new CSS(),
  json: new Json(),
  yaml: new Yaml(),
  php: new PHP()
};