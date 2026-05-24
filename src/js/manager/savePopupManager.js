class SavePopupManager {
  constructor(editor, fileManager) {
    this.editor = editor;
    this.fileManager = fileManager;
  }

  async confirmClose(fileId) {
    const file = this.fileManager.files[fileId];
    if (!file) return "cancel";
    return await this.editor.api.confirmUnsavedChanges(file.name);
  }
}
