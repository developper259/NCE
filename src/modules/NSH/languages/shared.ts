import { TokenType } from '../types/token';

// Token types communs à tous les langages
export const COMMON_TOKEN_TYPES: TokenType[] = [
  {
    name: 'string',
    pattern: /(["'`])(?:(?!\1)[^\\]|\\.)*\1/g,
    className: 'nsh-string'
  },
  {
    name: 'number',
    pattern: /\b\d+\.?\d*|\.\d+\b/g,
    className: 'nsh-number'
  },
  {
    name: 'operator',
    pattern: /[+\-*/%=<>!&|^~?:;,.]/g,
    className: 'nsh-operator'
  },
  {
    name: 'bracket',
    pattern: /[\[\]\{\}\(\)]/g,
    className: 'nsh-bracket'
  }
];

// Patterns de commentaires communs
export const COMMENT_PATTERNS = {
  singleLine: {
    hash: /#.*$/gm,
    doubleSlash: /\/\/.*$/gm,
    doubleDash: /--.*$/gm
  },
  multiLine: {
    slashStar: /\/\*[\s\S]*?\*\//g,
    dashDash: /<!--[\s\S]*?-->/g,
    braceStar: /\{#[\s\S]*?#\}/g
  }
};

// Patterns de strings communs
export const STRING_PATTERNS = {
  singleQuote: /'(?:[^'\\]|\\.)*'/g,
  doubleQuote: /"(?:[^"\\]|\\.)*"/g,
  backtick: /`(?:[^`\\]|\\.)*`/g,
  tripleSingle: /'''[\s\S]*?'''/g,
  tripleDouble: /"""[\s\S]*?"""/g
};

// Patterns de nombres communs
export const NUMBER_PATTERNS = {
  integer: /\b\d+\b/g,
  decimal: /\b\d+\.\d+\b/g,
  hex: /\b0x[0-9a-fA-F]+\b/g,
  binary: /\b0b[01]+\b/g,
  octal: /\b0o[0-7]+\b/g,
  scientific: /\b\d+\.?\d*[eE][+-]?\d+\b/g
};

// Keywords communs
export const COMMON_KEYWORDS = [
  'true', 'false', 'null', 'undefined', 'void',
  'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'break', 'continue', 'return', 'try',
  'catch', 'finally', 'throw', 'new', 'this',
  'class', 'extends', 'super', 'typeof', 'instanceof',
  'in', 'of', 'async', 'await', 'yield'
];

// Built-in functions communes
export const COMMON_BUILTINS = [
  'console', 'log', 'error', 'warn', 'info', 'debug',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Date', 'RegExp', 'Error', 'Promise',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect'
];

// Helpers pour créer des token types
export function createKeywordToken(keywords: string[]): TokenType {
  return {
    name: 'keyword',
    pattern: new RegExp(`\\b(${keywords.join('|')})\\b`, 'g'),
    className: 'nsh-keyword'
  };
}

export function createFunctionToken(): TokenType {
  return {
    name: 'function',
    pattern: /\b[a-zA-Z_$][a-zA-Z0-9_$]*\s*(?=\()/g,
    className: 'nsh-function'
  };
}

export function createVariableToken(): TokenType {
  return {
    name: 'variable',
    pattern: /\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g,
    className: 'nsh-variable'
  };
}

export function createCommentToken(pattern: RegExp): TokenType {
  return {
    name: 'comment',
    pattern,
    className: 'nsh-comment'
  };
}

export function createStringToken(patterns: RegExp[]): TokenType {
  return {
    name: 'string',
    pattern: new RegExp(patterns.map(p => p.source).join('|'), 'g'),
    className: 'nsh-string'
  };
}

export function createNumberToken(patterns: RegExp[]): TokenType {
  return {
    name: 'number',
    pattern: new RegExp(patterns.map(p => p.source).join('|'), 'g'),
    className: 'nsh-number'
  };
}
