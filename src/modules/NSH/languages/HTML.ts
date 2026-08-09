import { LanguageDefinition } from "../types/language";
import { TokenType } from "../types/token";
import { JavaScript } from "./JavaScript";
import { CSS } from "./CSS";
import { createEmbeddedStates } from "../utils/EmbedLanguage";
import {
  createStringToken,
  STRING_PATTERNS,
  createCommentToken,
  COMMENT_PATTERNS,
} from "./shared";

export class HTML implements LanguageDefinition {
  name = "html";
  extensions = [".html", ".htm"];

  private js = new JavaScript();
  private css = new CSS();

  public tokenTypes: TokenType[] = [
    { name: "doctype", pattern: /<!DOCTYPE[^>]*>/gi, className: "nsh-keyword" },
    {
      name: "tag-open",
      pattern: /<[a-zA-Z0-9_-]+/g,
      className: "nsh-keyword",
    },
    {
      name: "tag-close",
      pattern: /<\/[a-zA-Z0-9_-]+/g,
      className: "nsh-keyword",
    },
    { name: "tag-selfclose", pattern: /\/>/g, className: "nsh-keyword" },
    { name: "tag-bracket", pattern: />/g, className: "nsh-keyword" },
    createStringToken([
      STRING_PATTERNS.doubleQuote,
      STRING_PATTERNS.singleQuote,
    ]),
    {
      name: "attribute",
      pattern: /[a-zA-Z0-9_-]+(?=\s*=)/g,
      className: "nsh-variable",
    },
    {
      name: "operator",
      pattern: /=/g,
      className: "nsh-operator",
    },
    {
      name: "attribute-value",
      pattern: /(?<==\s*)[^\s"'<>=]+/g,
      className: "nsh-string",
    },
    // Catch-all attribut booléen (required, disabled, checked...)
    {
      name: "attribute",
      pattern: /[a-zA-Z0-9_-]+/g,
      className: "nsh-variable",
    },
    createCommentToken(COMMENT_PATTERNS.multiLine.dashDash),
    {
      name: "cdata",
      pattern: /<!\[CDATA\[[\s\S]*?\]\]>/g,
      className: "nsh-string",
    },
    { name: "entity", pattern: /&[a-zA-Z0-9#]+;/g, className: "nsh-number" },
    {
      name: "processing-instruction",
      pattern: /<\?[\s\S]*?\?>/g,
      className: "nsh-comment",
    },
  ];

  public getTokenTypes(): TokenType[] {
    return this.tokenTypes;
  }

  public getStates(): Record<string, TokenType[]> {
    const jsStates = createEmbeddedStates({
      language: this.js,
      exitRule: {
        name: "script-end",
        pattern: /<\/script\s*>/gi,
        className: "nsh-keyword",
      },
      prefix: "js_",
    });

    const cssStates = createEmbeddedStates({
      language: this.css,
      exitRule: {
        name: "style-end",
        pattern: /<\/style\s*>/gi,
        className: "nsh-keyword",
      },
      prefix: "css_",
    });

    const tagAttributeRules: TokenType[] = [
      {
        name: "string",
        pattern: /"/g,
        className: "nsh-string",
        push: "inDoubleQuote",
      },
      {
        name: "string",
        pattern: /'/g,
        className: "nsh-string",
        push: "inSingleQuote",
      },
      {
        name: "attribute",
        pattern: /[a-zA-Z0-9_-]+(?=\s*=)/g,
        className: "nsh-variable",
      },
      {
        name: "operator",
        pattern: /=/g,
        className: "nsh-operator",
      },
      {
        name: "attribute-value",
        pattern: /(?<==\s*)[^\s"'<>=]+/g,
        className: "nsh-string",
      },
      {
        name: "attribute",
        pattern: /[a-zA-Z0-9_-]+/g,
        className: "nsh-variable",
      },
    ];

    return {
      root: [
        {
          name: "doctype",
          pattern: /<!DOCTYPE[^>]*>/gi,
          className: "nsh-keyword",
        },
        {
          name: "comment",
          pattern: /<!--/g,
          className: "nsh-comment",
          push: "inComment",
        },
        {
          name: "cdata",
          pattern: /<!\[CDATA\[/g,
          className: "nsh-string",
          push: "inCdata",
        },
        {
          name: "script-start",
          pattern: /<script\b/gi,
          className: "nsh-keyword",
          push: "inScriptTag",
        },
        {
          name: "style-start",
          pattern: /<style\b/gi,
          className: "nsh-keyword",
          push: "inStyleTag",
        },
        {
          name: "tag-close",
          pattern: /<\/[a-zA-Z0-9_-]+/g,
          className: "nsh-keyword",
          push: "inTag",
        },
        {
          name: "tag-open",
          pattern: /<[a-zA-Z0-9_-]+/g,
          className: "nsh-keyword",
          push: "inTag",
        },
        {
          name: "entity",
          pattern: /&[a-zA-Z0-9#]+;/g,
          className: "nsh-number",
        },
        {
          name: "processing-instruction",
          pattern: /<\?/g,
          className: "nsh-comment",
          push: "inProcessing",
        },
      ],

      inTag: [
        {
          name: "tag-selfclose",
          pattern: /\/>/g,
          className: "nsh-keyword",
          pop: true,
        },
        {
          name: "tag-bracket",
          pattern: />/g,
          className: "nsh-keyword",
          pop: true,
        },
        ...tagAttributeRules,
      ],

      inScriptTag: [
        {
          name: "tag-selfclose",
          pattern: /\/>/g,
          className: "nsh-keyword",
          pop: true,
        },
        {
          name: "tag-bracket",
          pattern: />/g,
          className: "nsh-keyword",
          pop: true,
          push: "js_root",
        },
        ...tagAttributeRules,
      ],

      inStyleTag: [
        {
          name: "tag-selfclose",
          pattern: /\/>/g,
          className: "nsh-keyword",
          pop: true,
        },
        {
          name: "tag-bracket",
          pattern: />/g,
          className: "nsh-keyword",
          pop: true,
          push: "css_root",
        },
        ...tagAttributeRules,
      ],

      inDoubleQuote: [
        {
          name: "string",
          pattern: /"/g,
          className: "nsh-string",
          pop: true,
        },
        {
          name: "string",
          pattern: /(?:(?!"|<\?php\b|<\?=).)+/g,
          className: "nsh-string",
        },
      ],
      inSingleQuote: [
        {
          name: "string",
          pattern: /'/g,
          className: "nsh-string",
          pop: true,
        },
        {
          name: "string",
          pattern: /(?:(?!'|<\?php\b|<\?=).)+/g,
          className: "nsh-string",
        },
      ],

      inComment: [
        {
          name: "comment",
          pattern: /-->/g,
          className: "nsh-comment",
          pop: true,
        },
        {
          name: "comment",
          pattern: /(?:(?!-->).)+/g,
          className: "nsh-comment",
        },
      ],
      inCdata: [
        {
          name: "cdata",
          pattern: /\]\]>/g,
          className: "nsh-string",
          pop: true,
        },
        { name: "cdata", pattern: /(?:(?!\]\]>).)+/g, className: "nsh-string" },
      ],
      inProcessing: [
        {
          name: "processing-instruction",
          pattern: /\?>/g,
          className: "nsh-comment",
          pop: true,
        },
        {
          name: "processing-instruction",
          pattern: /(?:(?!\?>).)+/g,
          className: "nsh-comment",
        },
      ],

      ...jsStates,
      ...cssStates,
    };
  }

  comments = { multiLine: { start: "<!--", end: "-->" } };
  strings = { startEnd: ['"', "'"], escapeChar: "\\" };
}
