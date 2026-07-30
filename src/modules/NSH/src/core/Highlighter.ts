import { Token } from '../types/token';
import { HighlightOptions, HighlightResult } from '../types/highlighter';
import { Tokenizer } from './Tokenizer';
import { LanguageDefinition } from '../types/language';
import { languages } from '../languages/Languages'

export class Highlighter {
  private tokenizer: Tokenizer;
  private themeName: string;
  private options: HighlightOptions;

  constructor(language: LanguageDefinition, options?: HighlightOptions) {
    this.tokenizer = new Tokenizer(language);
    this.themeName = options?.theme || 'dark';
    this.options = options || {};
  }

  public static getSupportedLanguages(): string[] {
    return Object.keys(languages);
  }

  public static detectLanguage(extension: string): string | undefined {
    const ext = extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`;

    for (const langKey in languages) {
      const lang = languages[langKey];
      
      if (lang.extensions && lang.extensions.map(e => e.toLowerCase()).includes(ext)) {
        return lang.name;
      }
    }

    return undefined;
  }

  public highlight(code: string): HighlightResult {
    let tokens = this.tokenizer.tokenize(code);
    const html = this.generateHTML(code, tokens);

    if (this.options.includeClasses) {
      tokens = this.replaceByClasses(tokens);
    }

    return {
      html,
      tokens
    };
  }

  public replaceByClasses(tokens: Token[]): Token[] {
    for (const token of tokens) {
      token.type = this.getCssClass(token.type);
    }
    return tokens;
  }

  public getToken(code: string): Token[] {
    return this.tokenizer.tokenize(code);
  }

  public getHTML(code: string): string {
    const tokens = this.tokenizer.tokenize(code);
    return this.generateHTML(code, tokens);
  }

  public setTheme(themeName: string): void {
    this.themeName = themeName;
  }

  public getThemeName(): string {
    return this.themeName;
  }

  public setLanguage(language: LanguageDefinition): void {
    this.tokenizer.setLanguage(language);
  }

  private generateHTML(code: string, tokens: Token[]): string {
    const lines = code.split('\n');
    const linesMap = new Map<number, Token[]>();

    for (const token of tokens) {
      if (!linesMap.has(token.line)) {
        linesMap.set(token.line, []);
      }
      linesMap.get(token.line)!.push(token);
    }

    let html = '<div class="nsh-highlighter">';

    for (let i = 0; i < lines.length; i++) {
      const lineNumber = i + 1;
      const line = lines[i];
      const lineTokens = linesMap.get(lineNumber) || [];

      html += '<div class="nsh-line">';

      if (this.options.lineNumbers) {
        html += `<span class="nsh-line-number">${lineNumber}</span>`;
      }

      let position = 0;
      let sortedTokens = [...lineTokens].sort((a, b) => a.column - b.column);

      for (const token of sortedTokens) {
        if (token.column > position + 1) {
          const plainText = line.substring(position, token.column - 1);
          html += this.escapeHtml(plainText);
          position = token.column - 1;
        }

        const className = this.getCssClass(token.type);
        html += `<span class="${className}">${this.escapeHtml(token.value)}</span>`;
        position = token.column - 1 + token.value.length;
      }

      if (position < line.length) {
        const plainText = line.substring(position);
        html += this.escapeHtml(plainText);
      }

      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  private getCssClass(tokenType: string): string {
    const classMap: { [key: string]: string } = {
      // Types de base
      keyword: 'nsh-keyword',
      string: 'nsh-string',
      number: 'nsh-number',
      comment: 'nsh-comment',
      function: 'nsh-function',
      variable: 'nsh-variable',
      operator: 'nsh-operator',
      bracket: 'nsh-bracket',
      
      // JavaScript/TypeScript spécifiques
      builtin: 'nsh-function',
      'template-expression': 'nsh-variable',
      regex: 'nsh-string',
      'arrow-function': 'nsh-operator',
      spread: 'nsh-operator',
      type: 'nsh-keyword',
      jsdoc: 'nsh-comment',
      'type-annotation': 'nsh-keyword',
      generic: 'nsh-keyword',
      'non-null': 'nsh-operator',
      'optional-chaining': 'nsh-operator',
      'jsx-tag': 'nsh-keyword',
      
      // Python spécifiques
      decorator: 'nsh-function',
      'fstring-expression': 'nsh-variable',
      docstring: 'nsh-comment',
      'type-hint': 'nsh-keyword',
      comparison: 'nsh-operator',
      assignment: 'nsh-operator',
      identity: 'nsh-operator',
      membership: 'nsh-operator',
      boolean: 'nsh-operator',
      walrus: 'nsh-operator',
      'special-variable': 'nsh-variable',
      
      // HTML spécifiques
      tag: 'nsh-keyword',
      doctype: 'nsh-keyword',
      'tag-open': 'nsh-keyword',
      'tag-close': 'nsh-keyword',
      'tag-selfclose': 'nsh-keyword',
      'tag-bracket': 'nsh-keyword',
      attribute: 'nsh-variable',
      'attribute-value': 'nsh-string',
      cdata: 'nsh-string',
      'processing-instruction': 'nsh-comment',
      'script-content': 'nsh-string',
      'style-content': 'nsh-string',
      entity: 'nsh-number',
      
      // CSS spécifiques
      selector: 'nsh-function',
      'selector-id': 'nsh-function',
      'selector-class': 'nsh-function',
      'selector-attribute': 'nsh-variable',
      'pseudo-class': 'nsh-keyword',
      'pseudo-element': 'nsh-keyword',
      property: 'nsh-keyword',
      value: 'nsh-string',
      color: 'nsh-number',
      'var-function': 'nsh-variable',
      'at-rule': 'nsh-keyword',
      important: 'nsh-keyword',
      combinator: 'nsh-operator'
    };

    return classMap[tokenType] || 'nsh-variable';
  }

  private escapeHtml(text: string): string {
    const htmlEscapes: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };

    return text.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
  }
}