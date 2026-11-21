import type { LanguageDefinition } from "./types";

/**
 * Built-in language definitions. Python and JavaScript/TypeScript are added in
 * their respective implementation steps, once real Installer distributions and
 * checksums exist. Keeping this list empty until then avoids advertising
 * components that cannot actually be installed.
 */
export const builtinLanguages: LanguageDefinition[] = [];
