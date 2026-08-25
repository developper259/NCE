import { LanguageDefinition } from "../types/language";
import { TokenType } from "../types/token";
import { createStringToken, STRING_PATTERNS } from "./shared";

export class XML implements LanguageDefinition {
  name = "xml";
  extensions = [".xml", ".xsd", ".xsl", ".xslt", ".svg", ".rss", ".atom"];

  // Nom de balise/attribut avec espace de noms optionnel : ns:local-name
  private nameSource = "[a-zA-Z_][a-zA-Z0-9_.-]*(?::[a-zA-Z_][a-zA-Z0-9_.-]*)?";

  public tokenTypes: TokenType[] = [
    {
      name: "xml-decl",
      pattern: /<\?xml[\s\S]*?\?>/gi,
      className: "nsh-comment",
    },
    { name: "doctype", pattern: /<!DOCTYPE[^>]*>/gi, className: "nsh-keyword" },
    {
      name: "tag-open",
      pattern: new RegExp(`<${this.nameSource}`, "g"),
      className: "nsh-keyword",
    },
    {
      name: "tag-close",
      pattern: new RegExp(`<\\/${this.nameSource}`, "g"),
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
      pattern: new RegExp(`${this.nameSource}(?=\\s*=)`, "g"),
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
    { name: "comment", pattern: /<!--[\s\S]*?-->/g, className: "nsh-comment" },
    {
      name: "cdata",
      pattern: /<!\[CDATA\[[\s\S]*?\]\]>/g,
      className: "nsh-string",
    },
    { name: "entity", pattern: /&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, className: "nsh-number" },
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
    // Règles d'attributs, actives uniquement dans l'état "inTag" (jamais
    // sur le texte hors-balise). Contrairement au HTML, un attribut XML
    // doit toujours avoir une valeur : pas de règle "catch-all" pour un
    // mot isolé.
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
        pattern: new RegExp(`${this.nameSource}(?=\\s*=)`, "g"),
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
    ];

    return {
      root: [
        {
          name: "xml-decl",
          pattern: /<\?xml\b/gi,
          className: "nsh-comment",
          push: "inProcessing",
        },
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
        // Balise fermante : entre dans "inTag" pour ne rien colorer
        // au-delà (le texte hors-balise ne matche jamais les règles
        // d'attributs).
        {
          name: "tag-close",
          pattern: new RegExp(`<\\/${this.nameSource}`, "g"),
          className: "nsh-keyword",
          push: "inTag",
        },
        // Balise ouvrante : idem, pour gérer ses éventuels attributs.
        {
          name: "tag-open",
          pattern: new RegExp(`<${this.nameSource}`, "g"),
          className: "nsh-keyword",
          push: "inTag",
        },
        {
          name: "entity",
          pattern: /&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
          className: "nsh-number",
        },
        {
          name: "processing-instruction",
          pattern: /<\?/g,
          className: "nsh-comment",
          push: "inProcessing",
        },
      ],

      // Contenu strictement à l'intérieur d'une balise, entre "<tag"/"</tag"
      // et ">". Les règles d'attributs ne s'appliquent QUE ici.
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

      // Valeur d'attribut entre guillemets doubles/simples, consommée
      // caractère par caractère jusqu'au guillemet fermant.
      inDoubleQuote: [
        {
          name: "string",
          pattern: /"/g,
          className: "nsh-string",
          pop: true,
        },
        {
          name: "string",
          pattern: /(?:(?!").)+/g,
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
          pattern: /(?:(?!').)+/g,
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
    };
  }

  comments = { multiLine: { start: "<!--", end: "-->" } };
  strings = { startEnd: ['"', "'"], escapeChar: "\\" };
}