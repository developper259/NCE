/**
 * Unified package detail page.
 *
 * Every package uses the same vertical structure: a compact header, then
 * Installation / Components / Package Information sections. Only the data
 * changes between packages; the layout and the building blocks are shared.
 * This module renders only what the catalog already provides and delegates
 * every install/verify/uninstall action to the manager unchanged.
 */
class VersionManagerPackageDetail {
  static render(manager) {
    const packageInfo = manager.packageById(manager.selectedPackageId);
    if (!packageInfo) return null;
    const state = VersionManagerModel.installationState(packageInfo, manager.operations);
    const fragment = document.createDocumentFragment();
    const page = VersionManagerUI.element("div", "nce-vm-detail-page");

    page.appendChild(VersionManagerUI.button("Back", () => manager.closeDetail(), {
      className: "nce-vm-back",
      icon: "fi-rr-arrow-small-left",
      focusKey: "vm-back",
    }));

    page.appendChild(VersionManagerPackageDetail.header(manager, packageInfo, state));

    const installation = VersionManagerPackageDetail.installationSection(manager, packageInfo, state);
    if (installation) page.appendChild(installation);

    const information = VersionManagerPackageDetail.informationSection(packageInfo);
    if (information) page.appendChild(information);

    fragment.appendChild(page);
    return fragment;
  }

  static header(manager, packageInfo, state) {
    const header = VersionManagerUI.element("div", "nce-vm-detail-header");

    const icon = VersionManagerUI.element("span", "nce-vm-detail-icon");
    icon.appendChild(VersionManagerUI.icon(packageInfo.icon));
    header.appendChild(icon);

    const titles = VersionManagerUI.element("div", "nce-vm-detail-titles");
    const nameRow = VersionManagerUI.element("div", "nce-vm-detail-name-row");
    nameRow.append(
      VersionManagerUI.element("h3", "nce-vm-detail-name", packageInfo.name),
      VersionManagerUI.categoryTag(VersionManagerModel.categorySummary(packageInfo)),
      VersionManagerUI.badge(state),
    );
    titles.appendChild(nameRow);
    if (packageInfo.description) {
      titles.appendChild(VersionManagerUI.element("p", "nce-vm-detail-description", packageInfo.description));
    }
    header.appendChild(titles);

    const actions = VersionManagerPackageDetail.actions(manager, packageInfo, state);
    actions.classList.add("nce-vm-detail-actions");
    header.appendChild(actions);
    return header;
  }

  static operationFor(manager, packageId) {
    return manager.operations.get(packageId) ||
      manager.snapshot?.operations?.find((operation) =>
        operation.packageId === packageId && operation.state === "running") ||
      null;
  }

  static actions(manager, packageInfo, state) {
    const primary = [];
    const installed = VersionManagerModel.isInstalled(packageInfo);
    if (state === "installing") {
      primary.push(VersionManagerUI.button("Cancel install", () => manager.cancelOperation(packageInfo.id), {
        className: "nce-vm-button",
        focusKey: `vm-cancel-install-${packageInfo.id}`,
        icon: "fi-rr-cross-small",
      }));
    } else if (!installed && packageInfo.supported && packageInfo.capabilities.includes("install")) {
      primary.push(VersionManagerUI.button(`Install · ${packageInfo.installableVersion}`, () => manager.install(packageInfo.id), {
        className: "nce-vm-button nce-vm-button-primary",
        focusKey: `vm-install-${packageInfo.id}`,
        icon: "fi-rr-download",
      }));
    } else if (!packageInfo.supported) {
      primary.push(VersionManagerUI.element("span", "nce-vm-detail-hint", "Not available on this platform"));
    } else if (installed && state !== "uninstalling") {
      const record = VersionManagerModel.primaryInstallation(packageInfo);
      if (record) {
        const operation = VersionManagerPackageDetail.operationFor(manager, packageInfo.id);
        primary.push(
          VersionManagerUI.button("Verify", () => manager.verify(record.id), {
            icon: "fi-rr-refresh",
            disabled: Boolean(operation),
            focusKey: `vm-verify-${record.id}`,
          }),
          VersionManagerUI.button("Uninstall", () => manager.askUninstall(record.id), {
            className: "nce-vm-button nce-vm-button-danger",
            focusKey: `vm-header-uninstall-${record.id}`,
            icon: "fi-rr-trash",
            disabled: Boolean(operation),
          }),
        );
      }
    }
    return VersionManagerUI.actionArea(primary);
  }

