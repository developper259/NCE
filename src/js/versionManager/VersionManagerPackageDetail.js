/** Package detail page: full-width header above two balanced columns. */
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

    const header = VersionManagerUI.element("div", "nce-vm-detail-header");
    const icon = VersionManagerUI.element("span", "nce-vm-detail-icon");
    icon.appendChild(VersionManagerUI.icon(packageInfo.icon));
    const titles = VersionManagerUI.element("div", "nce-vm-detail-titles");
    const nameRow = VersionManagerUI.element("div", "nce-vm-detail-name-row");
    nameRow.append(
      VersionManagerUI.element("h3", "nce-vm-detail-name", packageInfo.name),
      VersionManagerUI.badge(state),
    );
    titles.appendChild(nameRow);
    if (packageInfo.description) {
      titles.appendChild(VersionManagerUI.element("p", "nce-vm-detail-description", packageInfo.description));
    }
    header.append(icon, titles, VersionManagerPackageDetail.actions(manager, packageInfo, state));
    page.appendChild(header);

    const columns = VersionManagerUI.element("div", "nce-vm-detail-columns");
    columns.appendChild(VersionManagerPackageDetail.installationsColumn(manager, packageInfo, state));
    columns.appendChild(VersionManagerPackageDetail.aboutColumn(packageInfo));
    page.appendChild(columns);
    fragment.appendChild(page);
    return fragment;
  }

  static operationFor(manager, packageId) {
    return manager.operations.get(packageId) ||
      manager.snapshot?.operations?.find((operation) =>
        operation.packageId === packageId && operation.state === "running") ||
      null;
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
      row.appendChild(VersionManagerUI.button(`Install · ${packageInfo.installableVersion}`, () => manager.install(packageInfo.id), {
        className: "nce-vm-button nce-vm-button-primary",
        focusKey: `vm-install-${packageInfo.id}`,
        icon: "fi-rr-download",
      }));
    } else if (!packageInfo.supported) {
      row.appendChild(VersionManagerUI.element("span", "nce-vm-detail-hint", "Not available on this platform"));
    } else if (installed && state !== "uninstalling") {
      const primary = VersionManagerModel.primaryInstallation(packageInfo);
      if (primary) {
        row.appendChild(VersionManagerUI.button("Uninstall", () => manager.askUninstall(primary.id), {
          className: "nce-vm-button nce-vm-button-danger",
          focusKey: `vm-header-uninstall-${primary.id}`,
          icon: "fi-rr-trash",
        }));
      }
    }
    return row;
  }

  static installationsColumn(manager, packageInfo, state) {
    const column = VersionManagerUI.element("section", "nce-vm-detail-col");
    column.appendChild(VersionManagerUI.element("h4", "nce-vm-detail-col-title", "State and installations"));
    if (packageInfo.lastError) column.appendChild(VersionManagerPackageDetail.errorPanel(manager, packageInfo));

    const operation = VersionManagerPackageDetail.operationFor(manager, packageInfo.id);
    const zone = VersionManagerUI.element("div", "nce-vm-install-zone");
    const head = VersionManagerUI.element("div", "nce-vm-install-head");
    head.append(
      VersionManagerUI.element("span", "nce-vm-install-title", "NCE installation"),
      VersionManagerUI.badge(state),
    );
    zone.appendChild(head);
    if (operation) zone.appendChild(VersionManagerPackageDetail.progress(operation));

    const installations = packageInfo.installations || [];
    if (!installations.length) {
      zone.appendChild(VersionManagerUI.element(
        "p",
        "nce-vm-note",
        packageInfo.supported
          ? "Not installed. NCE can install this package into its managed tools directory."
          : "Not installed. No distribution exists for this platform.",
      ));
    }
    for (const record of installations) {
      zone.appendChild(VersionManagerPackageDetail.installation(manager, packageInfo, record, operation));
    }
    column.appendChild(zone);

    if (packageInfo.external) {
      column.appendChild(VersionManagerPackageDetail.externalZone(packageInfo));
    }
    return column;
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

  static aboutColumn(packageInfo) {
    const column = VersionManagerUI.element("section", "nce-vm-detail-col");
    if (packageInfo.description) {
      column.appendChild(VersionManagerUI.element("h4", "nce-vm-detail-col-title", "About"));
      column.appendChild(VersionManagerUI.element("p", "nce-vm-detail-about", packageInfo.description));
    }
    const infoTitle = VersionManagerUI.element(
      "h4",
      packageInfo.description ? "nce-vm-detail-col-title nce-vm-detail-col-title-spaced" : "nce-vm-detail-col-title",
      "Information",
    );
    column.appendChild(infoTitle);
    const meta = VersionManagerUI.element("div", "nce-vm-detail-meta");
    if (packageInfo.publisher) meta.appendChild(VersionManagerPackageDetail.field("Publisher", packageInfo.publisher));
    if (packageInfo.installableVersion) {
      meta.appendChild(VersionManagerPackageDetail.field("Installable version", packageInfo.installableVersion, { mono: true }));
    }
    const categories = VersionManagerModel.categoryLabels(packageInfo);
    if (categories.length) meta.appendChild(VersionManagerPackageDetail.field("Categories", categories.join(", ")));
    if (packageInfo.homepage) {
      meta.appendChild(VersionManagerPackageDetail.field("Homepage", packageInfo.homepage, { link: true }));
    }
    if (packageInfo.platforms?.length) {
      meta.appendChild(VersionManagerPackageDetail.field("Platforms", packageInfo.platforms.join(", ")));
    }
    column.appendChild(meta);
    return column;
  }

  static field(label, value, options = {}) {
    const row = VersionManagerUI.element("div", "nce-vm-field");
    const term = VersionManagerUI.element("span", "nce-vm-field-label", label);
    let definition;
    if (options.link) {
      definition = document.createElement("a");
      definition.className = "nce-vm-link";
      definition.setAttribute("href", value);
      definition.setAttribute("target", "_blank");
      definition.setAttribute("rel", "noopener noreferrer");
      definition.textContent = value;
    } else {
      definition = VersionManagerUI.element("span", "nce-vm-field-value", value || "—");
    }
    if (options.mono) definition.classList.add("nce-vm-mono");
    if (options.title) definition.title = options.title;
    row.append(term, definition);
    return row;
  }

  static installation(manager, packageInfo, record, operation) {
    const block = VersionManagerUI.element("div", "nce-vm-installation");
    const head = VersionManagerUI.element("div", "nce-vm-installation-head");
    head.append(
      VersionManagerUI.element("span", "nce-vm-install-version", record.version),
      VersionManagerUI.badge(record.state),
      VersionManagerUI.element("span", "nce-vm-provenance", "Managed by NCE"),
    );
    block.appendChild(head);
    block.append(
      VersionManagerPackageDetail.field("Location", record.installDir, { mono: true, title: record.installDir }),
      VersionManagerPackageDetail.field("Executable", record.executable, { mono: true, title: record.executable }),
      VersionManagerPackageDetail.field("Platform", `${record.platform} / ${record.arch}`),
      VersionManagerPackageDetail.field("Installed", VersionManagerUI.formatDate(record.installedAt)),
      VersionManagerPackageDetail.field("Last verified", record.verifiedAt ? VersionManagerUI.formatDateTime(record.verifiedAt) : "Never"),
    );
    if (record.source?.url) {
      block.appendChild(VersionManagerPackageDetail.field("Source", record.source.url, { mono: true, title: record.source.url }));
      if (record.source.checksum) {
        block.appendChild(VersionManagerPackageDetail.field(
          `Checksum (${record.source.checksumAlgorithm || "sha256"})`,
          record.source.checksum,
          { mono: true },
        ));
      }
    }
    if (record.error) {
      block.appendChild(VersionManagerUI.element(
        "p",
        "nce-vm-error-text",
        `${record.error.code}: ${record.error.message}`,
      ));
    }

    const actionRow = VersionManagerUI.element("div", "nce-vm-install-actions");
    const confirming = manager.confirmation?.kind === "uninstall" && manager.confirmation.installationId === record.id;
    const uninstalling = record.state === "uninstalling" || operation?.kind === "uninstall";
    if (confirming) {
      actionRow.appendChild(VersionManagerPackageDetail.uninstallConfirmation(manager, packageInfo, record));
    } else if (uninstalling) {
      actionRow.appendChild(VersionManagerUI.element("span", "nce-vm-note", "Uninstalling…"));
    } else {
      actionRow.append(
        VersionManagerUI.button("Verify", () => manager.verify(record.id), {
          icon: "fi-rr-refresh",
          disabled: Boolean(operation),
          focusKey: `vm-verify-${record.id}`,
        }),
        VersionManagerUI.button("Uninstall", () => manager.askUninstall(record.id), {
          className: "nce-vm-button nce-vm-button-danger",
          icon: "fi-rr-trash",
          disabled: Boolean(operation),
          focusKey: `vm-uninstall-${record.id}`,
        }),
      );
    }
    block.appendChild(actionRow);
    return block;
  }

  static externalZone(packageInfo) {
    const zone = VersionManagerUI.element("div", "nce-vm-install-zone nce-vm-install-zone-external");
    const head = VersionManagerUI.element("div", "nce-vm-install-head");
    head.append(
      VersionManagerUI.element("span", "nce-vm-install-title", "External installation"),
      VersionManagerUI.badge("external"),
    );
    zone.appendChild(head);
    zone.appendChild(VersionManagerUI.element("p", "nce-vm-note", "Detected on your system."));
    zone.append(
      VersionManagerPackageDetail.field("Version", packageInfo.external.version),
      VersionManagerPackageDetail.field("Executable", packageInfo.external.executable, { mono: true, title: packageInfo.external.executable }),
    );
    zone.appendChild(VersionManagerUI.element(
      "p",
      "nce-vm-note",
      "This installation is managed outside NCE. You can keep using it normally; the Version Manager never modifies or uninstalls external tools.",
    ));
    return zone;
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