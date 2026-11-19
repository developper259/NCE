module.exports = async function exerciseVersionManagerUI(plantedInstallDir) {
  const check = (condition, message) => {
    if (!condition) throw Error(message);
  };
  const nextFrame = () => new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 250);
  });
  const waitFor = async (predicate, description, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error(`Timed out waiting for ${description}`);
  };
  const rectOf = (element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
  };
  const main = () => document.querySelector(".nce-vm-main");
  const host = () => document.querySelector(".nce-vm-host");
  const state = () => window.api.versionManager.getState();
  const gitInfo = async () => (await state()).packages.find((entry) => entry.id === "git");

  // Geometry assertions must not depend on Chromium's animation scheduler.
  const motionStyle = document.createElement("style");
  motionStyle.textContent = ".nce-vm-host, .nce-vm-dialog { transition: none !important; }";
  document.head.appendChild(motionStyle);

  check(typeof editor.openVersionManager === "function", "Editor exposes openVersionManager");
  check(editor._versionManager == null, "the Version Manager is lazy until first open");
  check(editor.openVersionManager() === true, "the popup opens");
  await waitFor(() => host() && !host().hidden, "the popup host to become visible");
  await waitFor(
    () => document.querySelectorAll(".nce-vm-group-title").length === 1,
    "the single catalog page to load from the real inventory",
  );
  await nextFrame();

  const dialog = document.querySelector(".nce-vm-dialog");
  const hostStyle = getComputedStyle(host());
  const dialogStyle = getComputedStyle(dialog);
  const dialogRect = rectOf(dialog);
  const view = { width: innerWidth, height: innerHeight };
  check(dialog.getAttribute("role") === "dialog", "the popup is a dialog");
  check(dialog.getAttribute("aria-modal") === "true", "the dialog is modal");
  check(hostStyle.position === "fixed", "the backdrop covers the viewport");
  check(Number(hostStyle.zIndex) === 55, "the popup stacks above editor panels");
  check(hostStyle.backgroundColor === "rgba(0, 0, 0, 0.55)", "the backdrop is semi-transparent black");
  check(hostStyle.backdropFilter.includes("blur(6px)"), `the backdrop blurs the editor behind (got ${JSON.stringify(hostStyle.backdropFilter)})`);
  check(dialogStyle.backdropFilter === "none", "the popup itself is never blurred");
  // The dialog is sized by CSS to min(900px, 100vw - 88px) by
  // min(600px, 100vh - 88px). Compare against that real target instead of a
  // viewport ratio: macOS runners expose a shorter viewport than the 600px
  // cap, so a fixed ratio bound rejects a correctly sized dialog.
  const expectedWidth = Math.min(900, view.width - 88);
  const expectedHeight = Math.min(600, view.height - 88);
  const compactSize = Math.abs(dialogRect.width - expectedWidth) <= 1
    && Math.abs(dialogRect.height - expectedHeight) <= 1;
  check(compactSize, `dialog matches its compact size (${dialogRect.width}x${dialogRect.height} vs ${expectedWidth}x${expectedHeight})`);
  check(dialogRect.left >= 32 && dialogRect.top >= 32, "the dialog keeps visible margins");

  const sectionTitles = [...document.querySelectorAll(".nce-vm-group-title")].map((node) => node.textContent);
  check(sectionTitles.join("|") === "Installed", `only the non-empty section is rendered (got ${sectionTitles.join("|")})`);
  check(!main().textContent.includes("No packages available."), "the empty Available section is hidden");
  check(document.querySelectorAll('[data-focus-key^="vm-nav-"]').length === 0, "there is no section navigation");
  check(document.querySelectorAll(".nce-vm-stat").length === 0, "there is no dashboard statistics block");
  check(document.querySelector(".nce-vm-footer-status").textContent.includes("1 installed"), "the footer reports real ownership");

  // The planted directory is named 9.9.9 but its binary reports 2.56.1:
  // reconcile must trust the binary, not the folder name.
  await waitFor(
    () => document.querySelectorAll('[data-focus-key="vm-details-git"]').length === 1,
    "the imported installation to be listed",
  );
  const card = document.querySelector('[data-focus-key="vm-details-git"]');
  check(card.textContent.includes("2.56.1"), "the version comes from the binary");
  check(card.textContent.includes("Installed"), "the card marks the package as installed");
  check(!card.textContent.includes("9.9.9"), "the folder name is not used as the version");

  const search = document.querySelector('[data-focus-key="vm-search"]');
  search.focus();
  search.value = "zzz-no-match";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(
    () => main().textContent.includes("No packages match"),
    "the no-match empty state",
  );
  check(document.activeElement.dataset.focusKey === "vm-search", "search keeps focus across re-render");
  search.value = "";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(
    () => document.querySelectorAll('[data-focus-key="vm-details-git"]').length === 1,
    "the installation to return after clearing the search",
  );

  document.querySelector('[data-focus-key="vm-details-git"]').click();
  await waitFor(
    () => document.querySelector(".nce-vm-detail-name")?.textContent === "Git",
    "the Git detail view",
  );
  const headerControls = document.querySelector(".nce-vm-header-controls");
  check(headerControls.hidden === true, "the detail page hides the catalog search and filters");
  check(getComputedStyle(headerControls).display === "none",
    "the hidden catalog controls take no space");
  const columnsOf = () => [...document.querySelectorAll(".nce-vm-detail-col")];
  const leftCol = () => columnsOf()[0];
  const rightCol = () => columnsOf()[1];
  const tracks = () => getComputedStyle(document.querySelector(".nce-vm-detail-columns"))
    .gridTemplateColumns.split(" ").length;
  check(columnsOf().length === 2, "the detail page has two columns");
  check(leftCol().textContent.includes("State and installations"), "the left column covers state and installations");
  check(rightCol().textContent.includes("About") && rightCol().textContent.includes("Information"),
    "the right column covers about and information");
  check(tracks() === 2, "both columns render side by side at full window size");
  const detailText = main().textContent;
  check(detailText.includes("Managed by NCE"), "provenance is shown");
  check(detailText.includes(plantedInstallDir), "the detail shows the real location");
  check(detailText.includes(`${plantedInstallDir}/bin/git`), "the detail shows the executable");
  const info = await gitInfo();
  check(rightCol().textContent.includes(info.description), "the about column shows the full description");
  const homepage = rightCol().querySelector("a.nce-vm-link");
  check(
    Boolean(homepage) &&
    new URL(homepage.href).href === new URL(info.homepage).href &&
    homepage.target === "_blank",
    "the homepage is a real external link",
  );
  check(!document.querySelector(".nce-vm-detail-header .nce-vm-category-tag"),
    "categories are not duplicated in the header");
  const externalZone = document.querySelector(".nce-vm-install-zone-external");
  if (externalZone) {
    check(info.external, "the external zone reflects a real detection");
    check(!externalZone.querySelector("button"), "the external installation offers no actions");
    check(externalZone.textContent.includes("never modifies or uninstalls external tools"), "the external guarantee is stated");
  }
  const uninstallButtons = [...main().querySelectorAll("button")]
    .filter((button) => button.textContent.includes("Uninstall"));
  check(uninstallButtons.length === 1 + info.installations.length,
    "header shortcut plus one action per managed installation");
  check(uninstallButtons.every((button) => !externalZone?.contains(button)),
    "no uninstall action targets the external installation");

  // The two-column block sits low on the page with a wide gutter between
  // installations and package information.
  const headerRect = rectOf(document.querySelector(".nce-vm-detail-header"));
  const columnsElement = document.querySelector(".nce-vm-detail-columns");
  const columnsRect = rectOf(columnsElement);
  check(columnsRect.top >= headerRect.bottom + 24,
    `the detail columns sit below the header (${columnsRect.top - headerRect.bottom}px)`);
  const columnsStyle = getComputedStyle(columnsElement);
  check(columnsStyle.columnGap === "40px",
    `the two columns keep a wide gutter (got ${columnsStyle.columnGap})`);
  check(rectOf(rightCol()).left - rectOf(leftCol()).right >= 39,
    "the second column is separated from the first");

  const backButton = document.querySelector('[data-focus-key="vm-back"]');
  check(Boolean(backButton), "the detail page offers a Back action");
  backButton.click();
  await waitFor(
    () => document.querySelectorAll('[data-focus-key="vm-details-git"]').length === 1,
    "the catalog to return after Back",
  );
  await nextFrame();
  check(headerControls.hidden === false, "Back restores the catalog search and filters");
  check(getComputedStyle(headerControls).display !== "none",
    "the restored catalog controls take space again");
  check(document.activeElement?.dataset?.focusKey === "vm-details-git",
    "Back returns focus to the package card");
  document.querySelector('[data-focus-key="vm-details-git"]').click();
  await waitFor(
    () => document.querySelector(".nce-vm-detail-name")?.textContent === "Git",
    "the Git detail view to reopen",
  );
  await nextFrame();

  // Window adaptation: stack below the breakpoint, keep paths readable, scroll.
  const locationValue = [...leftCol().querySelectorAll(".nce-vm-field-value")]
    .find((node) => node.textContent.includes(plantedInstallDir));
  check(locationValue.scrollWidth <= locationValue.clientWidth, "the install path wraps instead of clipping");
  check(main().scrollWidth <= main().clientWidth, "no horizontal overflow at full size");
  window.resizeTo(800, 700);
  await waitFor(() => innerWidth === 800, "the window to reach its minimum width");
  await nextFrame();
  check(tracks() === 1, "the columns stack on a small window");
  check(main().scrollWidth <= main().clientWidth, "no horizontal overflow when stacked");
  check(locationValue.scrollWidth <= locationValue.clientWidth, "paths stay readable when stacked");
  check(main().scrollHeight > main().clientHeight, "the stacked detail scrolls vertically");
  main().scrollTop = 120;
  check(main().scrollTop > 0, "the detail scroll container responds");
  main().scrollTop = 0;
  window.resizeTo(1100, 760);
  // macOS clamps windows to the display work area, so require a viewport
  // past the stacking breakpoint instead of an exact pixel width.
  await waitFor(() => innerWidth >= 900, "the window to return to a wide layout");
  await nextFrame();
  check(tracks() === 2, "the two columns return on a large window");

  document.querySelector('[data-focus-key^="vm-uninstall-"]').click();
  await waitFor(() => document.querySelector(".nce-vm-confirm"), "the uninstall confirmation");
  const confirmText = document.querySelector(".nce-vm-confirm").textContent;
  check(confirmText.includes("Uninstall Git 2.56.1?"), "the confirmation names the package and version");
  check(confirmText.includes(plantedInstallDir), "the confirmation names the exact location");
  check(
    info.external
      ? confirmText.includes("fall back to the external installation")
      : confirmText.includes("Settings pointing at this installation will be cleared"),
    "the confirmation states the real consequences",
  );
  document.querySelector('[data-focus-key^="vm-cancel-uninstall-"]').click();
  await waitFor(() => !document.querySelector(".nce-vm-confirm"), "the confirmation to dismiss");
  check((await gitInfo()).installations.length === 1, "cancelling keeps the installation");

  document.querySelector('[data-focus-key^="vm-uninstall-"]').click();
  await waitFor(() => document.querySelector(".nce-vm-confirm"), "the confirmation to reopen");
  document.querySelector('[data-focus-key^="vm-confirm-uninstall-"]').click();
  await waitFor(
    async () => (await gitInfo()).installations.length === 0,
    "the real uninstall to remove the installation",
  );
  await waitFor(
    () => main().textContent.includes("Not installed"),
    "the detail to reflect the removal",
  );
  check(Boolean(document.querySelector('[data-focus-key="vm-install-git"]')),
    "the header offers the install action again after removal");
  const headerInstall = document.querySelector('[data-focus-key="vm-install-git"]');
  const detailNameRect = rectOf(document.querySelector(".nce-vm-detail-name"));
  const headerInstallRect = rectOf(headerInstall);
  check(headerInstall.closest(".nce-vm-detail-header") !== null,
    "the install action belongs to the detail header");
  check(headerInstallRect.left > detailNameRect.right,
    "the install action sits to the right of the package name");
  check(headerInstallRect.top < detailNameRect.bottom,
    "the install action does not sit below the package name");
  // Escape refuses to close while an operation is running; let the uninstall
  // settle in the manager's own state, not only in the main-process store.
  await waitFor(() => !editor.versionManager.activeOperation(), "the uninstall operation to settle");

  host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await waitFor(() => host().hidden, "Escape to close the popup");
  const sidebarButton = document.querySelector(".sidebar-version-manager-icon");
  check(Boolean(sidebarButton), "the sidebar exposes a Version Manager button");
  sidebarButton.click();
  await waitFor(() => !host().hidden, "the sidebar button to reopen the popup");
  await waitFor(
    () => document.querySelectorAll(".nce-vm-group-title").length === 1,
    "the single page to reload after reopening",
  );
  check(document.querySelector(".nce-vm-group-title").textContent === "Available",
    "only the non-empty Available section renders after the uninstall");

  // With a short detail page the two columns anchor to the bottom instead of
  // floating directly under the header.
  document.querySelector('[data-focus-key="vm-details-git"]').click();
  await waitFor(
    () => document.querySelector(".nce-vm-detail-name")?.textContent === "Git",
    "the short Git detail view",
  );
  await nextFrame();
  check(main().scrollHeight <= main().clientHeight + 1,
    "the short detail fits without scrolling");
  const shortMainRect = rectOf(main());
  const shortColumnsRect = rectOf(document.querySelector(".nce-vm-detail-columns"));
  const mainPaddingBottom = Number.parseFloat(getComputedStyle(main()).paddingBottom);
  check(Math.abs((shortMainRect.bottom - mainPaddingBottom) - shortColumnsRect.bottom) <= 1,
    "the two columns sit against the bottom of the page");
  document.querySelector('[data-focus-key="vm-back"]').click();
  await waitFor(
    () => document.querySelectorAll('[data-focus-key="vm-details-git"]').length === 1,
    "the catalog to return after the short detail",
  );
  await nextFrame();

  const gearMenu = editor.contextMenuManager.registeredMenus.get("sidebar-settings");
  check(typeof gearMenu?.openVersionManager?.callback === "function", "the gear menu offers the Version Manager");
  check(document.querySelectorAll('[data-focus-key^="vm-nav-"]').length === 0, "reopening has no section navigation");
  check(Boolean(document.querySelector('[data-focus-key="vm-install-git"]')), "Available offers a real Git install action");
  check(!main().textContent.includes("Update"), "no fake update actions are offered");

  check(!document.querySelector('[data-focus-key="vm-sort"]'), "there is no sort control");
  const filterButtons = [...document.querySelectorAll('[data-focus-key^="vm-filter-"]')];
  check(filterButtons.length === 4, "the header keeps four category filters");
  check(!document.querySelector('[data-focus-key="vm-filter-runtimes"]'), "removed filters are gone");

  document.querySelector('[data-focus-key="vm-filter-languages"]').click();
  await nextFrame();
  check(main().textContent.includes("No language packages yet"), "empty categories stay honest");
  document.querySelector('[data-focus-key="vm-filter-tools"]').click();
  await nextFrame();
  check(Boolean(document.querySelector('[data-focus-key="vm-install-git"]')), "the Tools filter exposes Git");
  check(document.querySelector('[data-focus-key="vm-filter-all"]').getAttribute("aria-pressed") === "false", "the active filter is exposed");

  const availableToggle = document.querySelector('[data-focus-key="vm-collapse-available"]');
  const installedToggle = document.querySelector('[data-focus-key="vm-collapse-installed"]');
  check(Boolean(availableToggle), "the Available section exposes a collapse button");
  check(installedToggle === null, "the empty Installed section is not rendered at all");
  check(availableToggle.getAttribute("aria-expanded") === "true", "the Available section starts expanded");
  availableToggle.click();
  await nextFrame();
  check(document.querySelector('[data-focus-key="vm-collapse-available"]').getAttribute("aria-expanded") === "false", "the Available section collapses");
  check(document.getElementById("nce-vm-section-available").hidden === true, "the Available body is hidden");
  document.querySelector('[data-focus-key="vm-collapse-available"]').click();
  await nextFrame();
  check(document.getElementById("nce-vm-section-available").hidden === false, "the Available section expands again");

  // Every work surface that opens must dismiss the modal: quick panel modes,
  // sidebars and tabs all route through the same dismissal hooks.
  const reopen = async () => {
    editor.openVersionManager();
    await waitFor(() => !host().hidden, "the popup to reopen");
  };
  const expectClosed = (label) => waitFor(() => host().hidden, `${label} to close the popup`);
  const closePanel = () => editor.quickPanel.close({ notifyCancel: false, restoreFocus: false });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 240));
  const expectPanelFocus = (label) =>
    check(
      document.activeElement === editor.quickPanel.input,
      `${label} keeps focus after the popup finishes closing`,
    );

  await reopen();
  editor.keyBinding.control_open_command();
  await expectClosed("the command palette");
  await settle();
  expectPanelFocus("the command palette");
  closePanel();

  await reopen();
  editor.goToLine.open();
  await expectClosed("Go to Line");
  await settle();
  expectPanelFocus("Go to Line");
  closePanel();

  await reopen();
  editor.sidebarManager.openMenu(editor.fileExplorer.id);
  await expectClosed("the explorer sidebar");

  await reopen();
  await editor.openSettings();
  await expectClosed("the settings tab");

  await reopen();
  await waitFor(
    () => document.querySelectorAll(".nce-vm-group-title").length === 1,
    "the catalog to survive the dismissal round-trip",
  );

  return {
    opened: true,
    compactSize,
    dialogWidth: dialogRect.width,
    dialogHeight: dialogRect.height,
    blur: hostStyle.backdropFilter,
    dialogBlur: dialogStyle.backdropFilter,
    sectionsOrdered: true,
    noNavigation: true,
    versionFromBinary: true,
    searchWorks: true,
    externalZone: Boolean(externalZone),
    twoColumns: true,
    stackedSmall: true,
    homepageLink: true,
    confirmationSpecific: true,
    uninstalled: true,
    escapeClosed: true,
    sidebarReopened: true,
    filtersWork: true,
    collapseWorks: true,
    paletteClosed: true,
    goToLineClosed: true,
    sidebarClosed: true,
    settingsTabClosed: true,
  };
};