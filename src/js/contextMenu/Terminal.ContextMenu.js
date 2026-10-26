function terminalMenuShortcut(action) {
  const key = CONFIG_KEYBINDING_GET_ACTION(action)?.key;
  return key
    ? String(key).replace(/(^|\+)Mod(?=\+|$)/gi, "$1CommandOrControl")
    : null;
}

function createTerminalMenuHelpers(editor) {
  const panel = () => editor.terminalPanel || null;
  const sessionFor = (context) => panel()?.getSession?.(context?.id) || null;
  const activeSessionFor = (context) => {
    const session = sessionFor(context);
    return session && panel()?.isActive?.(session) ? session : null;
  };
  const sessionCount = () => panel()?.sessions?.size ?? 0;
  const createTerminal = () => {
    void panel()?.createTerminal?.();
  };
  const closeSession = (context) => {
    const session = sessionFor(context);
    if (session) void panel()?.closeSession?.(session.id);
  };
  return {
    panel,
    sessionFor,
    activeSessionFor,
    sessionCount,
    createTerminal,
    closeSession,
  };
}

function buildTerminalContextMenu(editor) {
  const {
    panel,
    sessionFor,
    activeSessionFor,
    createTerminal,
    closeSession,
  } = createTerminalMenuHelpers(editor);
  const runAction = (action, context) => {
    if (!activeSessionFor(context)) return;
    void panel()?.runAction?.(action);
  };

  return {
    selectAll: {
      name: "Select All",
      keys: () => terminalMenuShortcut("select_all"),
      enabled: (context) => Boolean(activeSessionFor(context)),
      callback: (context) => runAction("select-all", context),
    },
    copy: {
      name: "Copy Selection",
      keys: () => terminalMenuShortcut("copy"),
      enabled: (context) =>
        Boolean(activeSessionFor(context)?.terminal?.getSelection?.()),
      callback: (context) => runAction("copy", context),
    },
    paste: {
      name: "Paste",
      keys: () => terminalMenuShortcut("paste"),
      enabled: (context) => Boolean(activeSessionFor(context)),
      callback: (context) => runAction("paste", context),
    },
    sep1: { type: "separator" },
    clear: {
      name: "Clear Terminal",
      enabled: (context) => Boolean(activeSessionFor(context)),
      callback: (context) => runAction("clear", context),
    },
    sep2: { type: "separator" },
    newTerminal: {
      name: "New Terminal",
      keys: () => terminalMenuShortcut("new_terminal"),
      enabled: () => Boolean(panel()),
      callback: createTerminal,
    },
    close: {
      name: "Close Terminal",
      keys: () => terminalMenuShortcut("close_file"),
      enabled: (context) => Boolean(sessionFor(context)),
      callback: closeSession,
    },
  };
}

function buildTerminalTabContextMenu(editor) {
  const { panel, sessionFor, sessionCount, createTerminal, closeSession } =
    createTerminalMenuHelpers(editor);

  return {
    newTerminal: {
      name: "New Terminal",
      keys: () => terminalMenuShortcut("new_terminal"),
      enabled: () => Boolean(panel()),
      callback: createTerminal,
    },
    rename: {
      name: "Rename",
      enabled: (context) => Boolean(sessionFor(context)),
      callback: (context) => {
        const session = sessionFor(context);
        if (session) panel()?.renameSession?.(session.id);
      },
    },
    sep1: { type: "separator" },
    close: {
      name: "Close",
      keys: () => terminalMenuShortcut("close_file"),
      enabled: (context) => Boolean(sessionFor(context)),
      callback: closeSession,
    },
    closeOthers: {
      name: "Close Others",
      enabled: (context) => Boolean(sessionFor(context)) && sessionCount() > 1,
      callback: (context) => {
        const session = sessionFor(context);
        if (session) panel()?.closeOtherSessions?.(session.id);
      },
    },
    closeAll: {
      name: "Close All",
      enabled: () => sessionCount() > 0,
      callback: () => {
        void panel()?.closeAllSessions?.();
      },
    },
  };
}
