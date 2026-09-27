function buildAgentMessageContextMenu(sidebar) {
  return {
    copy: {
      name: "Copy",
      keys: "CommandOrControl+C",
      enabled: (message) => typeof message?.content === "string" && message.content.length > 0,
      callback: (message) => sidebar.copyMessageContent(message),
    },
  };
}
