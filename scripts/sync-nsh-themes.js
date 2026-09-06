const fs = require("fs");
const path = require("path");

const source = path.resolve(__dirname, "../node_modules/nsh/dist/themes");
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

fs.mkdirSync(destination, { recursive: true });
if (fs.existsSync(source)) {
  for (const file of fs.readdirSync(source)) {
    if (file.endsWith(".css")) {
      fs.copyFileSync(path.join(source, file), path.join(destination, file));
    }
  }
} else {
  console.warn(`[NSH] Theme source is unavailable: ${source}`);
}

fs.mkdirSync(path.dirname(flaticonDestination), { recursive: true });
const flaticonCss = fs
  .readFileSync(flaticonSource, "utf8")
  .replaceAll("../uicons-", "./uicons-");
fs.writeFileSync(flaticonDestination, flaticonCss);
fs.mkdirSync(path.dirname(path.join(devAssetRoot, "flaticon/all.css")), {
  recursive: true,
});
fs.writeFileSync(path.join(devAssetRoot, "flaticon/all.css"), flaticonCss);
for (const file of fs.readdirSync(flaticonFontSource)) {
  if (!file.startsWith("uicons-")) continue;
  fs.copyFileSync(
    path.join(flaticonFontSource, file),
    path.join(path.dirname(flaticonDestination), file),
  );
  fs.copyFileSync(
    path.join(flaticonFontSource, file),
    path.join(devAssetRoot, "flaticon", file),
  );
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
