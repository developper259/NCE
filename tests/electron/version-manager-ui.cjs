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
    () => document.querySelectorAll(".nce-vm-stat").length === 3,
    "the overview stats to load from the real inventory",
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
  const widthRatio = dialogRect.width / view.width;
  const heightRatio = dialogRect.height / view.height;
  check(widthRatio >= 0.85 && widthRatio <= 0.95, `dialog width is immersive (${widthRatio})`);
  check(heightRatio >= 0.85 && heightRatio <= 0.95, `dialog height is immersive (${heightRatio})`);
  check(dialogRect.left >= 32 && dialogRect.top >= 32, "the dialog keeps visible margins");

  const stats = [...document.querySelectorAll(".nce-vm-stat-value")].map((node) => node.textContent);
  check(stats[1] === "1", "the planted installation is reported as functional");
  check(stats[2] === "0", "a healthy inventory needs no attention");

  // The planted directory is named 9.9.9 but its binary reports 2.56.1:
  // reconcile must trust the binary, not the folder name.
  const installedNav = document.querySelector('[data-focus-key="vm-nav-installed"]');
  installedNav.click();
  await waitFor(
    () => document.querySelectorAll('[data-focus-key^="vm-installation-"]').length === 1,
    "the imported installation to be listed",
  );
  const row = document.querySelector('[data-focus-key^="vm-installation-"]');
  check(row.textContent.includes("2.56.1"), "the version comes from the binary");
  check(row.textContent.includes(plantedInstallDir), "the real location is shown");
  check(!row.textContent.includes("9.9.9 ·"), "the folder name is not used as the version");

  const search = document.querySelector('[data-focus-key="vm-search"]');
  search.value = "zzz-no-match";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(
    () => main().textContent.includes("No installations match"),
    "the no-match empty state",
  );
  check(document.activeElement.dataset.focusKey === "vm-search", "search keeps focus across re-render");
  search.value = "";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(
    () => document.querySelectorAll('[data-focus-key^="vm-installation-"]').length === 1,
    "the installation to return after clearing the search",
  );

  document.querySelector('[data-focus-key^="vm-installation-"]').click();
  await waitFor(
    () => document.querySelector(".nce-vm-detail-name")?.textContent === "Git",
    "the Git detail view",
  );
  const detailText = main().textContent;
  check(detailText.includes("Managed by NCE"), "provenance is shown");
  check(detailText.includes(plantedInstallDir), "the detail shows the real location");
  check(detailText.includes(`${plantedInstallDir}/bin/git`), "the detail shows the executable");
  const info = await gitInfo();
  const externalPanel = document.querySelector(".nce-vm-badge-external");
  if (externalPanel) {
    check(info.external, "the external panel reflects a real detection");
    const panel = externalPanel.closest(".nce-vm-panel");
    check(!panel.querySelector("button"), "the external installation offers no actions");
    check(panel.textContent.includes("never modifies or uninstalls external tools"), "the external guarantee is stated");
  }
  const uninstallButtons = [...main().querySelectorAll("button")]
    .filter((button) => button.textContent.includes("Uninstall"));
  check(uninstallButtons.length === 1, "only the managed installation can be uninstalled");

  uninstallButtons[0].click();
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

  [...main().querySelectorAll("button")]
    .find((button) => button.textContent.includes("Uninstall")).click();
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

  host().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await waitFor(() => host().hidden, "Escape to close the popup");
  const sidebarButton = document.querySelector(".sidebar-version-manager-icon");
  check(Boolean(sidebarButton), "the sidebar exposes a Version Manager button");
  sidebarButton.click();
  await waitFor(() => !host().hidden, "the sidebar button to reopen the popup");
  const gearMenu = editor.contextMenuManager.registeredMenus.get("sidebar-settings");
  check(typeof gearMenu?.openVersionManager?.callback === "function", "the gear menu offers the Version Manager");

  document.querySelector('[data-focus-key="vm-nav-updates"]').click();
  await nextFrame();
  check(main().textContent.includes("Update checking is not available yet"), "Updates is honest about its limits");
  check(!/up to date/i.test(main().textContent), "Updates never claims packages are current");

  document.querySelector('[data-focus-key="vm-nav-available"]').click();
  await nextFrame();
  check(Boolean(document.querySelector('[data-focus-key="vm-install-git"]')), "Available offers a real Git install action");
  check(!main().textContent.includes("Update"), "no fake update actions are offered");

  document.querySelector('[data-focus-key="vm-nav-category:language"]').click();
  await nextFrame();
  check(main().textContent.includes("No languages tools yet"), "empty categories stay honest");

  return {
    opened: true,
    widthRatio,
    heightRatio,
    blur: hostStyle.backdropFilter,
    dialogBlur: dialogStyle.backdropFilter,
    stats,
    versionFromBinary: true,
    searchWorks: true,
    externalPanel: Boolean(externalPanel),
    confirmationSpecific: true,
    uninstalled: true,
    escapeClosed: true,
    sidebarReopened: true,
    updatesHonest: true,
  };
};