import { javascript } from "./javascript";
import { python } from "./python";
import type { LanguageDefinition } from "./types";

/** Built-in language definitions backed by real, verified Installer distributions. */
export const builtinLanguages: LanguageDefinition[] = [javascript, python];
