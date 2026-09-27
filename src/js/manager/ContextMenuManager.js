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
    const registeredMenu = this.registeredMenus.get(name);
    const menuConfig = typeof registeredMenu === "function"
      ? registeredMenu(context)
      : registeredMenu;
    if (!menuConfig) return;

    this.activeCallbacks.clear();
    const payload = [];

    for (const [key, action] of Object.entries(menuConfig)) {
      if (action.type === "separator") {
        payload.push({ type: "separator" });
        continue;
      }

      const actionName = typeof action.name === "function"
        ? action.name(context)
        : action.name || key;
      const enabled =
        typeof action.enabled === "function"
          ? action.enabled(context)
          : action.enabled !== false;
      if (enabled && action.callback) {
        this.activeCallbacks.set(actionName, () => action.callback(context));
      }

      payload.push({
        name: actionName,
        type: action.type,
        checked: typeof action.checked === "function"
          ? action.checked(context)
          : action.checked === true,
        keys:
          typeof action.keys === "function"
            ? action.keys(context)
            : action.keys || null,
        enabled,
      });
    }

    await window.api.openContextMenu(payload);
  }
}
