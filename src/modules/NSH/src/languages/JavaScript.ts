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

export class JavaScript implements LanguageDefinition {
  name = 'javascript';
  extensions = ['.js', '.jsx', '.mjs'];

  // Keywords JavaScript complets
  private jsKeywords = [
    // Variables et déclarations
    'var', 'let', 'const', 'function', 'class', 'extends',
    // Structures de contrôle
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
    // Exceptions
    'try', 'catch', 'finally', 'throw', 'error',
    // Fonctions et portée
    'return', 'yield', 'async', 'await',
    // Opérateurs et types
    'typeof', 'instanceof', 'in', 'of', 'delete', 'void',
    // Objets et classes
    'this', 'super', 'new', 'constructor', 'static', 'get', 'set',
    // Modules
    'import', 'export', 'from', 'default', 'as',
    // Valeurs primitives
    'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
    // Autres
    'with', 'debugger'
  ];

  // Built-in objects et functions
  private jsBuiltins = [
    // Global objects
    'console', 'window', 'document', 'navigator', 'history', 'location', 'localStorage', 'sessionStorage',
    'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'ServiceWorker',
    // Math
    'Math', 'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2',
    'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh', 'cbrt', 'ceil', 'clz32',
    'cos', 'cosh', 'exp', 'expm1', 'floor', 'fround', 'hypot', 'imul', 'log', 'log10', 'log1p', 'log2',
    'max', 'min', 'pow', 'random', 'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh', 'trunc',
    // JSON
    'JSON', 'parse', 'stringify',
    // Object
    'Object', 'keys', 'values', 'entries', 'assign', 'freeze', 'seal', 'create', 'defineProperty',
    'defineProperties', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getOwnPropertyNames',
    'getOwnPropertySymbols', 'getPrototypeOf', 'setPrototypeOf', 'is', 'preventExtensions',
    // Array
    'Array', 'isArray', 'from', 'of', 'length', 'push', 'pop', 'shift', 'unshift', 'splice', 'slice',
    'concat', 'join', 'reverse', 'sort', 'indexOf', 'lastIndexOf', 'includes', 'find', 'findIndex',
    'filter', 'map', 'forEach', 'reduce', 'reduceRight', 'some', 'every', 'fill', 'copyWithin',
    'flat', 'flatMap', 'entries', 'keys', 'values',
    // String
    'String', 'charAt', 'charCodeAt', 'concat', 'indexOf', 'lastIndexOf', 'includes', 'startsWith',
    'endsWith', 'match', 'matchAll', 'replace', 'replaceAll', 'search', 'slice', 'split', 'substring',
    'substr', 'toLowerCase', 'toUpperCase', 'trim', 'trimStart', 'trimEnd', 'padStart', 'padEnd',
    'repeat', 'codePointAt', 'fromCodePoint', 'normalize', 'localeCompare',
    // Number
    'Number', 'isNaN', 'isFinite', 'isInteger', 'isSafeInteger', 'parseFloat', 'parseInt',
    'toExponential', 'toFixed', 'toPrecision', 'toString', 'valueOf',
    // Boolean
    'Boolean', 'toString', 'valueOf',
    // Date
    'Date', 'now', 'parse', 'UTC', 'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours',
    'getMinutes', 'getSeconds', 'getMilliseconds', 'getTime', 'getTimezoneOffset', 'getUTCDate',
    'getUTCDay', 'getUTCFullYear', 'getUTCHours', 'getUTCMilliseconds', 'getUTCMinutes', 'getUTCMonth',
    'getUTCSeconds', 'setDate', 'setFullYear', 'setHours', 'setMilliseconds', 'setMinutes', 'setMonth',
    'setSeconds', 'setTime', 'setUTCDate', 'setUTCFullYear', 'setUTCHours', 'setUTCMilliseconds',
    'setUTCMinutes', 'setUTCMonth', 'setUTCSeconds', 'toDateString', 'toISOString', 'toJSON',
    'toLocaleDateString', 'toLocaleString', 'toLocaleTimeString', 'toString', 'toTimeString', 'toUTCString',
    'valueOf',
    // RegExp
    'RegExp', 'test', 'exec', 'compile', 'toString',
    // Error
    'Error', 'EvalError', 'InternalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError',
    'URIError', 'stack', 'message', 'name',
    // Promise
    'Promise', 'all', 'race', 'allSettled', 'any', 'resolve', 'reject', 'then', 'catch', 'finally',
    // Map/Set
    'Map', 'Set', 'WeakMap', 'WeakSet', 'clear', 'delete', 'get', 'has', 'set', 'add', 'size',
    // Proxy/Reflect
    'Proxy', 'Reflect', 'apply', 'construct', 'defineProperty', 'deleteProperty', 'get', 'getOwnPropertyDescriptor',
    'getPrototypeOf', 'has', 'isExtensible', 'ownKeys', 'preventExtensions', 'set', 'setPrototypeOf',
    // Symbol
    'Symbol', 'for', 'keyFor', 'asyncIterator', 'hasInstance', 'isConcatSpreadable', 'iterator',
    'match', 'matchAll', 'replace', 'search', 'species', 'split', 'toPrimitive', 'toStringTag', 'unscopables',
    // Typed Arrays
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
    'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'buffer',
    'byteLength', 'byteOffset', 'BYTES_PER_ELEMENT',
    // BigInt
    'BigInt', 'asIntN', 'asUintN', 'toString', 'valueOf',
    // Intl
    'Intl', 'Collator', 'DateTimeFormat', 'NumberFormat', 'PluralRules', 'RelativeTimeFormat',
    // Process (Node.js)
    'process', 'Buffer', 'require', 'module', 'exports', '__dirname', '__filename',
    'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'
  ];

  tokenTypes = [
    // Keywords
    createKeywordToken(this.jsKeywords),
    // Built-ins
    {
      name: 'builtin',
      pattern: new RegExp(`\\b(${this.jsBuiltins.join('|')})\\b`, 'g'),
      className: 'nsh-function'
    },
    // Strings (incl. template literals)
    createStringToken([STRING_PATTERNS.singleQuote, STRING_PATTERNS.doubleQuote, STRING_PATTERNS.backtick]),
    // Template literals expressions
    {
      name: 'template-expression',
      pattern: /\$\{[^}]*\}/g,
      className: 'nsh-variable'
    },
    // Numbers (incl. hex, binary, octal, scientific)
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
    // Regex literals
    {
      name: 'regex',
      pattern: /\/[^/\n\\]*(?:\\.[^/\n\\]*)*\/[gimuy]*/g,
      className: 'nsh-string'
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
    // Variables
    createVariableToken(),
    // JSX (for .jsx files)
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
