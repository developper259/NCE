class SavePopup {
  constructor(editor, tabManager) {
    this.editor = editor;
    this.tabManager = tabManager;
    this.pendingConfirmations = new Map();
  }

  confirmClose(fileId) {
    const file = this.tabManager.getFileByID(fileId);
    if (!file) return Promise.resolve("cancel");

    const pending = this.pendingConfirmations.get(file);
    if (pending) return pending;

    let confirmation;
    confirmation = Promise.resolve()
      .then(() => this.editor.api.confirmUnsavedChanges(file.id, file.name))
      .then(
        (choice) =>
          choice === "save" || choice === "dontSave" || choice === "cancel"
            ? choice
            : "cancel",
        () => "cancel",
      )
      .finally(() => {
        if (this.pendingConfirmations.get(file) === confirmation) {
          this.pendingConfirmations.delete(file);
        }
      });
    this.pendingConfirmations.set(file, confirmation);
    return confirmation;
  }
}
