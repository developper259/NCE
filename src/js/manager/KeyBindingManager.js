class KeyBindingManager {
  constructor(e) {
    this.editor = e;
    this.isComposing = false;

    addEvent("keydown", this.onKey.bind(this));
    addEvent("compositionstart", this.onCompositionStart.bind(this));
    addEvent("compositionend", this.onCompositionEnd.bind(this));
  }

  isNativeInputTarget(target) {
    if (!target) return false;

    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return true;
    }

    if (target instanceof HTMLElement && target.isContentEditable) {
      return true;
    }

    if (
      target instanceof Element &&
      target.closest(
        "input, textarea, select, [contenteditable='true'], [contenteditable='']",
      )
    ) {
      return true;
    }

    return false;
  }

  isAgentMessageTarget(target) {
    return (
      target instanceof Element &&
      Boolean(
        target.closest(
          ".agent-sidebar-messages, .agent-sidebar, .sidebar, [data-sidebar]",
        ),
      )
    );
  }

  async copyNativeSelection() {
    const selection = window.getSelection?.();
    const text = selection?.toString?.() || "";
    if (!text) return false;
    try {
      if (document.execCommand?.("copy")) return true;
    } catch (error) {
      // Fall through to the asynchronous clipboard API.
    }
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      if (typeof window.api?.writeClipboardText === "function") {
        await window.api.writeClipboardText(text);
        return true;
      }
      console.error("Sidebar selection copy error:", error);
      return false;
    }
  }

  bindEditor(key, e) {
    // Special handling for space character - treat as normal character even if it's a keybinding
    if (e.key === " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (this.editor.tabManager.activeFile) {
        const handled = this.editor.smartTypingController?.handleCharacter(
          e.key,
          e,
        );
        if (!handled) {
          this.editor.writerController.write(e.key);
        }
      }
    } else if (CONFIG_KEYBINDING_CONTAINSKEY(key)) {
      this.editor.keyBinding.exec(CONFIG_KEYBINDING_GET_KEY(key), e);
    } else if (
      e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) &&
      CONFIG_KEYBINDING_CONTAINSKEY(e.key)
    ) {
      this.editor.keyBinding.exec(CONFIG_KEYBINDING_GET_KEY(e.key), e);
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      if (
        this.editor.tabManager.activeFile &&
        (e.key.length == 1 || e.key === " ")
      ) {
        const handled = this.editor.smartTypingController?.handleCharacter(
          e.key,
          e,
        );
        if (!handled) {
          this.editor.writerController.write(e.key);
        }
      }
    }

    e.preventDefault();
    e.stopPropagation();
  }

  bind(key, e) {
    if (CONFIG_KEYBINDING_CONTAINSKEY(key)) {
      const item = CONFIG_KEYBINDING_GET_KEY(key);

      if (item.in_editor == false) {
        this.editor.keyBinding.exec(item, e);
      }

      e.preventDefault();
      e.stopPropagation();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === " ") {
      // Handle space when editor is not selected
      if (this.editor.tabManager.activeFile) {
        this.editor.writerController.write(e.key);
      }
      e.preventDefault();
      e.stopPropagation();
    }
  }

  getShortcutKey(eventKey, e) {
    let key = "";
    if (["Control", "Meta", "Shift", "Alt"].includes(eventKey)) return eventKey;
    if (e.ctrlKey) key += "Ctrl+";
    if (e.metaKey) key += "Meta+";
    if (e.shiftKey) key += "Shift+";
    if (e.altKey) key += "Alt+";
    return key + eventKey;
  }

  bindNativeInput(key, e) {
    if (
      [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
        "Backspace",
        "Delete",
        "Enter",
        "Tab",
      ].includes(e.key) &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      return false;
    }
    if (!CONFIG_KEYBINDING_CONTAINSKEY(key)) return false;
    const item = CONFIG_KEYBINDING_GET_KEY(key);
    if (item?.in_editor !== false) {
      if (!this.executeNativeInputAction(item?.action, e.target)) return false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
    this.editor.keyBinding.exec(item, e);
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  executeNativeInputAction(action, target) {
    const element =
      target instanceof Element
        ? target.closest(
            "input, textarea, select, [contenteditable='true'], [contenteditable='']",
          )
        : null;
    if (!element) return false;

    if (["copy", "cut", "undo", "redo"].includes(action)) {
      return document.execCommand(action) === true;
    }

    if (action === "select_all") {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        element.select();
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return true;
    }

    if (action !== "paste") return false;
    const readClipboard = async () => {
      try {
        return await navigator.clipboard.readText();
      } catch (browserError) {
        if (typeof window.api?.readClipboardText === "function") {
          return window.api.readClipboardText();
        }
        throw browserError;
      }
    };
    void readClipboard()
      .then((text) => {
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          const start = element.selectionStart ?? element.value.length;
          const end = element.selectionEnd ?? start;
          element.setRangeText(text, start, end, "end");
          element.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          element.focus();
          document.execCommand("insertText", false, text);
        }
      })
      .catch((error) => console.error("Native input paste error:", error));
    return true;
  }

  executeAction(action, modifiers = {}) {
    const item = CONFIG_KEYBINDING_GET_ACTION(action);
    if (!item) return false;

    this.editor.keyBinding.exec(item, {
      shiftKey: modifiers.shiftKey === true,
      ctrlKey: modifiers.ctrlKey === true,
      metaKey: modifiers.metaKey === true,
      altKey: modifiers.altKey === true,
    });
    return true;
  }

  onKey(e) {
    if (this.isComposing || e.isComposing || e.keyCode === 229) return;
    const eventKey = CONFIG_KEYBINDING_EVENT_KEY(e);
    if (!eventKey) return;

    // Skip when a shortcut capture is active in settings
    if (document.querySelector(".setting-shortcut-btn.listening")) return;

    const isModifier = e.metaKey || e.ctrlKey;
    const key = eventKey.toLowerCase();
    if (isModifier && key === "c") {
      const selectedText = window.getSelection?.()?.toString?.() || "";
      if (selectedText) {
        void this.copyNativeSelection();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    if (!document.hasFocus()) return;

    const shortcutKey = this.getShortcutKey(eventKey, e);
    const binding = CONFIG_KEYBINDING_CONTAINSKEY(shortcutKey)
      ? CONFIG_KEYBINDING_GET_KEY(shortcutKey)
      : null;

    // Global UI shortcuts (sidebar, quick panel, etc.) are edge-triggered:
    // holding the key must not repeatedly toggle them. Editor shortcuts and
    // normal editing keys remain repeatable.
    const isEditorNavigation =
      typeof binding?.action === "string" &&
      binding.action.startsWith("move_");
    if (e.repeat && binding?.in_editor === false && !isEditorNavigation) return;

    if (this.isNativeInputTarget(e.target) && eventKey !== "Escape") {
      this.bindNativeInput(shortcutKey, e);
      return;
    }

    if (this.editor.selected) {
      this.bindEditor(shortcutKey, e);
    } else {
      this.bind(shortcutKey, e);
    }
  }

  onCompositionStart() {
    this.isComposing = true;
  }

  onCompositionEnd(event) {
    this.isComposing = false;
    if (this.isNativeInputTarget(event?.target)) return;

    const text = typeof event?.data === "string" ? event.data : "";
    if (text && this.editor.tabManager.activeFile)
      this.editor.writerController?.write(text);
  }
}
