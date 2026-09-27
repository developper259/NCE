function buildAgentConversationContextMenu(sidebar) {
  return {
    rename: {
      name: "Rename",
      callback: (session) => sidebar.startRenameSession(session?.id),
    },
    close: {
      name: "Close",
      callback: (session) => sidebar.closeSession(session?.id),
    },
  };
}
