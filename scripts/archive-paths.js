const path = require("node:path");

function normalizeArchivePath(value) {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function toAsarLookupPath(value, separator = path.sep) {
  return normalizeArchivePath(value).split("/").join(separator);
}

module.exports = { normalizeArchivePath, toAsarLookupPath };
