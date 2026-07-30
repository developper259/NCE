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

export class Python implements LanguageDefinition {
  name = 'python';
  extensions = ['.py', '.pyw'];

  // Keywords Python complets
  private pyKeywords = [
    // Définitions
    'def', 'class', 'lambda',
    // Structures de contrôle
    'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'pass',
    // Exceptions
    'try', 'except', 'finally', 'raise', 'assert',
    // Importations
    'import', 'from', 'as',
    // Portée et variables
    'global', 'nonlocal', 'del',
    // Retour et génération
    'return', 'yield', 'yield',
    // Context managers
    'with', 'async', 'await',
    // Booléens et None
    'True', 'False', 'None',
    // Opérateurs logiques
    'and', 'or', 'not', 'in', 'is',
    // Autres
    'pass', 'break', 'continue'
  ];

  // Built-in functions Python
  private pyBuiltins = [
    // Fonctions built-in
    'abs', 'all', 'any', 'ascii', 'bin', 'bool', 'breakpoint', 'bytearray', 'bytes',
    'callable', 'chr', 'classmethod', 'compile', 'complex', 'delattr', 'dict', 'dir',
    'divmod', 'enumerate', 'eval', 'exec', 'filter', 'float', 'format', 'frozenset',
    'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex', 'id', 'input', 'int',
    'isinstance', 'issubclass', 'iter', 'len', 'list', 'locals', 'map', 'max',
    'memoryview', 'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print',
    'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice',
    'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars',
    'zip',
    // Exceptions built-in
    'Exception', 'BaseException', 'SystemExit', 'KeyboardInterrupt', 'GeneratorExit',
    'StopIteration', 'StopAsyncIteration', 'ArithmeticError', 'FloatingPointError',
    'OverflowError', 'ZeroDivisionError', 'AssertionError', 'AttributeError',
    'BufferError', 'EOFError', 'ImportError', 'ModuleNotFoundError', 'LookupError',
    'IndexError', 'KeyError', 'MemoryError', 'NameError', 'OSError', 'BlockingIOError',
    'ChildProcessError', 'ConnectionError', 'BrokenPipeError', 'ConnectionAbortedError',
    'ConnectionRefusedError', 'ConnectionResetError', 'FileExistsError', 'FileNotFoundError',
    'InterruptedError', 'IsADirectoryError', 'NotADirectoryError', 'PermissionError',
    'ProcessLookupError', 'TimeoutError', 'ReferenceError', 'RuntimeError',
    'NotImplementedError', 'RecursionError', 'SyntaxError', 'IndentationError',
    'TabError', 'SystemError', 'TypeError', 'ValueError', 'UnicodeError',
    'UnicodeDecodeError', 'UnicodeEncodeError', 'UnicodeTranslateError',
    'Warning', 'DeprecationWarning', 'PendingDeprecationWarning', 'RuntimeWarning',
    'SyntaxWarning', 'UserWarning', 'FutureWarning', 'ImportWarning', 'UnicodeWarning',
    'BytesWarning', 'ResourceWarning',
    // Types built-in
    'bool', 'int', 'float', 'complex', 'str', 'list', 'tuple', 'range', 'bytes',
    'bytearray', 'memoryview', 'set', 'frozenset', 'dict', 'type', 'object',
    'None', 'Ellipsis', 'NotImplemented',
    // Constantes
    '__debug__', '__import__',
    // Modules courants
    'os', 'sys', 're', 'json', 'math', 'random', 'datetime', 'time', 'collections',
    'itertools', 'functools', 'operator', 'pathlib', 'typing', 'dataclasses',
    'enum', 'threading', 'multiprocessing', 'subprocess', 'asyncio', 'logging',
    'unittest', 'pytest', 'numpy', 'pandas', 'matplotlib'
  ];

  // Decorators courants
  private pyDecorators = [
    '@staticmethod', '@classmethod', '@property', '@setter', '@deleter',
    '@abstractmethod', '@abstractmethod', '@override', '@final', '@dataclass',
    '@lru_cache', '@cache', '@total_ordering', '@singledispatch', '@singledispatchmethod',
    '@register', '@wraps', '@contextmanager', '@contextlib',
    '@asynccontextmanager', '@async_generator', '@generator',
    '@pytest.fixture', '@pytest.mark', '@unittest.skip', '@unittest.skipIf'
  ];

