const fs = require("fs");
const path = require("path");

const source = path.resolve(__dirname, "../node_modules/nsh/dist/themes");
const destination = path.resolve(__dirname, "../src/css/nsh");

fs.mkdirSync(destination, { recursive: true });
for (const file of fs.readdirSync(source)) {
  if (file.endsWith(".css")) {
    fs.copyFileSync(path.join(source, file), path.join(destination, file));
  }
}
