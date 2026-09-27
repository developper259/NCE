function buildSidebarTitleContextMenu(sidebarManager) {
  return (context) => {
    const current = sidebarManager.menus.get(context?.menuId);
    if (!current) return {};

    const actions = {
      toggleCurrent: {
        name: `${current.isOpen ? "Close" : "Open"} '${current.title}'`,
        callback: () => current.isOpen
          ? sidebarManager.closeMenu(current.id)
          : sidebarManager.openMenu(current.id),
      },
      separator: { type: "separator" },
    };

    for (const menu of sidebarManager.menus.values()) {
      if (!menu.isOpen && menu.id !== "agent") continue;
      actions[`sidebar-${menu.id}`] = {
        name: `${menu.isOpen ? "✓ " : ""}${menu.title}`,
        callback: () => menu.isOpen
          ? sidebarManager.closeMenu(menu.id)
          : sidebarManager.openMenu(menu.id),
      };
    }
    return actions;
  };
}
