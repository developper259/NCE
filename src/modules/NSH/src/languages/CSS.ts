import { LanguageDefinition } from '../types/language';
import {
  createCommentToken,
  createStringToken,
  STRING_PATTERNS,
  NUMBER_PATTERNS,
  COMMENT_PATTERNS
} from './shared';

export class CSS implements LanguageDefinition {
  name = 'css';
  extensions = ['.css', '.scss', '.sass'];

  // Propriétés CSS complètes
  private cssProperties = [
    // Layout
    'display', 'position', 'top', 'right', 'bottom', 'left', 'float', 'clear',
    'overflow', 'overflow-x', 'overflow-y', 'visibility', 'opacity', 'z-index',
    // Box Model
    'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'border', 'border-width', 'border-style', 'border-color',
    'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-radius', 'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-left-radius', 'border-bottom-right-radius',
    'box-sizing', 'box-shadow',
    // Typography
    'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
    'font-size-adjust', 'font-stretch', 'line-height', 'letter-spacing', 'word-spacing',
    'text-align', 'text-decoration', 'text-indent', 'text-transform', 'text-shadow',
    'text-overflow', 'white-space', 'word-wrap', 'word-break',
    'color', 'background', 'background-color', 'background-image', 'background-repeat',
    'background-position', 'background-size', 'background-attachment', 'background-clip',
    'background-origin',
    // Flexbox
    'flex', 'flex-direction', 'flex-wrap', 'flex-flow', 'flex-grow', 'flex-shrink',
    'flex-basis', 'justify-content', 'align-items', 'align-content', 'align-self',
    'order',
    // Grid
    'grid', 'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
    'grid-column', 'grid-row', 'grid-area', 'grid-gap', 'grid-column-gap', 'grid-row-gap',
    'grid-auto-columns', 'grid-auto-rows', 'grid-auto-flow',
    'justify-items', 'justify-self',
    // Transitions & Animations
    'transition', 'transition-property', 'transition-duration', 'transition-timing-function',
    'transition-delay', 'animation', 'animation-name', 'animation-duration',
    'animation-timing-function', 'animation-delay', 'animation-iteration-count',
    'animation-direction', 'animation-fill-mode', 'animation-play-state',
    'transform', 'transform-origin', 'perspective', 'perspective-origin', 'backface-visibility',
    // Tables
    'table-layout', 'border-collapse', 'border-spacing', 'caption-side', 'empty-cells',
    // Lists
    'list-style', 'list-style-type', 'list-style-image', 'list-style-position',
    // Other
    'cursor', 'outline', 'outline-width', 'outline-style', 'outline-color',
    'content', 'quotes', 'counter-reset', 'counter-increment', 'resize',
    'filter', 'clip', 'clip-path', 'mask', 'mask-image', 'mask-mode', 'mask-position',
    'mask-size', 'mask-repeat', 'mask-origin', 'mask-clip', 'mask-composite',
    'object-fit', 'object-position', 'isolation', 'mix-blend-mode',
    'scroll-behavior', 'overscroll-behavior', 'scroll-snap-type', 'scroll-snap-align',
    'touch-action', 'user-select', 'pointer-events', 'will-change',
    'columns', 'column-count', 'column-width', 'column-gap', 'column-rule',
    'column-rule-width', 'column-rule-style', 'column-rule-color', 'column-span',
    'break-before', 'break-after', 'break-inside', 'orphans', 'widows'
  ];

  // Pseudo-classes CSS
  private cssPseudoClasses = [
    ':hover', ':active', ':focus', ':visited', ':link', ':target', ':lang',
    ':not', ':checked', ':disabled', ':enabled', ':required', ':optional',
    ':valid', ':invalid', ':in-range', ':out-of-range', ':read-only', ':read-write',
    ':root', ':empty', ':first-child', ':last-child', ':only-child',
    ':first-of-type', ':last-of-type', ':only-of-type', ':nth-child', ':nth-last-child',
    ':nth-of-type', ':nth-last-of-type', ':first-letter', ':first-line',
    ':before', ':after', ':selection', ':placeholder', ':placeholder-shown',
    ':fullscreen', ':any', ':is', ':where', ':has', ':focus-within', ':focus-visible'
  ];

  // Pseudo-éléments CSS
  private cssPseudoElements = [
    '::before', '::after', '::first-letter', '::first-line', '::selection',
    '::placeholder', '::marker', '::backdrop', '::file-selector-button',
    '::grammar-error', '::spelling-error'
  ];

