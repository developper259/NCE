const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const postcss = require("postcss");
const { root } = require("./helpers/runtime");
const {
  buildFlaticonCss,
  collectFlaticonFontFiles,
  collectIconClasses,
} = require("../scripts/flaticon-css.js");

test("Flaticon CSS retains source and dynamic icons with reproducible mappings", () => {
  const sourcePath = require.resolve("@flaticon/flaticon-uicons/css/all/all.css");
  const destinationPath = path.join(root, "assets/flaticon/all.css");
  const sourceCss = fs.readFileSync(sourcePath, "utf8");
  const css = sourceCss.replaceAll("../uicons-", "./uicons-");
  const sourceMap = fs.readFileSync(`${sourcePath}.map`, "utf8");
  const iconClasses = collectIconClasses(path.join(root, "src"));
  const build = () => buildFlaticonCss({
    css,
    sourceMap,
    sourcePath,
    destinationPath,
    iconClasses,
  });
  const first = build();
  const second = build();

  assert.ok(iconClasses.has("fi-rr-angle-small-down"), "static HTML icon is safelisted");
  assert.ok(iconClasses.has("fi-rr-angle-small-up"), "classList-toggled icon is safelisted");
  assert.ok(iconClasses.has("fi-brands-kotlin"), "dynamic file-type config is safelisted");
  assert.ok(iconClasses.has("fi-brands-python"), "language icon is safelisted");
  assert.equal(first.css, second.css);
  assert.equal(first.sourceMap, second.sourceMap);

  const originalGlyphs = new Set();
  const emittedGlyphs = new Set();
  const safelistedAvailableGlyphs = new Set();
  postcss.parse(sourceCss).walkRules((rule) => {
    const match = /^\.(fi-[a-z0-9-]+):before$/.exec(rule.selector.trim());
    if (match) originalGlyphs.add(match[1]);
  });
  postcss.parse(first.css).walkRules((rule) => {
    const match = /^\.(fi-[a-z0-9-]+):before$/.exec(rule.selector.trim());
    if (match) emittedGlyphs.add(match[1]);
  });
  for (const iconClass of iconClasses) {
    if (originalGlyphs.has(iconClass)) safelistedAvailableGlyphs.add(iconClass);
  }

  assert.deepEqual(
    [...emittedGlyphs].sort(),
    [...safelistedAvailableGlyphs].sort(),
  );
  assert.equal(first.stats.retainedGlyphRules, safelistedAvailableGlyphs.size);
  assert.equal(
    first.stats.removedGlyphRules,
    originalGlyphs.size - safelistedAvailableGlyphs.size,
  );
  assert.ok(originalGlyphs.has("fi-br-00s-music-disc"));
  assert.equal(emittedGlyphs.has("fi-br-00s-music-disc"), false);

  const fontFaces = (contents) => {
    const faces = [];
    postcss.parse(contents).walkAtRules("font-face", (rule) => {
      faces.push(rule.toString());
    });
    return faces;
  };
  assert.equal(fontFaces(sourceCss).length, 9);
  assert.deepEqual(first.stats.requiredFontFamilies, [
    "uicons-brands",
    "uicons-regular-rounded",
  ]);
  assert.equal(first.stats.retainedFontFaces, 2);
  assert.equal(first.stats.removedFontFaces, 7);
  assert.equal(fontFaces(first.css).length, 2);
  assert.deepEqual(
    [...collectFlaticonFontFiles(first.css)].sort(),
    [
      "uicons-brands-PQBQF6T3.woff",
      "uicons-brands-XJPKRNBN.woff2",
      "uicons-brands-ZJWE2ELA.eot",
      "uicons-regular-rounded-ESQGLQQ4.eot",
      "uicons-regular-rounded-J3WOUERV.woff2",
      "uicons-regular-rounded-KDJ23353.woff",
    ].sort(),
  );
  assert.match(first.css, /sourceMappingURL=all\.css\.map/);
  const generatedMap = JSON.parse(first.sourceMap);
  assert.ok(generatedMap.sources.length >= 9);
  assert.ok(generatedMap.sourcesContent.some(Boolean));
  assert.ok(generatedMap.mappings.length > 0);
});

test("synced Flaticon assets match the deterministic source-filtered build", () => {
  const sourcePath = require.resolve("@flaticon/flaticon-uicons/css/all/all.css");
  const destinationPath = path.join(root, "assets/flaticon/all.css");
  const generated = buildFlaticonCss({
    css: fs.readFileSync(sourcePath, "utf8").replaceAll("../uicons-", "./uicons-"),
    sourceMap: fs.readFileSync(`${sourcePath}.map`, "utf8"),
    sourcePath,
    destinationPath,
    iconClasses: collectIconClasses(path.join(root, "src")),
  });

  assert.equal(fs.readFileSync(destinationPath, "utf8"), generated.css);
  assert.equal(
    fs.readFileSync(path.join(root, "assets/flaticon/all.css.map"), "utf8"),
    generated.sourceMap,
  );
  assert.equal(
    fs.readFileSync(path.join(root, "src/assets/flaticon/all.css"), "utf8"),
    generated.css,
  );
  assert.equal(
    fs.readFileSync(path.join(root, "src/assets/flaticon/all.css.map"), "utf8"),
    generated.sourceMap,
  );
  const requiredFonts = collectFlaticonFontFiles(generated.css);
  for (const directory of ["assets/flaticon", "src/assets/flaticon"]) {
    const fontFiles = fs.readdirSync(path.join(root, directory))
      .filter((file) => file.startsWith("uicons-"))
      .sort();
    assert.deepEqual(fontFiles, [...requiredFonts].sort());
    for (const file of requiredFonts) {
      assert.ok(fs.existsSync(path.join(root, directory, file)), `${directory}/${file} exists`);
    }
  }
});
