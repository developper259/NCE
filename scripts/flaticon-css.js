const fs = require("node:fs");
const path = require("node:path");
const postcss = require("postcss");

const CODE_FILE_EXTENSIONS = new Set([".cjs", ".html", ".js", ".json", ".mjs"]);
const ICON_CLASS_PATTERN = /\b(fi-[a-z0-9]+(?:-[a-z0-9]+)*)\b/g;
const ICON_GLYPH_SELECTOR = /^\.(fi-[a-z0-9]+(?:-[a-z0-9]+)*):before$/;
const FONT_CLASS_PREFIX = /\[\s*class\^=\s*["']?(fi-[a-z0-9]+)-/;

function collectIconClasses(sourceRoot) {
  const iconClasses = new Set();

  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile() || !CODE_FILE_EXTENSIONS.has(path.extname(entry.name)))
        continue;

      const contents = fs.readFileSync(filePath, "utf8");
      for (const match of contents.matchAll(ICON_CLASS_PATTERN)) {
        iconClasses.add(match[1]);
      }
    }
  }

  visit(sourceRoot);
  return iconClasses;
}

function getGlyphClass(selector) {
  const match = ICON_GLYPH_SELECTOR.exec(selector.trim());
  return match?.[1] || null;
}

function getFlaticonFontFamilies(root) {
  const familiesByPrefix = new Map();
  root.walkRules((rule) => {
    const fontFamily = rule.nodes?.find((node) =>
      node.type === "decl" && node.prop.toLowerCase() === "font-family",
    )?.value.match(/uicons-[a-z0-9-]+/i)?.[0];
    if (!fontFamily) return;

    for (const selector of rule.selector.split(",")) {
      const prefix = FONT_CLASS_PREFIX.exec(selector)?.[1];
      if (prefix) familiesByPrefix.set(prefix, fontFamily);
    }
  });
  return familiesByPrefix;
}

function collectFlaticonFontFiles(css) {
  const fontFiles = new Set();
  postcss.parse(css).walkAtRules("font-face", (rule) => {
    for (const match of rule.toString().matchAll(/url\((?:"|')?([^"')]+)(?:"|')?\)/g)) {
      const url = match[1].split(/[?#]/, 1)[0];
      if (/\.(?:eot|otf|ttf|woff2?)$/i.test(url)) {
        fontFiles.add(path.basename(decodeURIComponent(url)));
      }
    }
  });
  return fontFiles;
}

function buildFlaticonCss({
  css,
  sourceMap,
  sourcePath,
  destinationPath,
  iconClasses,
}) {
  const safelist = new Set(iconClasses);
  const stats = {
    retainedGlyphRules: 0,
    removedGlyphRules: 0,
    retainedFontFaces: 0,
    removedFontFaces: 0,
    requiredFontFamilies: [],
  };
  const filterPlugin = {
    postcssPlugin: "nce-used-flaticon-icons",
    Once(root) {
      const familiesByPrefix = getFlaticonFontFamilies(root);
      const requiredFontFamilies = new Set();
      for (const iconClass of safelist) {
        for (const [prefix, family] of familiesByPrefix) {
          if (iconClass.startsWith(`${prefix}-`)) {
            requiredFontFamilies.add(family);
          }
        }
      }
      stats.requiredFontFamilies = [...requiredFontFamilies].sort();

      root.walkAtRules("font-face", (rule) => {
        const family = rule.nodes?.find((node) =>
          node.type === "decl" && node.prop.toLowerCase() === "font-family",
        )?.value.replace(/["']/g, "").trim();
        if (!requiredFontFamilies.has(family)) {
          stats.removedFontFaces += 1;
          rule.remove();
        } else {
          stats.retainedFontFaces += 1;
        }
      });

      root.walkRules((rule) => {
        const fontFamily = rule.nodes?.find((node) =>
          node.type === "decl" && node.prop.toLowerCase() === "font-family",
        )?.value.match(/uicons-[a-z0-9-]+/i)?.[0];
        if (!fontFamily || requiredFontFamilies.has(fontFamily)) return;
        rule.remove();
      });

      root.walkRules((rule) => {
        const selectors = rule.selector.split(",").map((selector) => selector.trim());
        const glyphClasses = selectors.map(getGlyphClass);
        if (!glyphClasses.some(Boolean)) return;

        const keptSelectors = selectors.filter((selector, index) =>
          !glyphClasses[index] || safelist.has(glyphClasses[index]),
        );
        stats.retainedGlyphRules += keptSelectors.filter((selector) =>
          Boolean(getGlyphClass(selector)),
        ).length;
        stats.removedGlyphRules += selectors.length - keptSelectors.length;

        if (keptSelectors.length === 0) rule.remove();
        else if (keptSelectors.length !== selectors.length) {
          rule.selector = keptSelectors.join(",");
        }
      });
    },
  };
  const result = postcss([filterPlugin]).process(css, {
    from: sourcePath,
    to: destinationPath,
    map: {
      inline: false,
      annotation: `${path.basename(destinationPath)}.map`,
      prev: sourceMap,
      sourcesContent: true,
    },
  });
  result.sync();

  return {
    css: result.css,
    sourceMap: result.map.toString(),
    stats,
  };
}

module.exports = {
  buildFlaticonCss,
  collectFlaticonFontFiles,
  collectIconClasses,
};
