/** Compact package card used by the Installed and Available sections. */
class VersionManagerPackageCard {
  static render(packageInfo, manager) {
    const installed = VersionManagerModel.isInstalled(packageInfo);
    const state = VersionManagerModel.installationState(packageInfo, manager.operations);
    const version = VersionManagerModel.packageVersion(packageInfo);
    let badge = state;
    if (!installed && state === "not-installed") badge = packageInfo.supported ? "available" : "unavailable";

    const card = VersionManagerUI.element("article", "nce-vm-card");
    if (installed) card.classList.add("nce-vm-card-installed");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "nce-vm-card-main";
    open.dataset.focusKey = `vm-details-${packageInfo.id}`;
    open.setAttribute("aria-label", `Open ${packageInfo.name} details`);

    const top = VersionManagerUI.element("span", "nce-vm-card-top");
    const icon = VersionManagerUI.element("span", "nce-vm-card-icon");
    icon.appendChild(VersionManagerUI.icon(packageInfo.icon));
    top.append(icon, VersionManagerUI.badge(badge));

    const name = VersionManagerUI.element("span", "nce-vm-card-name", packageInfo.name);
    const description = VersionManagerUI.element("span", "nce-vm-card-description", packageInfo.description);
    const meta = VersionManagerUI.element("span", "nce-vm-card-meta");
    meta.append(
      VersionManagerUI.element("span", "nce-vm-card-category", VersionManagerModel.categorySummary(packageInfo)),
      VersionManagerUI.element("span", "nce-vm-card-version", version || "—"),
    );
    open.append(top, name, description, meta);
    open.addEventListener("click", () => manager.openDetail(packageInfo.id));

    const foot = VersionManagerUI.element("div", "nce-vm-card-foot");
    if (state === "installing") {
      foot.appendChild(VersionManagerUI.button("Cancel install", () => manager.cancelOperation(packageInfo.id), {
        className: "nce-vm-button nce-vm-card-action",
        focusKey: `vm-row-cancel-${packageInfo.id}`,
        icon: "fi-rr-cross-small",
      }));
    } else if (state === "uninstalling") {
      foot.appendChild(VersionManagerUI.element("span", "nce-vm-card-hint", "Uninstalling…"));
    } else if (!installed && packageInfo.supported && packageInfo.capabilities.includes("install")) {
      foot.appendChild(VersionManagerUI.button("Install", () => manager.install(packageInfo.id), {
        className: "nce-vm-button nce-vm-button-primary nce-vm-card-action",
        focusKey: `vm-install-${packageInfo.id}`,
        icon: "fi-rr-download",
      }));
    } else if (!installed && !packageInfo.supported) {
      foot.appendChild(VersionManagerUI.element("span", "nce-vm-card-hint", "Not available on this platform"));
    } else if (installed) {
      foot.append(
        VersionManagerUI.element("span", "nce-vm-card-hint", "Managed by NCE"),
        VersionManagerUI.button("Manage", () => manager.openDetail(packageInfo.id), {
          className: "nce-vm-button nce-vm-card-action",
          focusKey: `vm-manage-${packageInfo.id}`,
        }),
      );
    } else {
      foot.appendChild(VersionManagerUI.element("span", "nce-vm-card-hint", "Managed by NCE"));
    }

    card.append(open, foot);
    return card;
  }
}
