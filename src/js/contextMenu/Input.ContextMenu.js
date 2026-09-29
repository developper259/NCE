function buildInputContextMenu(editor) {
  const getSelection = (element) => {
    if (!element) return { hasSelection: false, hasContent: false };
    if (element.matches("input, textarea")) {
      const value = element.value || "";
      const start = element.selectionStart;
      const end = element.selectionEnd;
      return {
        hasSelection: Number.isInteger(start) && Number.isInteger(end) && end > start,
        hasContent: value.length > 0,
      };
    }
    if (element.matches("select")) {
      return {
        hasSelection: element.selectedIndex >= 0,
        hasContent: element.options.length > 0,
      };
    }
    const selection = window.getSelection?.();
    return {
      hasSelection: Boolean(selection?.toString()),
      hasContent: Boolean(element.textContent),
    };
  };
  const isEditable = (element) =>
    !element.disabled && !element.readOnly &&
    (element.matches("input, textarea, select") || element.isContentEditable);
  const run = (action, element) =>
    editor.keyBindingManager?.executeNativeInputAction(action, element);

  return {
    cut: {
      name: "Cut",
      keys: "CommandOrControl+X",
      enabled: (element) => isEditable(element) &&
        element.type !== "password" && getSelection(element).hasSelection,
      callback: (element) => run("cut", element),
    },
    copy: {
      name: "Copy",
      keys: "CommandOrControl+C",
      enabled: (element) => element.type !== "password" &&
        getSelection(element).hasSelection,
      callback: (element) => run("copy", element),
    },
    paste: {
      name: "Paste",
      keys: "CommandOrControl+V",
      enabled: (element) => isEditable(element),
      callback: (element) => run("paste", element),
    },
    separator: { type: "separator" },
    selectAll: {
      name: "Select All",
      keys: "CommandOrControl+A",
      enabled: (element) => getSelection(element).hasContent,
      callback: (element) => run("select_all", element),
    },
  };
}