  tokenTypes = [
    // Keywords
    createKeywordToken(this.pyKeywords),
    // Built-ins
    {
      name: 'builtin',
      pattern: new RegExp(`\\b(${this.pyBuiltins.join('|')})\\b`, 'g'),
      className: 'nsh-function'
    },
    // Decorators
    {
      name: 'decorator',
      pattern: /@\w+(\.\w+)*/g,
      className: 'nsh-function'
    },
    // Strings (incl. f-strings, raw strings, bytes)
    {
      name: 'string',
      pattern: /("""[\s\S]*?"""|'''[\s\S]*?'''|f"[^"]*"|f'[^']*'|r"[^"]*"|r'[^']*'|b"[^"]*"|b'[^']*'|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
      className: 'nsh-string'
    },
    // F-string expressions
    {
      name: 'fstring-expression',
      pattern: /\{[^}]*\}/g,
      className: 'nsh-variable'
    },
    // Numbers (incl. hex, binary, octal, complex)
    createNumberToken([
      NUMBER_PATTERNS.integer,
      NUMBER_PATTERNS.decimal,
      NUMBER_PATTERNS.hex,
      NUMBER_PATTERNS.binary,
      NUMBER_PATTERNS.octal,
      /\b\d+j\b/g,  // Complex numbers
      /\b\d+\+\d+j\b/g  // Complex numbers with real part
    ]),
    // Comments
    createCommentToken(COMMENT_PATTERNS.singleLine.hash),
    // Docstrings
    {
      name: 'docstring',
      pattern: /("""[\s\S]*?"""|'''[\s\S]*?''')/g,
      className: 'nsh-comment'
    },
    // Type hints
    {
      name: 'type-hint',
      pattern: /:\s*[a-zA-Z_][a-zA-Z0-9_\[\],\s]*/g,
      className: 'nsh-keyword'
    },
    // Functions
    createFunctionToken(),
    // Operators
    {
      name: 'operator',
      pattern: /[+\-*/%=<>!&|^~?:;,.]/g,
      className: 'nsh-operator'
    },
    // Comparison operators
    {
      name: 'comparison',
      pattern: /(==|!=|<=|>=|<|>)/g,
      className: 'nsh-operator'
    },
    // Assignment operators
    {
      name: 'assignment',
      pattern: /(=|\+=|\-=|\*=|\/=|%=|\*\*=|\/\/=|&=|\|=|\^=|>>=|<<=)/g,
      className: 'nsh-operator'
    },
    // Identity operators
    {
      name: 'identity',
      pattern: /(is|is not)/g,
      className: 'nsh-operator'
    },
    // Membership operators
    {
      name: 'membership',
      pattern: /(in|not in)/g,
      className: 'nsh-operator'
    },
    // Boolean operators
    {
      name: 'boolean',
      pattern: /(and|or|not)/g,
      className: 'nsh-operator'
    },
    // Walrus operator (Python 3.8+)
    {
      name: 'walrus',
      pattern: /:=/g,
      className: 'nsh-operator'
    },
    // Variables
    createVariableToken(),
    // Self and cls
    {
      name: 'special-variable',
      pattern: /\b(self|cls)\b/g,
      className: 'nsh-variable'
    },
    // Brackets (avant operator pour éviter conflit)
    {
      name: 'bracket',
      pattern: /[\[\]\{\}\(\)]/g,
      className: 'nsh-bracket'
    },
    // Operators (sans < > car ils sont capturés par brackets)
    {
      name: 'operator',
      pattern: /[+\-*/%=!&|^~?:;,.]/g,
      className: 'nsh-operator'
    }
  ];

  comments = {
    singleLine: '#'
  };

  strings = {
    startEnd: ['"', "'", '"""', "'''"],
    escapeChar: '\\'
  };

  public getTokenTypes(): any[] {
    return this.tokenTypes;
  }
}
