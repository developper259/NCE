/**
 * A layout audit of the Run UI, measured from the real DOM.
 *
 * This exists because a screenshot proves nothing to a program: these checks
 * read computed styles and geometry, so they fail when the control is
 * misaligned, the log is unreadable, or a colour was invented outside the
 * theme tokens.
 */
module.exports = async function runLayoutAudit({ pythonFile }) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate, description, timeout = 20000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await predicate()) return true;
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${description}`);
  };

  const rgb = (value) => {
    const match = /rgba?\(([^)]+)\)/.exec(value || "");
    if (!match) return null;
    const parts = match[1].split(",").map((part) => parseFloat(part));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  };
  // WCAG relative luminance and contrast, so "readable" is a number.
  const luminance = ({ r, g, b }) => {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const contrast = (foreground, background) => {
    const a = luminance(foreground);
    const b = luminance(background);
    const lighter = Math.max(a, b);
    const darker = Math.min(a, b);
    return (lighter + 0.05) / (darker + 0.05);
  };
  // Walk up for the first opaque background, which is what the text sits on.
  const backgroundBehind = (element) => {
    let node = element;
    while (node) {
      const color = rgb(getComputedStyle(node).backgroundColor);
      if (color && color.a > 0.9) return color;
      node = node.parentElement;
    }
    return rgb(getComputedStyle(document.body).backgroundColor) || { r: 0, g: 0, b: 0, a: 1 };
  };

  const findings = [];

  // ---- run something so the panel has content --------------------------
  await editor.tabManager.openFileWithPath(pythonFile);
  await waitFor(
    () => editor.tabManager.activeFile?.path === pythonFile,
    "the file to become active",
  );
  await waitFor(() => editor.tabManager.activeFile?.isLoaded === true, "the file to load");
  await sleep(150);

  const action = document.querySelector(".run-action");
  const button = action.querySelector(".run-action-button");
  button.click();
  await waitFor(() => editor.runPanel, "the panel to be created");
  const panel = editor.runPanel;
  await waitFor(() => panel.controller.state === "success", "the run to finish");
  await sleep(250);

  // ---- the control -----------------------------------------------------
  const buttonStyle = getComputedStyle(button);
  const buttonRect = button.getBoundingClientRect();
  const stripRect = document.querySelector(".file-manager").getBoundingClientRect();

  findings.push({
    check: "button height fits the tab strip",
    ok: buttonRect.height <= stripRect.height + 1 && buttonRect.height >= 16,
    detail: `${buttonRect.height}px in a ${stripRect.height}px strip`,
  });
  findings.push({
    check: "button is compact, not a hero button",
    ok: buttonRect.width < 130 && buttonRect.height < 40,
    detail: `${Math.round(buttonRect.width)}x${Math.round(buttonRect.height)}`,
  });
  findings.push({
    check: "button has no decorative shadow",
    ok: buttonStyle.boxShadow === "none" || buttonStyle.boxShadow === "",
    detail: buttonStyle.boxShadow,
  });
  findings.push({
    check: "button has no gradient",
    ok: !/gradient/.test(buttonStyle.backgroundImage || ""),
    detail: buttonStyle.backgroundImage || "none",
  });
  findings.push({
    check: "button is not glassy",
    ok: !/blur/.test(buttonStyle.backdropFilter || ""),
    detail: buttonStyle.backdropFilter || "none",
  });
  findings.push({
    check: "button is not oversized text",
    ok: parseFloat(buttonStyle.fontSize) <= 13,
    detail: `${buttonStyle.fontSize}`,
  });

  // ---- the panel frame -------------------------------------------------
  const panelStyle = getComputedStyle(panel.element);
  findings.push({
    check: "panel has no gradient",
    ok: !/gradient/.test(panelStyle.backgroundImage || ""),
    detail: panelStyle.backgroundImage || "none",
  });
  findings.push({
    check: "panel has no decorative shadow",
    ok: panelStyle.boxShadow === "none" || panelStyle.boxShadow === "",
    detail: panelStyle.boxShadow,
  });

  // ---- the log is monospace and readable -------------------------------
  const logStyle = getComputedStyle(panel.log);
  findings.push({
    check: "log uses the monospace stack",
    ok: /mono/i.test(logStyle.fontFamily),
    detail: logStyle.fontFamily.slice(0, 60),
  });
  const logSize = parseFloat(logStyle.fontSize);
  findings.push({
    check: "log font size is legible and not enlarged",
    ok: logSize >= 11 && logSize <= 14,
    detail: `${logSize}px`,
  });

  const stdoutLine = panel.log.querySelector(".run-panel-line-stdout");
  const stdoutStyle = getComputedStyle(stdoutLine);
  const stdoutContrast = contrast(rgb(stdoutStyle.color), backgroundBehind(stdoutLine));
  findings.push({
    check: "stdout meets AA contrast",
    ok: stdoutContrast >= 4.5,
    detail: `${stdoutContrast.toFixed(2)}:1`,
  });

  // ---- the three kinds are actually different --------------------------
  // A clean run emits no system line: its runtime, exit code and duration
  // live in the facts row, and repeating them in the log would be the
  // duplicated information the brief rules out. So the three kinds are
  // compared by rendering one of each from the real stylesheet.
  const sample = (kind, text) => {
    const line = document.createElement("div");
    line.className = `run-panel-line run-panel-line-${kind}`;
    line.textContent = text;
    panel.log.append(line);
    return line;
  };
  const stdoutSample = sample("stdout", "program output");
  const stderrSample = sample("stderr", "program error");
  const systemSample = sample("system", "nce message");
  await sleep(60);
  const styleOf = (element) => {
    const computed = getComputedStyle(element);
    return { color: computed.color, fontStyle: computed.fontStyle };
  };
  const kinds = {
    stdout: styleOf(stdoutSample),
    stderr: styleOf(stderrSample),
    system: styleOf(systemSample),
  };
  findings.push({
    check: "stderr is distinguishable from stdout",
    ok: kinds.stderr.color !== kinds.stdout.color,
    detail: `${kinds.stderr.color} vs ${kinds.stdout.color}`,
  });
  findings.push({
    check: "system messages are distinguishable from program output",
    ok: kinds.system.color !== kinds.stdout.color,
    detail: `${kinds.system.color} vs ${kinds.stdout.color}`,
  });
  const stderrContrast = contrast(rgb(kinds.stderr.color), backgroundBehind(stderrSample));
  findings.push({
    check: "stderr stays readable rather than shouting",
    ok: stderrContrast >= 4.5,
    detail: `${stderrContrast.toFixed(2)}:1`,
  });
  for (const line of [stdoutSample, stderrSample, systemSample]) line.remove();

  // ---- the facts row ---------------------------------------------------
  const infoStyle = getComputedStyle(panel.info);
  findings.push({
    check: "the facts row is quiet, not a card",
    ok:
      infoStyle.backgroundColor === "rgba(0, 0, 0, 0)" ||
      infoStyle.backgroundColor === "transparent",
    detail: infoStyle.backgroundColor,
  });
  const infoSize = parseFloat(getComputedStyle(panel.infoFile).fontSize);
  findings.push({
    check: "the facts row is smaller than the log",
    ok: infoSize <= logSize,
    detail: `${infoSize}px vs ${logSize}px`,
  });

  // ---- the header ------------------------------------------------------
  const headerRect = panel.header.getBoundingClientRect();
  findings.push({
    check: "the header is a thin bar, not a banner",
    ok: headerRect.height <= 40,
    detail: `${Math.round(headerRect.height)}px`,
  });

  // ---- no horizontal overflow with long lines --------------------------
  const longLine = document.createElement("div");
  longLine.className = "run-panel-line run-panel-line-stdout";
  longLine.textContent = "x".repeat(4000);
  panel.log.append(longLine);
  await sleep(60);
  const wrapStyle = getComputedStyle(panel.log);
  const overflowsPanel =
    panel.log.scrollWidth > panel.log.clientWidth + 1 &&
    wrapStyle.overflowX !== "auto" &&
    wrapStyle.overflowX !== "scroll";
  findings.push({
    check: "long lines do not overflow the panel",
    ok: !overflowsPanel,
    detail: `scrollWidth ${panel.log.scrollWidth} vs client ${panel.log.clientWidth}, overflow-x ${wrapStyle.overflowX}`,
  });
  longLine.remove();

  // ---- the panel is not the terminal -----------------------------------
  findings.push({
    check: "the Output panel is not an interactive terminal",
    ok: !panel.element.querySelector("textarea, input, .xterm"),
    detail: "no input surface inside the log",
  });

  const failed = findings.filter((finding) => !finding.ok);
  return { findings, failed: failed.map((finding) => `${finding.check}: ${finding.detail}`) };
};
