import { javascript } from "./javascript";
import { python } from "./python";
import { typescript } from "./typescript";
import type { LanguageDefinition } from "./types";

/** Built-in language definitions backed by real, verified Installer distributions. */
export const builtinLanguages: LanguageDefinition[] = [javascript, typescript, python];
