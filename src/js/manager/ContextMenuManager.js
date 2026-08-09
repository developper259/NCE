class ContextMenuManager {
  constructor(editor) {
    this.editor = editor;
    this.registeredMenus = new Map();
    this.activeCallbacks = new Map();

    if (window.api && window.api.onContextMenuTriggered) {
      window.api.onContextMenuTriggered((actionName) => {
        const callback = this.activeCallbacks.get(actionName);
        if (callback) {
          callback();
        }
        this.activeCallbacks.clear();
      });
    }
  }

  setMenu(name, actionsDict) {
    this.registeredMenus.set(name, actionsDict);
  }

  async openContextMenu(name, context = null) {
    const menuConfig = this.registeredMenus.get(name);
    if (!menuConfig) return;

    this.activeCallbacks.clear();
    const payload = [];

    for (const [key, action] of Object.entries(menuConfig)) {
      if (action.type === "separator") {
        payload.push({ type: "separator" });
        continue;
      }

      const actionName = action.name || key;
      if (action.callback) {
        this.activeCallbacks.set(actionName, () => action.callback(context));
      }

      payload.push({
        name: actionName,
        keys: action.keys || null,
      });
    }

    await window.api.openContextMenu(payload);
  }
}
