function buildSidebarSelectorEmptyContextMenu(sidebarManager) {
  const actions = {};
  for (const menu of USERCONFIG_SIDEBAR_MENUS) {
    actions[`menu-${menu.id}`] = {
      name: () => `${sidebarManager.isMenuVisible(menu.id) ? "✓ " : ""}${menu.title}`,
      callback: () => sidebarManager.setMenuVisible(
        menu.id,
        !sidebarManager.isMenuVisible(menu.id),
      ),
    };
  }
  return actions;
}

function buildSidebarSelectorIconContextMenu(sidebarManager) {
  return (context) => {
    const current = USERCONFIG_SIDEBAR_MENUS.find(
      (menu) => menu.id === context?.menuId,
    );
    if (!current) return buildSidebarSelectorEmptyContextMenu(sidebarManager);

    const actions = {
      toggleCurrent: {
        name: `${sidebarManager.isMenuVisible(current.id) ? "Hide" : "Show"} '${current.title}'`,
        callback: () => sidebarManager.setMenuVisible(
          current.id,
          !sidebarManager.isMenuVisible(current.id),
        ),
      },
      openCurrent: {
        name: "Open",
        enabled: !sidebarManager.menus.get(current.id)?.isOpen,
        callback: () => sidebarManager.openMenu(current.id),
      },
      closeCurrent: {
        name: "Close",
        enabled: sidebarManager.menus.get(current.id)?.isOpen === true,
        callback: () => sidebarManager.closeMenu(current.id),
      },
      separator: { type: "separator" },
    };
    for (const menu of USERCONFIG_SIDEBAR_MENUS) {
      actions[`menu-${menu.id}`] = {
        name: () => `${sidebarManager.isMenuVisible(menu.id) ? "✓ " : ""}${menu.title}`,
        callback: () => sidebarManager.setMenuVisible(
          menu.id,
          !sidebarManager.isMenuVisible(menu.id),
        ),
      };
    }
    return actions;
  };
}
