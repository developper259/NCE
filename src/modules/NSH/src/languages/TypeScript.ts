import { LanguageDefinition } from '../types/language';
import {
  createKeywordToken,
  createFunctionToken,
  createVariableToken,
  createCommentToken,
  createStringToken,
  createNumberToken,
  STRING_PATTERNS,
  NUMBER_PATTERNS,
  COMMENT_PATTERNS
} from './shared';

export class TypeScript implements LanguageDefinition {
  name = 'typescript';
  extensions = ['.ts', '.tsx'];

  // Keywords TypeScript (inclut JavaScript + spécifiques TS)
  private tsKeywords = [
    // JavaScript keywords
    'var', 'let', 'const', 'function', 'class', 'extends',
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
    'try', 'catch', 'finally', 'throw', 'error',
    'return', 'yield', 'async', 'await',
    'typeof', 'instanceof', 'in', 'of', 'delete', 'void',
    'this', 'super', 'new', 'constructor', 'static', 'get', 'set',
    'import', 'export', 'from', 'default', 'as',
    'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
    'with', 'debugger',
    // TypeScript spécifiques
    'interface', 'type', 'enum', 'namespace', 'module', 'declare',
    'implements', 'public', 'private', 'protected', 'readonly',
    'abstract', 'override', 'static',
    'as', 'is', 'keyof', 'infer', 'never', 'unknown',
    'satisfies', 'out', 'in', 'assert', 'const', 'require'
  ];

  // Types TypeScript primitifs et built-in
  private tsTypes = [
    // Types primitifs
    'string', 'number', 'boolean', 'bigint', 'symbol',
    'any', 'unknown', 'never', 'void',
    'null', 'undefined',
    // Types objets
    'object', 'Object', 'Function', 'Array',
    // Types utilitaires globaux
    'Array', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
    'Date', 'RegExp', 'Error', 'JSON',
    'Intl', 'Collator', 'DateTimeFormat', 'NumberFormat',
    // Types spéciaux TypeScript
    'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit',
    'Exclude', 'Extract', 'ReturnType', 'Parameters',
    'ThisType', 'Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize',
    'NonNullable', 'ConstructorParameters', 'InstanceType',
    'Infer', 'Awaited', 'Partial', 'Required'
  ];

  // Built-in TypeScript (hérité de JavaScript + spécifiques TS)
  private tsBuiltins = [
    // JavaScript built-ins
    'console', 'window', 'document', 'navigator', 'history', 'location', 'localStorage', 'sessionStorage',
    'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'ServiceWorker',
    'Math', 'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2',
    'JSON', 'parse', 'stringify',
    'Object', 'keys', 'values', 'entries', 'assign', 'freeze', 'seal', 'create', 'defineProperty',
    'Array', 'isArray', 'from', 'of', 'length', 'push', 'pop', 'shift', 'unshift', 'splice', 'slice',
    'String', 'charAt', 'charCodeAt', 'concat', 'indexOf', 'lastIndexOf', 'includes', 'startsWith',
    'Number', 'isNaN', 'isFinite', 'isInteger', 'isSafeInteger', 'parseFloat', 'parseInt',
    'Date', 'now', 'parse', 'UTC',
    'RegExp', 'test', 'exec',
    'Error', 'EvalError', 'InternalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError',
    'Promise', 'all', 'race', 'allSettled', 'any', 'resolve', 'reject',
    'Map', 'Set', 'WeakMap', 'WeakSet',
    'Proxy', 'Reflect', 'Symbol',
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
    'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
    'BigInt', 'asIntN', 'asUintN',
    'process', 'Buffer', 'require', 'module', 'exports', '__dirname', '__filename',
    // TypeScript spécifiques
    'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Record',
    'Exclude', 'Extract', 'ReturnType', 'Parameters', 'ConstructorParameters', 'InstanceType',
    'ThisParameterType', 'OmitThisParameter', 'Uppercase', 'Lowercase', 'Capitalize', 'Uncapitalize',
    'NonNullable', 'Infer', 'Awaited'
  ];

  tokenTypes = [
    // Keywords
    createKeywordToken(this.tsKeywords),
    // Types TypeScript
    {
      name: 'type',
      pattern: new RegExp(`\\b(${this.tsTypes.join('|')})\\b`, 'g'),
      className: 'nsh-keyword'
    },
    // Built-ins
    {
      name: 'builtin',
      pattern: new RegExp(`\\b(${this.tsBuiltins.join('|')})\\b`, 'g'),
      className: 'nsh-function'
    },
    // Strings
    createStringToken([STRING_PATTERNS.singleQuote, STRING_PATTERNS.doubleQuote, STRING_PATTERNS.backtick]),
    // Template literals expressions
    {
      name: 'template-expression',
      pattern: /\$\{[^}]*\}/g,
      className: 'nsh-variable'
    },
    // Numbers
    createNumberToken([
      NUMBER_PATTERNS.integer,
      NUMBER_PATTERNS.decimal,
      NUMBER_PATTERNS.hex,
      NUMBER_PATTERNS.binary,
      NUMBER_PATTERNS.octal,
      NUMBER_PATTERNS.scientific
    ]),
    // Comments
    createCommentToken(COMMENT_PATTERNS.multiLine.slashStar),
    createCommentToken(COMMENT_PATTERNS.singleLine.doubleSlash),
    // JSDoc comments
    {
      name: 'jsdoc',
      pattern: /\/\*\*[\s\S]*?\*\//g,
      className: 'nsh-comment'
    },
    // Regex literals
    {
      name: 'regex',
      pattern: /\/[^/\n\\]*(?:\\.[^/\n\\]*)*\/[gimuy]*/g,
      className: 'nsh-string'
    },
    // Type annotations
    {
      name: 'type-annotation',
      pattern: /:\s*([a-zA-Z0-9_<>[\]{}|,.\s]+)/g,
      className: 'nsh-keyword'
    },
    // Generic types
    {
      name: 'generic',
      pattern: /<[a-zA-Z0-9_,\s<>]+>/g,
      className: 'nsh-keyword'
    },
    // Functions
    createFunctionToken(),
    // Arrow functions
    {
      name: 'arrow-function',
      pattern: /=>/g,
      className: 'nsh-operator'
    },
    // Brackets 
    {
      name: 'bracket',
      pattern: /[\[\]\{\}\(\)]/g,
      className: 'nsh-bracket'
    },
    // Operators 
    {
      name: 'operator',
      pattern: /[+\-*/%=<>!&|^~?:;,.]/g,
      className: 'nsh-operator'
    },
    // Spread operator
    {
      name: 'spread',
      pattern: /\.\.\./g,
      className: 'nsh-operator'
    },
    // Non-null assertion
    {
      name: 'non-null',
      pattern: /!/g,
      className: 'nsh-operator'
    },
    // Optional chaining
    {
      name: 'optional-chaining',
      pattern: /\?\.?/g,
      className: 'nsh-operator'
    },
    // Variables
    createVariableToken(),
    // JSX (for .tsx files)
    {
      name: 'jsx-tag',
      pattern: /<\/?[a-zA-Z][a-zA-Z0-9]*/g,
      className: 'nsh-keyword'
    }
  ];

  comments = {
    singleLine: '//',
    multiLine: {
      start: '/*',
      end: '*/'
    }
  };

  strings = {
    startEnd: ['"', "'", '`'],
    escapeChar: '\\'
  };

  public getTokenTypes(): any[] {
    return this.tokenTypes;
  }
}
