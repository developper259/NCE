/** Reusable package detail page. */
class VersionManagerPackageDetail {
  static render(manager) {
    const packageInfo = manager.packageById(manager.selectedPackageId);
    if (!packageInfo) return null;
    const state = VersionManagerModel.installationState(packageInfo, manager.operations);
    const fragment = document.createDocumentFragment();

    fragment.appendChild(VersionManagerUI.button("Back", () => manager.closeDetail(), {
      className: "nce-vm-back",
      icon: "fi-rr-caret-square-left",
      focusKey: "vm-back",
    }));

    const header = VersionManagerUI.element("div", "nce-vm-detail-header");
    const icon = VersionManagerUI.element("span", "nce-vm-detail-icon");
    icon.appendChild(VersionManagerUI.icon(packageInfo.icon));
    const titles = VersionManagerUI.element("div", "nce-vm-detail-titles");
    titles.append(
      VersionManagerUI.element("h3", "nce-vm-detail-name", packageInfo.name),
      VersionManagerUI.element("p", "nce-vm-detail-description", packageInfo.description),
    );
    const badges = VersionManagerUI.element("div", "nce-vm-detail-badges");
    badges.appendChild(VersionManagerUI.badge(state));
    for (const category of packageInfo.categories || [])
      badges.appendChild(VersionManagerUI.categoryTag(category));
    header.append(icon, titles, badges);
    fragment.appendChild(header);
    fragment.appendChild(VersionManagerPackageDetail.actions(manager, packageInfo, state));
    fragment.appendChild(VersionManagerPackageDetail.meta(packageInfo));

    if (packageInfo.lastError) fragment.appendChild(VersionManagerPackageDetail.errorPanel(manager, packageInfo));

    const installations = packageInfo.installations || [];
    fragment.appendChild(VersionManagerUI.element(
      "h4",
      "nce-vm-subheading",
      `Installations (${installations.length})`,
    ));
    if (!installations.length) {
      fragment.appendChild(VersionManagerPackageDetail.notInstalled(packageInfo, state));
    }
    for (const record of installations) {
      fragment.appendChild(VersionManagerPackageDetail.installation(manager, packageInfo, record));
    }

    if (packageInfo.external) {
      fragment.appendChild(VersionManagerUI.element("h4", "nce-vm-subheading", "External installation"));
      const panel = VersionManagerUI.element("div", "nce-vm-panel nce-vm-panel-external");
      const badgeRow = VersionManagerUI.element("div", "nce-vm-panel-head");
      badgeRow.appendChild(VersionManagerUI.badge("external"));
      panel.appendChild(badgeRow);
      panel.append(
        VersionManagerPackageDetail.field("Executable", packageInfo.external.executable, { mono: true, title: packageInfo.external.executable }),
        VersionManagerPackageDetail.field("Version", packageInfo.external.version),
      );
      panel.appendChild(VersionManagerUI.element(
        "p",
        "nce-vm-note",
        "Detected on this system. The Version Manager never modifies or uninstalls external tools.",
      ));
      fragment.appendChild(panel);
    }
    return fragment;
  }

  static actions(manager, packageInfo, state) {
    const row = VersionManagerUI.element("div", "nce-vm-detail-actions");
    const installed = VersionManagerModel.isInstalled(packageInfo);
    if (state === "installing") {
      row.appendChild(VersionManagerUI.button("Cancel install", () => manager.cancelOperation(packageInfo.id), {
        className: "nce-vm-button",
        focusKey: `vm-cancel-install-${packageInfo.id}`,
        icon: "fi-rr-cross-small",
      }));
    } else if (!installed && packageInfo.supported && packageInfo.capabilities.includes("install")) {
      row.appendChild(VersionManagerUI.button(`Install ${packageInfo.installableVersion}`, () => manager.install(packageInfo.id), {
        className: "nce-vm-button nce-vm-button-primary",
        focusKey: `vm-install-${packageInfo.id}`,
        icon: "fi-rr-download",
      }));
    } else if (!packageInfo.supported) {
      row.appendChild(VersionManagerUI.element("span", "nce-vm-detail-hint", "Not available on this platform"));
    } else if (installed) {
      row.appendChild(VersionManagerUI.element(
        "span",
        "nce-vm-detail-hint",
        `Managed by NCE · ${packageInfo.installations.length} installation${packageInfo.installations.length === 1 ? "" : "s"}`,
      ));
    }
    return row;
  }

