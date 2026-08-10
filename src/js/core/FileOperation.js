class FileOperations {
  async rename(oldPath, newPath) {
    return window.api.renameEntry(oldPath, newPath);
  }

  async delete(targetPath) {
    return window.api.deleteEntry(targetPath);
  }

  async createFile(dirPath, fileName) {
    return window.api.createFile(dirPath, fileName);
  }

  async createFolder(dirPath, folderName) {
    return window.api.createFolder(dirPath, folderName);
  }

  async copy(sourcePath, destPath) {
    return window.api.copyEntry(sourcePath, destPath);
  }

  async move(sourcePath, destPath) {
    return window.api.moveEntry(sourcePath, destPath);
  }

  async duplicate(targetPath) {
    return window.api.duplicateEntry(targetPath);
  }

  async pathExists(targetPath) {
    return window.api.pathExists(targetPath);
  }

  revealInExplorer(targetPath) {
    return window.api.revealInExplorer(targetPath);
  }

  copyPathToClipboard(filePath, rootPath, relative) {
    if (relative && rootPath) {
      const relativePath = filePath.startsWith(rootPath)
        ? filePath.slice(rootPath.length).replace(/^\/+/, "")
        : filePath;
      navigator.clipboard.writeText(relativePath);
    } else {
      navigator.clipboard.writeText(filePath);
    }
  }
}
