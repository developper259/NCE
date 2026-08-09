import { LanguageDefinition } from "../types/language";
import { TokenType } from "../types/token";
import { HTML } from "./HTML";
import { createEmbeddedStates } from "../utils/EmbedLanguage";
import {
  createKeywordToken,
  createStringToken,
  createNumberToken,
  createCommentToken,
  STRING_PATTERNS,
  NUMBER_PATTERNS,
  COMMENT_PATTERNS,
} from "./shared";

class PHPCode implements LanguageDefinition {
  name = "php-code";
  extensions: string[] = [];

  private phpKeywords = [
    "abstract",
    "and",
    "array",
    "as",
    "break",
    "callable",
    "case",
    "catch",
    "class",
    "clone",
    "const",
    "continue",
    "declare",
    "default",
    "do",
    "echo",
    "else",
    "elseif",
    "empty",
    "enddeclare",
    "endfor",
    "endforeach",
    "endif",
    "endswitch",
    "endwhile",
    "enum",
    "extends",
    "final",
    "finally",
    "fn",
    "for",
    "foreach",
    "function",
    "global",
    "goto",
    "if",
    "implements",
    "include",
    "include_once",
    "instanceof",
    "insteadof",
    "interface",
    "isset",
    "list",
    "match",
    "namespace",
    "new",
    "or",
    "print",
    "private",
    "protected",
    "public",
    "readonly",
    "require",
    "require_once",
    "return",
    "static",
    "switch",
    "throw",
    "trait",
    "try",
    "unset",
    "use",
    "var",
    "while",
    "xor",
    "yield",
    "true",
    "false",
    "null",
    "self",
    "parent",
    "this",
  ];

  private phpBuiltins = [
    "strlen",
    "strpos",
    "str_replace",
    "str_split",
    "substr",
    "trim",
    "ltrim",
    "rtrim",
    "explode",
    "implode",
    "sprintf",
    "printf",
    "number_format",
    "array_map",
    "array_filter",
    "array_reduce",
    "array_merge",
    "array_keys",
    "array_values",
    "array_push",
    "array_pop",
    "array_shift",
    "array_unshift",
    "in_array",
    "count",
    "sort",
    "usort",
    "ksort",
    "asort",
    "is_array",
    "is_string",
    "is_int",
    "is_numeric",
    "is_bool",
    "is_null",
    "var_dump",
    "print_r",
    "json_encode",
    "json_decode",
    "file_get_contents",
    "file_put_contents",
    "fopen",
    "fclose",
    "fread",
    "fwrite",
    "preg_match",
    "preg_replace",
    "preg_split",
    "date",
    "time",
    "strtotime",
    "mktime",
    "header",
    "session_start",
    "htmlspecialchars",
    "htmlentities",
    "urlencode",
    "urldecode",
    "base64_encode",
    "base64_decode",
    "md5",
    "sha1",
    "rand",
    "mt_rand",
    "min",
    "max",
    "abs",
    "round",
    "floor",
    "ceil",
    "pow",
    "sqrt",
    "intval",
    "floatval",
    "strval",
    "boolval",
    "gettype",
    "settype",
    "define",
    "defined",
    "function_exists",
    "class_exists",
    "method_exists",
    "property_exists",
    "get_class",
    "call_user_func",
    "call_user_func_array",
  ];

  public tokenTypes: TokenType[] = [
    createKeywordToken(this.phpKeywords),
    {
      name: "builtin",
      pattern: new RegExp(`\\b(${this.phpBuiltins.join("|")})\\b`, "g"),
      className: "nsh-function",
    },
    createStringToken([
      STRING_PATTERNS.singleQuote,
      STRING_PATTERNS.doubleQuote,
    ]),
    createNumberToken([
      NUMBER_PATTERNS.integer,
      NUMBER_PATTERNS.decimal,
      NUMBER_PATTERNS.hex,
      NUMBER_PATTERNS.binary,
      NUMBER_PATTERNS.octal,
      NUMBER_PATTERNS.scientific,
    ]),
    createCommentToken(COMMENT_PATTERNS.multiLine.slashStar),
    createCommentToken(COMMENT_PATTERNS.singleLine.doubleSlash),
    { name: "comment", pattern: /#.*/g, className: "nsh-comment" },
    {
      name: "variable",
      pattern: /\$[a-zA-Z_][a-zA-Z0-9_]*/g,
      className: "nsh-variable",
    },
    {
      name: "function",
      pattern: /[a-zA-Z_][a-zA-Z0-9_]*(?=\s*\()/g,
      className: "nsh-function",
    },
    { name: "object-operator", pattern: /->|\?->/g, className: "nsh-operator" },
    { name: "scope-resolution", pattern: /::/g, className: "nsh-operator" },
    { name: "namespace-separator", pattern: /\\/g, className: "nsh-operator" },
    { name: "arrow-function", pattern: /=>/g, className: "nsh-operator" },
    { name: "bracket", pattern: /[\[\]\{\}\(\)]/g, className: "nsh-bracket" },
    {
      name: "operator",
      pattern: /[+\-*/%=<>!&|^~?:;,.@]/g,
      className: "nsh-operator",
    },
    {
      name: "class-name",
      pattern: /[a-zA-Z_][a-zA-Z0-9_]*/g,
      className: "nsh-variable",
    },
  ];

  public getTokenTypes(): TokenType[] {
    return this.tokenTypes;
  }

  public getStates(): Record<string, TokenType[]> {
    return {
      root: this.tokenTypes,
    };
  }

  comments = { singleLine: "//", multiLine: { start: "/*", end: "*/" } };
  strings = { startEnd: ['"', "'"], escapeChar: "\\" };
}

export class PHP implements LanguageDefinition {
  name = "php";
  extensions = [".php", ".phtml", ".php3", ".php4", ".php5"];

  private html = new HTML();
  private phpCode = new PHPCode();

  public tokenTypes: TokenType[] = [
    {
      name: "php-open",
      pattern: /<\?php\b|<\?=/gi,
      className: "nsh-keyword",
    },
    { name: "php-close", pattern: /\?>/g, className: "nsh-keyword" },
    ...this.phpCode.tokenTypes,
    ...this.html.getTokenTypes(),
  ];

  public getTokenTypes(): TokenType[] {
    return this.tokenTypes;
  }

  public getStates(): Record<string, TokenType[]> {
    const phpStates = createEmbeddedStates({
      language: this.phpCode,
      exitRule: {
        name: "php-close",
        pattern: /\?>/g,
        className: "nsh-keyword",
      },
      prefix: "php_",
    });

    const phpOpenRule: TokenType = {
      name: "php-open",
      pattern: /<\?php\b|<\?=/gi,
      className: "nsh-keyword",
      push: "php_root",
    };

    const htmlStates = this.html.getStates();

    const statesWithPhpEntry = new Set([
      "root",
      "js_root",
      "css_root",
      "inTag",
      "inScriptTag",
      "inStyleTag",
      "inDoubleQuote",
      "inSingleQuote",
      "inComment",
    ]);

    const mergedHtmlStates: Record<string, TokenType[]> = {};
    for (const [stateName, rules] of Object.entries(htmlStates)) {
      mergedHtmlStates[stateName] = statesWithPhpEntry.has(stateName)
        ? [phpOpenRule, ...rules]
        : rules;
    }

    return {
      ...mergedHtmlStates,
      ...phpStates,
    };
  }

  comments = { singleLine: "//", multiLine: { start: "/*", end: "*/" } };
  strings = { startEnd: ['"', "'"], escapeChar: "\\" };
}
