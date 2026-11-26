/**
 * Language environment detail page.
 *
 * Presents one language as a single installable environment: a short header,
 * the concrete benefits of the environment, useful secondary information and
 * one primary action. Internal components, their versions and their dependency
 * plan stay in the model and in the optional details disclosure; they are never
 * presented as choices the user has to make.
 *
 * Installation still goes through the existing grouped component apply path.
 * This module only renders data and delegates actions to the manager.
 */
class VersionManagerLanguageDetail {
  static render(manager, languageId) {
    const view = manager.languageViews.get(languageId);
    if (!view) return null;
    const fragment = document.createDocumentFragment();
    const page = VersionManagerUI.element("div", "nce-vm-env-page");

    page.appendChild(VersionManagerUI.button("Retour", () => manager.closeDetail(), {
      className: "nce-vm-back nce-vm-env-back",
      icon: "fi-rr-arrow-small-left",
      focusKey: "vm-back",
    }));

    page.appendChild(VersionManagerLanguageDetail.header(manager, view));
    page.appendChild(VersionManagerLanguageDetail.benefits(view));
    page.appendChild(VersionManagerLanguageDetail.progress(manager, languageId));
    page.appendChild(VersionManagerLanguageDetail.action(manager, view));
    page.appendChild(VersionManagerLanguageDetail.details(view));

    fragment.appendChild(page);
    return fragment;
  }

  /** A. Header: discreet navigation, language icon, name, summary and state. */
  static header(manager, view) {
    const header = VersionManagerUI.element("header", "nce-vm-env-header");

    const icon = VersionManagerUI.element("span", "nce-vm-env-icon");
    icon.appendChild(VersionManagerUI.icon(view.icon || "fi-rr-code-simple"));
    header.appendChild(icon);

    const titles = VersionManagerUI.element("div", "nce-vm-env-titles");
    titles.appendChild(VersionManagerUI.element("h3", "nce-vm-env-name", view.name));
    const summary = view.summary || view.description;
    if (summary) titles.appendChild(VersionManagerUI.element("p", "nce-vm-env-summary", summary));
    header.appendChild(titles);

    const state = VersionManagerLanguageDetail.environmentState(view);
    const status = VersionManagerUI.element("span", `nce-vm-env-status nce-vm-env-status-${state.state}`);
    status.appendChild(VersionManagerUI.icon(state.icon));
    status.appendChild(VersionManagerUI.element("span", null, state.label));
    header.appendChild(status);
    return header;
  }

  /**
   * Environment state, derived from the real component plan and the running
   * operation. A partially installed environment is never reported as complete.
   */
  static environmentState(view) {
    const plan = view.plan;
    if (!plan) return { state: "unknown", label: "Chargement…", icon: "fi-rr-info" };
    if ((plan.blockers?.length || 0) > 0) {
      return { state: "error", label: "Installation incomplète", icon: "fi-rr-triangle-warning" };
    }
    const total = (view.components || []).length;
    const done = (plan.unchanged || []).length;
    if (done > 0 && done < total) {
      return { state: "partial", label: "Installation partielle", icon: "fi-rr-triangle-warning" };
    }
    if (done === total && total > 0) {
      return { state: "installed", label: "Installé", icon: "fi-rr-check-double" };
    }
    return { state: "available", label: "Disponible", icon: "fi-rr-download" };
  }

  /** B. Benefits: a plain list, never a grid of cards. */
  static benefits(view) {
    const section = VersionManagerUI.element("section", "nce-vm-env-benefits");
    section.appendChild(VersionManagerUI.element(
      "h4", "nce-vm-env-section-title", "Inclus dans cette installation",
    ));
    const list = VersionManagerUI.element("ul", "nce-vm-env-benefit-list");
    const items = view.benefits?.length
      ? view.benefits
      : (view.components || []).map((component) => ({
        title: component.name,
        description: component.description,
        icon: "fi-rr-check",
      }));
    for (const benefit of items) {
      const item = VersionManagerUI.element("li", "nce-vm-env-benefit");
      const icon = VersionManagerUI.element("span", "nce-vm-env-benefit-icon");
      icon.appendChild(VersionManagerUI.icon(benefit.icon || "fi-rr-check"));
      item.appendChild(icon);
      const body = VersionManagerUI.element("div", "nce-vm-env-benefit-body");
      body.appendChild(VersionManagerUI.element("span", "nce-vm-env-benefit-title", benefit.title));
      if (benefit.description) {
        body.appendChild(VersionManagerUI.element("span", "nce-vm-env-benefit-desc", benefit.description));
      }
      item.appendChild(body);
      list.appendChild(item);
    }
    section.appendChild(list);
    return section;
  }