  static installationSection(manager, packageInfo, state) {
    const section = VersionManagerUI.element("section", "nce-vm-detail-section");
    section.appendChild(VersionManagerUI.sectionHeader("Installation"));

    if (packageInfo.lastError) section.appendChild(VersionManagerPackageDetail.errorPanel(manager, packageInfo));

    const operation = VersionManagerPackageDetail.operationFor(manager, packageInfo.id);
    if (operation) section.appendChild(VersionManagerPackageDetail.progress(operation));

    const installations = packageInfo.installations || [];
    if (!installations.length) {
      section.appendChild(VersionManagerUI.element(
        "p",
        "nce-vm-note",
        packageInfo.supported
          ? "Not installed. NCE can install this package into its managed tools directory."
          : "Not installed. No distribution exists for this platform.",
      ));
    }
    for (const record of installations) {
      section.appendChild(VersionManagerPackageDetail.installation(manager, packageInfo, record, operation));
    }

    if (packageInfo.external) {
      section.appendChild(VersionManagerPackageDetail.externalZone(packageInfo));
    }
    return section;
  }

  static progress(operation) {
    const wrap = VersionManagerUI.element("div", "nce-vm-install-progress");
    const percent = Number.isFinite(operation.progress?.percent) ? Math.round(operation.progress.percent) : null;
    const step = operation.progress?.step || (operation.kind === "uninstall" ? "Uninstalling" : "Working");
    wrap.appendChild(VersionManagerUI.element(
      "span",
      "nce-vm-install-progress-label",
      percent === null ? `${step}…` : `${step} · ${percent}%`,
    ));
    const track = VersionManagerUI.element("div", "nce-vm-progress-track");
    const fill = VersionManagerUI.element("div", "nce-vm-progress-fill");
    fill.style.width = percent === null ? "100%" : `${percent}%`;
    if (percent === null) fill.classList.add("nce-vm-progress-indeterminate");
    track.appendChild(fill);
    wrap.appendChild(track);
    return wrap;
  }

  static installation(manager, packageInfo, record, operation) {
    const block = VersionManagerUI.element("div", "nce-vm-installation nce-vm-install-zone");
    const head = VersionManagerUI.element("div", "nce-vm-installation-head");
    head.append(
      VersionManagerUI.element("span", "nce-vm-install-version", record.version),
      VersionManagerUI.badge(record.state),
      VersionManagerUI.element("span", "nce-vm-provenance", "Managed by NCE"),
    );
    block.appendChild(head);

    const rows = VersionManagerUI.element("div", "nce-vm-info-list");
    rows.append(
      VersionManagerUI.informationRow("Executable", record.executable, { mono: true, title: record.executable }),
      VersionManagerUI.informationRow("Platform", `${record.platform} / ${record.arch}`),
      VersionManagerUI.informationRow("Installed", VersionManagerUI.formatDate(record.installedAt)),
      VersionManagerUI.informationRow(
        "Last verified",
        record.verifiedAt ? VersionManagerUI.formatDateTime(record.verifiedAt) : "Never",
      ),
    );
    block.appendChild(rows);

    if (record.error) {
      block.appendChild(VersionManagerUI.element(
        "p",
        "nce-vm-error-text",
        `${record.error.code}: ${record.error.message}`,
      ));
    }

    const confirming = manager.confirmation?.kind === "uninstall" && manager.confirmation.installationId === record.id;
    const uninstalling = record.state === "uninstalling" || operation?.kind === "uninstall";
    if (confirming) {
      block.appendChild(VersionManagerPackageDetail.uninstallConfirmation(manager, packageInfo, record));
    } else if (uninstalling) {
      block.appendChild(VersionManagerUI.element("p", "nce-vm-note", "Uninstalling…"));
    }
    return block;
  }

