/**
 * Run action: the Run/Stop control in the editor's tab strip.
 *
 * One control that reflects the run it belongs to. It is not a toolbar: it
 * sits at the end of the tab strip, next to the file it acts on, because Run
 * is an action on the active file rather than a mode of the editor.
 *
 * The button is the only place that decides what a click means, and it decides
 * from the controller's state, not from its own memory of what it last sent.
 * That is what keeps a double click from starting two processes.
 */

class RunAction {
  constructor(editor) {
    this.editor = editor;
    this.panel = null;

    this.element = document.createElement("div");
    this.element.className = "run-action";

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "run-action-button";
    this.button.setAttribute("aria-label", "Run the active file");

    this.icon = document.createElement("span");
    this.icon.className = "run-action-icon";
    this.icon.setAttribute("aria-hidden", "true");

    this.label = document.createElement("span");
    this.label.className = "run-action-label";
    this.label.textContent = "Run";

    this.button.append(this.icon, this.label);
    this.element.append(this.button);

    this.button.addEventListener("click", () => void this.onClick());
    this.render();
  }

  /** Attach to the tab strip, once the DOM exists. */
  mount() {
    const strip = document.querySelector?.(".file-manager");
    if (!strip || !strip.parentElement) return false;
    // The strip is absolutely positioned; the action is a sibling pinned to
    // its right edge so it never scrolls away with the tabs.
    strip.parentElement.insertBefore(this.element, strip.nextSibling);
    return true;
  }

  /** The panel this action drives, created lazily by the bottom panel. */
  getPanel() {
    if (this.panel) return this.panel;
    const panel = this.editor.runPanel;
    if (panel) this.panel = panel;
    return this.panel;
  }

  /**
   * What the button should say and do right now.
   *
   * `mode` is one of: run, stop, stopping, disabled.
   */
  resolveMode() {
    const panel = this.getPanel();
    const controller = panel?.controller;
    if (controller) {
      if (controller.isStopping) return { mode: "stopping" };
      if (controller.canStop) return { mode: "stop" };
    }
    const target = RunPanel.describeRunTarget(this.editor.tabManager?.activeFile);
    if (!target.runnable) return { mode: "disabled", reason: target.reason };
    return { mode: "run", target };
  }

  render() {
    const { mode, reason } = this.resolveMode();

    this.element.dataset.mode = mode;
    this.button.disabled = mode === "disabled" || mode === "stopping";
    this.button.setAttribute("aria-disabled", String(this.button.disabled));

    if (mode === "stop" || mode === "stopping") {
      this.icon.dataset.icon = "stop";
      this.label.textContent = mode === "stopping" ? "Stopping" : "Stop";
      this.button.title =
        mode === "stopping" ? "Waiting for the program to exit" : "Stop the running program";
      this.button.setAttribute("aria-label", this.button.title);
      return;
    }

    this.icon.dataset.icon = "run";
    this.label.textContent = "Run";
    if (mode === "disabled") {
      this.button.title = reason || "This file cannot be run";
      this.button.setAttribute("aria-label", this.button.title);
      return;
    }
    this.button.title = `Run ${this.editor.tabManager?.activeFile?.name || "the active file"}`;
    this.button.setAttribute("aria-label", this.button.title);
  }

  async onClick() {
    const { mode } = this.resolveMode();
    if (mode === "disabled" || mode === "stopping") return;

    if (mode === "stop") {
      this.render();
      await this.getPanel()?.stop();
      this.render();
      return;
    }

    // Show the panel before starting, so the first output has somewhere to go.
    await this.editor.bottomPanelManager?.openPanel?.("run", { focus: false });
    this.render();
    const result = await this.getPanel()?.run();
    this.render();
    return result;
  }

  /** Called when the active file changes, or a run changes state. */
  refresh() {
    this.render();
  }
}

if (typeof window !== "undefined") window.RunAction = RunAction;
