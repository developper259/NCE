import { LanguageDefinition } from '../types/language';
import {
  createCommentToken,
  createStringToken,
  STRING_PATTERNS,
  COMMENT_PATTERNS
} from './shared';

export class HTML implements LanguageDefinition {
  name = 'html';
  extensions = ['.html', '.htm'];

  // Tags HTML complets
  private htmlTags = [
    // Structure de document
    'html', 'head', 'body', 'title', 'base', 'link', 'meta', 'style',
    // Texte
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'pre', 'blockquote',
    'div', 'span', 'strong', 'em', 'b', 'i', 'u', 's', 'strike', 'sub', 'sup',
    'small', 'big', 'code', 'kbd', 'samp', 'var', 'cite', 'dfn', 'abbr', 'acronym',
    'address', 'del', 'ins', 'mark',
    // Listes
    'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'menu', 'dir',
    // Tables
    'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'col', 'colgroup',
    // Formulaires
    'form', 'input', 'textarea', 'button', 'select', 'option', 'optgroup', 'label',
    'fieldset', 'legend', 'datalist', 'keygen', 'output', 'progress', 'meter',
    // Images et médias
    'img', 'picture', 'source', 'audio', 'video', 'track', 'map', 'area', 'iframe',
    'embed', 'object', 'param',
    // Liens et navigation
    'a', 'nav', 'main', 'header', 'footer', 'aside', 'section', 'article', 'figure',
    'figcaption', 'details', 'summary', 'dialog',
    // Scripts
    'script', 'noscript', 'template', 'slot',
    // Canvas et SVG
    'canvas', 'svg', 'path', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline',
    'text', 'tspan', 'defs', 'g', 'use', 'linearGradient', 'radialGradient', 'stop',
    // Autres
    'wbr', 'bdi', 'bdo', 'ruby', 'rt', 'rp', 'time', 'data'
  ];

  // Attributs HTML complets
  private htmlAttributes = [
    // Attributs globaux
    'id', 'class', 'style', 'title', 'lang', 'dir', 'hidden', 'tabindex', 'accesskey',
    'contenteditable', 'spellcheck', 'translate', 'draggable', 'dropzone',
    // Attributs de formulaire
    'type', 'name', 'value', 'placeholder', 'required', 'disabled', 'readonly',
    'autocomplete', 'autofocus', 'maxlength', 'minlength', 'pattern', 'step', 'min', 'max',
    'multiple', 'checked', 'selected', 'form', 'formaction', 'formenctype', 'formmethod',
    'formnovalidate', 'formtarget', 'accept', 'accept-charset', 'action', 'method', 'enctype',
    'target', 'novalidate', 'autocomplete',
    // Attributs de lien et navigation
    'href', 'target', 'rel', 'rev', 'media', 'hreflang', 'type', 'download', 'ping',
    'referrerpolicy',
    // Attributs d'image
    'src', 'srcset', 'sizes', 'alt', 'crossorigin', 'usemap', 'ismap', 'width', 'height',
    // Attributs de média
    'controls', 'autoplay', 'loop', 'muted', 'preload', 'poster', 'playsinline',
    // Attributs de script
    'src', 'type', 'async', 'defer', 'integrity', 'crossorigin', 'nomodule',
    // Attributs de style
    'media', 'scoped', 'type',
    // Attributs de meta
    'name', 'http-equiv', 'content', 'charset',
    // Attributs ARIA
    'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden',
    'aria-disabled', 'aria-checked', 'aria-expanded', 'aria-pressed', 'aria-selected',
    'aria-level', 'aria-live', 'aria-atomic', 'aria-relevant', 'aria-dropeffect',
    'aria-dragged', 'aria-grabbed', 'aria-haspopup', 'aria-orientation',
    // Attributs de données
    'data-*',
    // Autres attributs
    'colspan', 'rowspan', 'scope', 'headers', 'align', 'valign', 'char', 'charoff',
    'bgcolor', 'background', 'text', 'link', 'vlink', 'alink', 'border', 'cellpadding',
    'cellspacing', 'frame', 'rules', 'summary', 'width', 'height', 'usemap', 'shape',
    'coords', 'ismap', 'longdesc', 'name', 'cite', 'datetime', 'profile', 'content',
    'scheme', 'http-equiv', 'charset', 'language', 'type', 'src', 'defer', 'async',
    'event', 'for', 'action', 'method', 'enctype', 'accept', 'accept-charset', 'target',
    'novalidate', 'autocomplete', 'autofocus', 'form', 'formaction', 'formenctype',
    'formmethod', 'formnovalidate', 'formtarget', 'list', 'multiple', 'pattern',
    'placeholder', 'readonly', 'required', 'size', 'step', 'min', 'max', 'maxlength',
    'minlength', 'disabled', 'checked', 'selected', 'value', 'alt', 'src', 'srcset',
    'sizes', 'crossorigin', 'usemap', 'ismap', 'width', 'height', 'poster', 'preload',
    'autoplay', 'loop', 'muted', 'controls', 'playsinline', 'media', 'kind', 'srclang',
    'track', 'default', 'label', 'sandbox', 'allowfullscreen', 'allowpaymentrequest',
    'allow', 'referrerpolicy', 'loading', 'decoding', 'importance'
  ];

  tokenTypes = [
    // Doctype
    {
      name: 'doctype',
      pattern: /<!DOCTYPE[^>]*>/gi,
      className: 'nsh-keyword'
    },
    // Opening tags
    {
      name: 'tag-open',
      pattern: /<[a-zA-Z][a-zA-Z0-9]*/g,
      className: 'nsh-keyword'
    },
    // Closing tags
    {
      name: 'tag-close',
      pattern: /<\/[a-zA-Z][a-zA-Z0-9]*/g,
      className: 'nsh-keyword'
    },
    // Self-closing tags
    {
      name: 'tag-selfclose',
      pattern: /\/>/g,
      className: 'nsh-keyword'
    },
    // Tag closing bracket
    {
      name: 'tag-bracket',
      pattern: />/g,
      className: 'nsh-keyword'
    },
    // Attributes
    {
      name: 'attribute',
      pattern: /\s[a-zA-Z-]+(?==)/g,
      className: 'nsh-variable'
    },
    // Attribute values (strings)
    createStringToken([STRING_PATTERNS.doubleQuote, STRING_PATTERNS.singleQuote]),
    // Unquoted attribute values
    {
      name: 'attribute-value',
      pattern: /=\s*[^\s"'>]+/g,
      className: 'nsh-string'
    },
    // Comments
    createCommentToken(COMMENT_PATTERNS.multiLine.dashDash),
    // CDATA sections
    {
      name: 'cdata',
      pattern: /<!\[CDATA\[[\s\S]*?\]\]>/g,
      className: 'nsh-string'
    },
    // HTML entities
    {
      name: 'entity',
      pattern: /&[a-zA-Z0-9#]+;/g,
      className: 'nsh-number'
    },
    // Processing instructions
    {
      name: 'processing-instruction',
      pattern: /<\?[\s\S]*?\?>/g,
      className: 'nsh-comment'
    },
    // Script/style content (basic)
    {
      name: 'script-content',
      pattern: /<script[^>]*>[\s\S]*?<\/script>/gi,
      className: 'nsh-string'
    },
    {
      name: 'style-content',
      pattern: /<style[^>]*>[\s\S]*?<\/style>/gi,
      className: 'nsh-string'
    }
  ];

  comments = {
    multiLine: {
      start: '<!--',
      end: '-->'
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
