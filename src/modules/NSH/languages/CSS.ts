import { LanguageDefinition } from "../types/language";
import { TokenType } from "../types/token";
import { createStringToken, STRING_PATTERNS } from "./shared";

export class CSS implements LanguageDefinition {
  name = "css";
  extensions = [".css", ".scss", ".sass"];

  private htmlTags = [
    "a",
    "abbr",
    "address",
    "area",
    "article",
    "aside",
    "audio",
    "b",
    "base",
    "bdi",
    "bdo",
    "blockquote",
    "body",
    "br",
    "button",
    "canvas",
    "caption",
    "cite",
    "code",
    "col",
    "colgroup",
    "data",
    "datalist",
    "dd",
    "del",
    "details",
    "dfn",
    "dialog",
    "div",
    "dl",
    "dt",
    "em",
    "embed",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hgroup",
    "hr",
    "html",
    "i",
    "iframe",
    "img",
    "input",
    "ins",
    "kbd",
    "label",
    "legend",
    "li",
    "link",
    "main",
    "map",
    "mark",
    "menu",
    "meta",
    "meter",
    "nav",
    "noscript",
    "object",
    "ol",
    "optgroup",
    "option",
    "output",
    "p",
    "picture",
    "pre",
    "progress",
    "q",
    "rp",
    "rt",
    "ruby",
    "s",
    "samp",
    "script",
    "section",
    "select",
    "slot",
    "small",
    "source",
    "span",
    "strong",
    "style",
    "sub",
    "summary",
    "sup",
    "svg",
    "table",
    "tbody",
    "td",
    "template",
    "textarea",
    "tfoot",
    "th",
    "thead",
    "time",
    "title",
    "tr",
    "track",
    "u",
    "ul",
    "var",
    "video",
    "wbr",
    "path",
    "g",
    "circle",
    "rect",
    "line",
    "polyline",
    "polygon",
  ];

  private pseudoClassPattern =
    /:{1,2}(?:hover|active|focus|focus-within|focus-visible|visited|link|target|checked|disabled|enabled|required|optional|valid|invalid|root|empty|first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|nth-child|nth-last-child|nth-of-type|nth-last-of-type|not|is|where|has|placeholder-shown|read-only|read-write|fullscreen|before|after|first-letter|first-line|selection|placeholder|marker|backdrop)\b/;

  public tokenTypes: TokenType[] = [
    { name: "comment", pattern: /\/\*[\s\S]*?\*\//g, className: "nsh-comment" },
    createStringToken([
      STRING_PATTERNS.doubleQuote,
      STRING_PATTERNS.singleQuote,
    ]),
    { name: "at-rule", pattern: /@[a-zA-Z0-9_-]+/g, className: "nsh-keyword" },
    {
      name: "variable",
      pattern: /--[a-zA-Z0-9_-]+/g,
      className: "nsh-variable",
    },
    {
      name: "function",
      pattern: /[a-zA-Z0-9_-]+(?=\()/g,
      className: "nsh-function",
    },
    {
      name: "hex-color",
      pattern: /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g,
      className: "nsh-number",
    },
    {
      name: "pseudo-class",
      pattern: new RegExp(this.pseudoClassPattern, "g"),
      className: "nsh-keyword",
    },
    {
      name: "property",
      pattern: /(?!\d)[a-zA-Z0-9_-]+(?=\s*:)/g,
      className: "nsh-keyword",
    },
    {
      name: "number",
      pattern:
        /\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|vmin|vmax|%|s|ms|deg|rad|turn|hz|khz|dpi|dpcm|dppx|fr|ch|ex)?\b/g,
      className: "nsh-number",
    },
    {
      name: "selector-tag",
      pattern: new RegExp(`\\b(?:${this.htmlTags.join("|")})\\b`, "g"),
      className: "nsh-function",
    },
    {
      name: "selector-class",
      pattern: /\.[a-zA-Z0-9_-]+/g,
      className: "nsh-function",
    },
    {
      name: "selector-id",
      pattern: /#[a-zA-Z0-9_-]+/g,
      className: "nsh-function",
    },
    {
      name: "value-identifier",
      pattern: /[a-zA-Z_-][a-zA-Z0-9_-]*/g,
      className: "nsh-string",
    },
    { name: "operator", pattern: /[{}():;,>~+*|]/g, className: "nsh-operator" },
  ];

  public getTokenTypes(): TokenType[] {
    return this.tokenTypes;
  }

  public getStates(): Record<string, TokenType[]> {
    return {
      root: [
        {
          name: "comment",
          pattern: /\/\*/g,
          className: "nsh-comment",
          push: "inMultiLineComment",
        },
        ...this.tokenTypes,
      ],
      inMultiLineComment: [
        {
          name: "comment",
          pattern: /\*\//g,
          className: "nsh-comment",
          pop: true,
        },
        { name: "comment", pattern: /(?:(?!\*\/).)+/g, className: "nsh-comment" },
      ],
    };
  }

  comments = { multiLine: { start: "/*", end: "*/" } };
  strings = { startEnd: ['"', "'"], escapeChar: "\\" };
}