  // Fonctions CSS
  private cssFunctions = [
    'calc', 'min', 'max', 'clamp', 'var', 'attr', 'url', 'counter', 'counters',
    'rgba', 'rgb', 'hsla', 'hsl', 'hwb', 'lab', 'lch', 'color', 'image',
    'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient',
    'repeating-radial-gradient', 'repeating-conic-gradient', 'image-set',
    'filter', 'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale',
    'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia',
    'transform', 'matrix', 'matrix3d', 'perspective', 'rotate', 'rotate3d',
    'rotateX', 'rotateY', 'rotateZ', 'scale', 'scale3d', 'scaleX', 'scaleY', 'scaleZ',
    'skew', 'skewX', 'skewY', 'translate', 'translate3d', 'translateX', 'translateY', 'translateZ',
    'steps', 'cubic-bezier', 'path', 'circle', 'ellipse', 'inset', 'polygon',
    'minmax', 'fit-content', 'repeat', 'auto-fill', 'auto-fit', 'fr', 'env', 'format'
  ];

  // Unités CSS
  private cssUnits = [
    // Length
    'px', 'em', 'rem', 'vw', 'vh', 'vmin', 'vmax', '%', 'cm', 'mm', 'in', 'pt', 'pc',
    'ch', 'ex',
    // Time
    's', 'ms',
    // Angle
    'deg', 'rad', 'grad', 'turn',
    // Resolution
    'dpi', 'dpcm', 'dppx',
    // Frequency
    'Hz', 'kHz'
  ];

  tokenTypes = [
    // Selectors
    {
      name: 'selector',
      pattern: /[.#]?[a-zA-Z_-][a-zA-Z0-9_-]*(?=\s*\{)/g,
      className: 'nsh-function'
    },
    // ID selectors
    {
      name: 'selector-id',
      pattern: /#[a-zA-Z_-][a-zA-Z0-9_-]*/g,
      className: 'nsh-function'
    },
    // Class selectors
    {
      name: 'selector-class',
      pattern: /\.[a-zA-Z_-][a-zA-Z0-9_-]*/g,
      className: 'nsh-function'
    },
    // Attribute selectors
    {
      name: 'selector-attribute',
      pattern: /\[[a-zA-Z-]+[~|^$*]?=[^\]]*\]/g,
      className: 'nsh-variable'
    },
    // Pseudo-classes
    {
      name: 'pseudo-class',
      pattern: new RegExp(`(${this.cssPseudoClasses.join('|')})`, 'g'),
      className: 'nsh-keyword'
    },
    // Pseudo-elements
    {
      name: 'pseudo-element',
      pattern: new RegExp(`(${this.cssPseudoElements.join('|')})`, 'g'),
      className: 'nsh-keyword'
    },
    // Properties
    {
      name: 'property',
      pattern: new RegExp(`(${this.cssProperties.join('|')})`, 'g'),
      className: 'nsh-keyword'
    },
    // Values
    {
      name: 'value',
      pattern: /:[^;]+/g,
      className: 'nsh-string'
    },
    // Strings
    createStringToken([STRING_PATTERNS.doubleQuote, STRING_PATTERNS.singleQuote]),
    // Numbers with units
    {
      name: 'number',
      pattern: new RegExp(`\\b\\d+\\.?\\d*(${this.cssUnits.join('|')})?\\b`, 'g'),
      className: 'nsh-number'
    },
    // Colors (hex, rgb, hsl, named)
    {
      name: 'color',
      pattern: /(#[0-9a-fA-F]{3,8}|rgb[a]?\([^)]*\)|hsl[a]?\([^)]*\)|[a-zA-Z]+)\b/g,
      className: 'nsh-number'
    },
    // CSS variables
    {
      name: 'variable',
      pattern: /--[a-zA-Z-]+/g,
      className: 'nsh-variable'
    },
    // var() function
    {
      name: 'var-function',
      pattern: /var\([^)]+\)/g,
      className: 'nsh-variable'
    },
    // CSS functions
    {
      name: 'function',
      pattern: new RegExp(`(${this.cssFunctions.join('|')})\\(`, 'g'),
      className: 'nsh-function'
    },
    // Comments
    createCommentToken(COMMENT_PATTERNS.multiLine.slashStar),
    // At-rules
    {
      name: 'at-rule',
      pattern: /@[a-zA-Z-]+/g,
      className: 'nsh-keyword'
    },
    // Important
    {
      name: 'important',
      pattern: /!important/g,
      className: 'nsh-keyword'
    },
    // Operators
    {
      name: 'operator',
      pattern: /[{}:;,>~+*|]/g,
      className: 'nsh-operator'
    },
    // Combinators
    {
      name: 'combinator',
      pattern: /[>+~]/g,
      className: 'nsh-operator'
    }
  ];

  comments = {
    multiLine: {
      start: '/*',
      end: '*/'
    }
  };

  strings = {
    startEnd: ['"', "'"],
    escapeChar: '\\'
  };

  public getTokenTypes(): any[] {
    return this.tokenTypes;
  }
}
