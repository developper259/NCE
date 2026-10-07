const fs = require("node:fs");
const path = require("node:path");
const postcss = require("postcss");

const CODE_FILE_EXTENSIONS = new Set([".cjs", ".html", ".js", ".json", ".mjs"]);
const ICON_CLASS_PATTERN = /\b(fi-[a-z0-9]+(?:-[a-z0-9]+)*)\b/g;
const ICON_GLYPH_SELECTOR = /^\.(fi-[a-z0-9]+(?:-[a-z0-9]+)*):before$/;

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

function buildFlaticonCss({
  css,
  sourceMap,
  sourcePath,
  destinationPath,
  iconClasses,
}) {
  const safelist = new Set(iconClasses);
  const stats = { retainedGlyphRules: 0, removedGlyphRules: 0 };
  const filterPlugin = {
    postcssPlugin: "nce-used-flaticon-icons",
    Once(root) {
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

module.exports = { buildFlaticonCss, collectIconClasses };