  static externalZone(packageInfo) {
    const zone = VersionManagerUI.element("div", "nce-vm-installation nce-vm-install-zone nce-vm-install-zone-external");
    const head = VersionManagerUI.element("div", "nce-vm-installation-head");
    head.append(
      VersionManagerUI.element("span", "nce-vm-install-title", "External installation"),
      VersionManagerUI.element("span", "nce-vm-install-version", packageInfo.external.version || ""),
      VersionManagerUI.badge("external"),
      VersionManagerUI.element("span", "nce-vm-provenance", "Detected on your system"),
    );
    zone.appendChild(head);

    const rows = VersionManagerUI.element("div", "nce-vm-info-list");
    rows.append(
      VersionManagerUI.informationRow("Executable", packageInfo.external.executable, {
        mono: true,
        title: packageInfo.external.executable,
      }),
    );
    zone.appendChild(rows);
    zone.appendChild(VersionManagerUI.element(
      "p",
      "nce-vm-note",
      "This installation is managed outside NCE. You can keep using it normally; the Version Manager never modifies or uninstalls external tools.",
    ));
    return zone;
  }

  static informationSection(packageInfo) {
    const rows = VersionManagerUI.element("div", "nce-vm-info-list");
    if (packageInfo.publisher) {
      rows.appendChild(VersionManagerUI.informationRow("Publisher", packageInfo.publisher));
    }
    if (packageInfo.installableVersion) {
      rows.appendChild(VersionManagerUI.informationRow("Installable version", packageInfo.installableVersion, { mono: true }));
    }
    const categories = VersionManagerModel.categoryLabels(packageInfo);
    if (categories.length) {
      rows.appendChild(VersionManagerUI.informationRow("Categories", categories.join(", ")));
    }
    if (packageInfo.homepage) {
      rows.appendChild(VersionManagerUI.informationRow("Homepage", packageInfo.homepage, { link: true }));
    }
    if (packageInfo.platforms?.length) {
      rows.appendChild(VersionManagerUI.informationRow("Platforms", packageInfo.platforms.join(", ")));
    }
    if (!rows.children.length) return null;

    const section = VersionManagerUI.element("section", "nce-vm-detail-section");
    section.appendChild(VersionManagerUI.sectionHeader("Package Information"));
    section.appendChild(rows);
    return section;
  }

  static uninstallConfirmation(manager, packageInfo, record) {
    const wrap = VersionManagerUI.element("div", "nce-vm-confirm");
    wrap.setAttribute("role", "alertdialog");
    wrap.setAttribute("aria-label", `Confirm uninstall of ${packageInfo.name}`);
    wrap.appendChild(VersionManagerUI.element(
      "p",
      "nce-vm-confirm-title",
      `Uninstall ${packageInfo.name} ${record.version}?`,
    ));
    const parts = [`This permanently removes ${record.installDir}.`];
    if (packageInfo.managedSettings?.length) {
      parts.push(
        packageInfo.external
          ? "NCE will fall back to the external installation if one is available."
          : "Settings pointing at this installation will be cleared.",
      );
    }
    wrap.appendChild(VersionManagerUI.element("p", "nce-vm-confirm-text", parts.join(" ")));
    const buttons = VersionManagerUI.element("div", "nce-vm-confirm-actions");
    buttons.append(
      VersionManagerUI.button("Uninstall", () => manager.confirmUninstall(record.id), {
        className: "nce-vm-button nce-vm-button-danger",
        icon: "fi-rr-trash",
        focusKey: `vm-confirm-uninstall-${record.id}`,
      }),
      VersionManagerUI.button("Cancel", () => manager.cancelConfirmation(), {
        focusKey: `vm-cancel-uninstall-${record.id}`,
      }),
    );
    wrap.appendChild(buttons);
    return wrap;
  }

  static errorPanel(manager, packageInfo) {
    const panel = VersionManagerUI.element("div", "nce-vm-error");
    panel.setAttribute("role", "alert");
    const icon = VersionManagerUI.icon("fi-rr-cross-circle");
    const body = VersionManagerUI.element("div", "nce-vm-error-body");
    body.append(
      VersionManagerUI.element("p", "nce-vm-error-title", `Operation failed (${packageInfo.lastError.code})`),
      VersionManagerUI.element("p", "nce-vm-error-text", packageInfo.lastError.message),
    );
    panel.append(icon, body);
    if (packageInfo.capabilities.includes("install") && !(packageInfo.installations || []).length) {
      panel.appendChild(VersionManagerUI.button("Retry", () => manager.install(packageInfo.id), {
        icon: "fi-rr-rotate-right",
        focusKey: `vm-retry-${packageInfo.id}`,
      }));
    }
    return panel;
  }
}
