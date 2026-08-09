import { EmbeddedLanguageOptions } from "../types/embedLanguage";
import { TokenType } from "../types/token";

export function createEmbeddedStates(
  options: EmbeddedLanguageOptions,
): Record<string, TokenType[]> {
  const { language, exitRule, prefix } = options;

  const childStates =
    typeof language.getStates === "function"
      ? language.getStates()
      : { root: language.getTokenTypes() };

  const embeddedStates: Record<string, TokenType[]> = {};

  for (const [stateName, rules] of Object.entries(childStates)) {
    const prefixedStateName =
      stateName === "root" ? `${prefix}root` : `${prefix}${stateName}`;
    const stateRules: TokenType[] = [];

    if (stateName === "root") {
      stateRules.push({
        ...exitRule,
        pop: true,
      });
    }

    for (const rule of rules) {
      const clonedRule: TokenType = { ...rule };

      if (clonedRule.push) {
        clonedRule.push = `${prefix}${clonedRule.push}`;
      }

      stateRules.push(clonedRule);
    }

    embeddedStates[prefixedStateName] = stateRules;
  }

  return embeddedStates;
}
