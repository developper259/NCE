const fs = require("fs");
const path = require("path");
const {
  buildFlaticonCss,
  collectFlaticonFontFiles,
  collectIconClasses,
} = require("./flaticon-css");

const source = path.dirname(require.resolve("nsh/themes/dark.css"));
const destination = path.resolve(__dirname, "../src/css/nsh");
const flaticonSource = path.resolve(
  __dirname,
  "../node_modules/@flaticon/flaticon-uicons/css/all/all.css",
);
const flaticonDestination = path.resolve(
  __dirname,
  "../assets/flaticon/all.css",
);
const devAssetRoot = path.resolve(__dirname, "../src/assets");
const flaticonFontSource = path.resolve(
  __dirname,
  "../node_modules/@flaticon/flaticon-uicons/css",
);

function writeCssAsset(sourceFile, destinationFile, contents, generatedSourceMap) {
  const css = contents ?? fs.readFileSync(sourceFile, "utf8");
  fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
  fs.writeFileSync(destinationFile, css);

  const sourceMapReference = css.match(
    /\/\*[#@]\s*sourceMappingURL=([^*\s]+)\s*\*\//,
  )?.[1];
  if (!sourceMapReference || /^(?:data:|[a-z]+:|\/\/)/i.test(sourceMapReference))
    return;

  const referencePath = decodeURIComponent(sourceMapReference.split(/[?#]/, 1)[0]);
  const sourceMapSource = path.resolve(path.dirname(sourceFile), referencePath);
  const sourceMapDestination = path.resolve(
    path.dirname(destinationFile),
    referencePath,
  );
  if (!fs.existsSync(sourceMapSource)) {
    throw new Error(
      `CSS source map referenced by ${sourceFile} is missing: ${sourceMapSource}`,
    );
  }
  fs.mkdirSync(path.dirname(sourceMapDestination), { recursive: true });
  if (generatedSourceMap === undefined) {
    fs.copyFileSync(sourceMapSource, sourceMapDestination);
  } else {
    fs.writeFileSync(sourceMapDestination, generatedSourceMap);
  }
}

fs.mkdirSync(destination, { recursive: true });
if (fs.existsSync(source)) {
  for (const file of fs.readdirSync(source)) {
    if (file.endsWith(".css")) {
      writeCssAsset(path.join(source, file), path.join(destination, file));
    }
  }
} else {
  console.warn(`[NSH] Theme source is unavailable: ${source}`);
}

const flaticonCssSource = fs
  .readFileSync(flaticonSource, "utf8")
  .replaceAll("../uicons-", "./uicons-");
const flaticonCss = buildFlaticonCss({
  css: flaticonCssSource,
  sourceMap: fs.readFileSync(`${flaticonSource}.map`, "utf8"),
  sourcePath: flaticonSource,
  destinationPath: flaticonDestination,
  iconClasses: collectIconClasses(path.resolve(__dirname, "../src")),
});
writeCssAsset(
  flaticonSource,
  flaticonDestination,
  flaticonCss.css,
  flaticonCss.sourceMap,
);
writeCssAsset(
  flaticonSource,
  path.join(devAssetRoot, "flaticon/all.css"),
  flaticonCss.css,
  flaticonCss.sourceMap,
);
const requiredFlaticonFonts = collectFlaticonFontFiles(flaticonCss.css);
const flaticonAssetDirectories = [
  path.dirname(flaticonDestination),
  path.join(devAssetRoot, "flaticon"),
];
for (const directory of flaticonAssetDirectories) {
  fs.mkdirSync(directory, { recursive: true });
  for (const file of fs.readdirSync(directory)) {
    if (file.startsWith("uicons-") && !requiredFlaticonFonts.has(file)) {
      fs.rmSync(path.join(directory, file));
    }
  }
}
for (const file of requiredFlaticonFonts) {
  const sourceFile = path.join(flaticonFontSource, file);
  if (!fs.existsSync(sourceFile)) {
    throw new Error(`Flaticon CSS references a missing font file: ${sourceFile}`);
  }
  for (const directory of flaticonAssetDirectories) {
    fs.copyFileSync(sourceFile, path.join(directory, file));
  }
}
fs.cpSync(
  path.resolve(__dirname, "../assets/fonts"),
  path.join(devAssetRoot, "fonts"),
  {
    recursive: true,
  },
);

for (const file of ["dark-logo.ico", "dark-logo.png"]) {
  fs.mkdirSync(path.dirname(path.join(devAssetRoot, "logo/NCE", file)), {
    recursive: true,
  });
  fs.copyFileSync(
    path.resolve(__dirname, `../assets/logo/NCE/${file}`),
    path.join(devAssetRoot, "logo/NCE", file),
  );
}

const closeIconDestination = path.join(devAssetRoot, "icons/close.svg");
fs.mkdirSync(path.dirname(closeIconDestination), { recursive: true });
fs.copyFileSync(
  path.resolve(__dirname, "../assets/icons/close.svg"),
  closeIconDestination,
);