  /** C. Secondary information: version and state, with technical details folded away. */
  static details(view) {
    const section = VersionManagerUI.element("section", "nce-vm-env-details");
    const toggle = VersionManagerUI.element("button", "nce-vm-env-details-toggle");
    toggle.type = "button";
    toggle.dataset.focusKey = `vm-env-details-${view.id}`;
    toggle.setAttribute("aria-expanded", "false");
    toggle.append(
      VersionManagerUI.icon("fi-rr-angle-small-right"),
      VersionManagerUI.element("span", null, "Détails"),
    );
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      panel.hidden = open;
    });
    section.appendChild(toggle);

    const panel = VersionManagerUI.element("div", "nce-vm-env-details-panel");
    panel.hidden = true;
    const rows = VersionManagerUI.element("div", "nce-vm-info-list");
    const versions = (view.components || [])
      .filter((component) => component.installableVersion && component.installableVersion !== "—")
      .map((component) => `${component.name} ${component.installableVersion}`);
    if (versions.length) rows.appendChild(VersionManagerUI.informationRow("Versions", versions.join(", ")));
    if (view.fileExtensions?.length) {
      rows.appendChild(VersionManagerUI.informationRow("Fichiers pris en charge", view.fileExtensions.join(", ")));
    }
    panel.appendChild(rows);
    section.appendChild(panel);
    return section;
  }

  /** D. One primary action. It applies the full recommended environment. */
  static action(manager, view) {
    const wrap = VersionManagerUI.element("div", "nce-vm-env-action");
    const applying = manager.languageApplying === view.id;
    const plan = view.plan;
    const complete = VersionManagerLanguageDetail.environmentState(view).state === "installed";
    const blocked = (plan?.blockers?.length || 0) > 0;

    let button;
    if (applying) {
      button = VersionManagerUI.element("div", "nce-vm-env-working");
      button.setAttribute("role", "status");
      button.append(
        VersionManagerUI.icon("fi-rr-refresh"),
        VersionManagerUI.element("span", null, "Installation en cours…"),
      );
    } else if (blocked) {
      button = VersionManagerUI.button(`Réparer ${view.name}`, () => manager.installFullLanguage(view.id), {
        className: "nce-vm-button nce-vm-button-primary",
        icon: "fi-rr-refresh",
        focusKey: `vm-apply-components-${view.id}`,
      });
    } else if (complete) {
      button = VersionManagerUI.button(`Désinstaller ${view.name}`, () => manager.askUninstallLanguage(view.id), {
        className: "nce-vm-button",
        icon: "fi-rr-trash",
        focusKey: `vm-uninstall-language-${view.id}`,
      });
    } else {
      button = VersionManagerUI.button(`Installer ${view.name}`, () => manager.installFullLanguage(view.id), {
        className: "nce-vm-button nce-vm-button-primary",
        icon: "fi-rr-download",
        focusKey: `vm-apply-components-${view.id}`,
      });
    }
    wrap.appendChild(button);

    if (manager.confirmation?.kind === "uninstall-language" && manager.confirmation.languageId === view.id) {
      wrap.appendChild(VersionManagerLanguageDetail.uninstallConfirmation(manager, view));
    }
    return wrap;
  }

  static uninstallConfirmation(manager, view) {
    const confirm = VersionManagerUI.element("div", "nce-vm-confirm nce-vm-env-confirm");
    confirm.setAttribute("role", "alertdialog");
    confirm.setAttribute("aria-label", `Confirmer la désinstallation de ${view.name}`);
    confirm.appendChild(VersionManagerUI.element(
      "p", "nce-vm-confirm-title", `Désinstaller ${view.name} ?`,
    ));
    confirm.appendChild(VersionManagerUI.element(
      "p", "nce-vm-confirm-text",
      "Les outils nécessaires aux autres langages installés sont conservés.",
    ));
    const actions = VersionManagerUI.element("div", "nce-vm-confirm-actions");
    actions.append(
      VersionManagerUI.button("Désinstaller", () => manager.confirmUninstallLanguage(view.id), {
        className: "nce-vm-button nce-vm-button-danger",
        focusKey: `vm-confirm-uninstall-language-${view.id}`,
      }),
      VersionManagerUI.button("Annuler", () => manager.cancelConfirmation(), {
        focusKey: `vm-cancel-uninstall-language-${view.id}`,
      }),
    );
    confirm.appendChild(actions);
    return confirm;
  }

  /** Progress messages, translated from component events to plain language. */
  static progress(manager, languageId) {
    const events = typeof manager.applyEventsFor === "function"
      ? manager.applyEventsFor(languageId)
      : [];
    const box = VersionManagerUI.element("div", "nce-vm-env-progress");
    if (!events.length) return box;
    const latest = events[events.length - 1];
    const line = VersionManagerUI.element(
      "p", `nce-vm-env-progress-line nce-vm-env-progress-${latest.state || "info"}`,
      latest.message || "Installation en cours…",
    );
    line.setAttribute("role", "status");
    box.appendChild(line);
    return box;
  }
}
