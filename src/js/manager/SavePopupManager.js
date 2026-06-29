class SavePopupManager {
  constructor(editor, tabManager) {
    this.editor = editor;
    this.tabManager = tabManager;
  }

  async confirmClose(fileId) {
    const file = this.tabManager.files[fileId];
    if (!file) return "cancel";
    return await this.editor.api.confirmUnsavedChanges(file.name);
  }
}
