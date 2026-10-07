const FileType = Object.freeze({
  isMarkdownPath(path) {
    if (typeof path !== "string") return false;
    return NCEPath.basename(path).match(/\.[^.]+$/)?.[0]?.toLowerCase() === ".md";
  },
});
