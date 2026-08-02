import { LanguageDefinition } from "../types/language";
import { TokenType } from "../types/token";
import {
  createStringToken,
  STRING_PATTERNS,
  createCommentToken,
  COMMENT_PATTERNS,
} from "./shared";

export class HTML implements LanguageDefinition {
  name = "html";
  extensions = [".html", ".htm"];

  public tokenTypes: TokenType[] = [
    { name: "doctype", pattern: /<!DOCTYPE[^>]*>/gi, className: "nsh-keyword" },
    {
      name: "tag-open",
      pattern: /<[a-zA-Z][a-zA-Z0-9]*/g,
      className: "nsh-keyword",
    },
    {
      name: "tag-close",
      pattern: /<\/[a-zA-Z][a-zA-Z0-9]*/g,
      className: "nsh-keyword",
    },
    { name: "tag-selfclose", pattern: /\/>/g, className: "nsh-keyword" },
    { name: "tag-bracket", pattern: />/g, className: "nsh-keyword" },
    {
      name: "attribute",
      pattern: /\s[a-zA-Z-]+(?==)/g,
      className: "nsh-variable",
    },
    createStringToken([
      STRING_PATTERNS.doubleQuote,
      STRING_PATTERNS.singleQuote,
    ]),
    {
      name: "attribute-value",
      pattern: /=\s*[^\s"'>]+/g,
      className: "nsh-string",
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
    {
      name: "script-content",
      pattern: /<script[^>]*>[\s\S]*?<\/script>/gi,
      className: "nsh-string",
    },
    {
      name: "style-content",
      pattern: /<style[^>]*>[\s\S]*?<\/style>/gi,
      className: "nsh-string",
    },
  ];

  public getTokenTypes(): TokenType[] {
    return this.tokenTypes;
  }

  public getStates(): Record<string, TokenType[]> {
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
          pattern: /<script[^>]*>/gi,
          className: "nsh-keyword",
          push: "inScript",
        },
        {
          name: "style-start",
          pattern: /<style[^>]*>/gi,
          className: "nsh-keyword",
          push: "inStyle",
        },
        {
          name: "tag-open",
          pattern: /<[a-zA-Z][a-zA-Z0-9]*/g,
          className: "nsh-keyword",
        },
        {
          name: "tag-close",
          pattern: /<\/[a-zA-Z][a-zA-Z0-9]*/g,
          className: "nsh-keyword",
        },
        { name: "tag-selfclose", pattern: /\/>/g, className: "nsh-keyword" },
        { name: "tag-bracket", pattern: />/g, className: "nsh-keyword" },
        {
          name: "attribute",
          pattern: /\s[a-zA-Z-]+(?==)/g,
          className: "nsh-variable",
        },
        createStringToken([
          STRING_PATTERNS.doubleQuote,
          STRING_PATTERNS.singleQuote,
        ]),
        {
          name: "attribute-value",
          pattern: /=\s*[^\s"'>]+/g,
          className: "nsh-string",
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
      inComment: [
        {
          name: "comment",
          pattern: /-->/g,
          className: "nsh-comment",
          pop: true,
        },
        { name: "comment", pattern: /(?:(?!-->).)+/g, className: "nsh-comment" },
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
      inScript: [
        {
          name: "script-end",
          pattern: /<\/script>/gi,
          className: "nsh-keyword",
          pop: true,
        },
        { name: "script-content", pattern: /(?:(?!<\/script>).)+/gi, className: "nsh-string" },
      ],
      inStyle: [
        {
          name: "style-end",
          pattern: /<\/style>/gi,
          className: "nsh-keyword",
          pop: true,
        },
        { name: "style-content", pattern: /(?:(?!<\/style>).)+/gi, className: "nsh-string" },
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
    };
  }

  comments = { multiLine: { start: "<!--", end: "-->" } };
  strings = { startEnd: ['"', "'"], escapeChar: "\\" };
}