  static meta(packageInfo) {
    const meta = VersionManagerUI.element("div", "nce-vm-detail-meta");
    meta.append(
      VersionManagerPackageDetail.field("Publisher", packageInfo.publisher),
      VersionManagerPackageDetail.field("Categories", VersionManagerModel.categoryLabels(packageInfo).join(", ")),
      VersionManagerPackageDetail.field("Installable version", packageInfo.installableVersion),
      VersionManagerPackageDetail.field("Homepage", packageInfo.homepage, { mono: true }),
    );
    return meta;
  }

  static notInstalled(packageInfo, state) {
    let title = "Not installed";
    let description = packageInfo.supported
      ? "NCE can install this package into its managed tools directory."
      : "No distribution exists for this platform.";
    if (state === "installing") {
      title = "Installing…";
      description = "The installation is running. Progress is shown in the status bar.";
    }
    return VersionManagerUI.emptyState("fi-rr-database", title, description);
  }

  static field(label, value, options = {}) {
    const row = VersionManagerUI.element("div", "nce-vm-field");
    const term = VersionManagerUI.element("span", "nce-vm-field-label", label);
    const definition = VersionManagerUI.element("span", "nce-vm-field-value", value || "—");
    if (options.mono) definition.classList.add("nce-vm-mono");
    if (options.title) definition.title = options.title;
    row.append(term, definition);
    return row;
  }

  static installation(manager, packageInfo, record) {
    const panel = VersionManagerUI.element("div", "nce-vm-panel");
    const head = VersionManagerUI.element("div", "nce-vm-panel-head");
    head.append(
      VersionManagerUI.element("span", "nce-vm-panel-version", record.version),
      VersionManagerUI.badge(record.state),
      VersionManagerUI.element("span", "nce-vm-provenance", "Managed by NCE"),
    );

    // Keep the installation actions in view without scrolling past the
    // provenance fields, while each installation keeps its own controls.
    const busy = manager.activeOperation();
    const actionRow = VersionManagerUI.element("div", "nce-vm-panel-actions");
    const confirming = manager.confirmation?.kind === "uninstall" && manager.confirmation.installationId === record.id;
    if (confirming) {
      actionRow.appendChild(VersionManagerPackageDetail.uninstallConfirmation(manager, packageInfo, record));
    } else if (record.state === "uninstalling" || busy?.kind === "uninstall") {
      actionRow.appendChild(VersionManagerUI.element("span", "nce-vm-note", "Uninstalling…"));
    } else {
      actionRow.append(
        VersionManagerUI.button("Verify", () => manager.verify(record.id), {
          icon: "fi-rr-refresh",
          disabled: Boolean(busy),
          focusKey: `vm-verify-${record.id}`,
        }),
        VersionManagerUI.button("Uninstall", () => manager.askUninstall(record.id), {
          className: "nce-vm-button nce-vm-button-danger",
          icon: "fi-rr-trash",
          disabled: Boolean(busy),
          focusKey: `vm-uninstall-${record.id}`,
        }),
      );
    }

    panel.appendChild(head);
    panel.appendChild(actionRow);
    panel.append(
      VersionManagerPackageDetail.field("Location", record.installDir, { mono: true, title: record.installDir }),
      VersionManagerPackageDetail.field("Executable", record.executable, { mono: true, title: record.executable }),
      VersionManagerPackageDetail.field("Platform", `${record.platform} / ${record.arch}`),
      VersionManagerPackageDetail.field("Installed", VersionManagerUI.formatDate(record.installedAt)),
      VersionManagerPackageDetail.field("Last verified", record.verifiedAt ? VersionManagerUI.formatDateTime(record.verifiedAt) : "Never"),
    );
    if (record.source?.url) {
      panel.appendChild(VersionManagerPackageDetail.field("Source", record.source.url, { mono: true, title: record.source.url }));
      if (record.source.checksum) {
        panel.appendChild(VersionManagerPackageDetail.field(
          `Checksum (${record.source.checksumAlgorithm || "sha256"})`,
          record.source.checksum,
          { mono: true },
        ));
      }
    }
    if (record.error) {
      panel.appendChild(VersionManagerUI.element(
        "p",
        "nce-vm-error-text",
        `${record.error.code}: ${record.error.message}`,
      ));
    }
    return panel;
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
