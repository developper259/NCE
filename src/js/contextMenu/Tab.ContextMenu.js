function buildTabContextMenu(tabManager) {
  const getIndex = (file) =>
    file ? tabManager.getFileIndexByID(file.id) : -1;

  return {
    close: {
      name: "Close",
      keys: "CommandOrControl+W",
      enabled: (file) => getIndex(file) !== -1,
      callback: (file) => tabManager.closeFile(file.id),
    },
    closeOthers: {
      name: "Close Others",
      enabled: (file) => getIndex(file) !== -1 && tabManager.files.length > 1,
      callback: (file) => tabManager.closeOtherFiles(file),
    },
    sep1: { type: "separator" },
    closeLeft: {
      name: "Close to the Left",
      enabled: (file) => getIndex(file) > 0,
      callback: (file) => tabManager.closeFilesToLeft(file),
    },
    closeRight: {
      name: "Close to the Right",
      enabled: (file) => {
        const index = getIndex(file);
        return index !== -1 && index < tabManager.files.length - 1;
      },
      callback: (file) => tabManager.closeFilesToRight(file),
    },
    sep2: { type: "separator" },
    closeAll: {
      name: "Close All",
      enabled: () => tabManager.files.length > 0,
      callback: () => tabManager.closeFiles(),
    },
  };
}
