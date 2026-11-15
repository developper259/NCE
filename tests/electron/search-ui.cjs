module.exports = async function exerciseSearchUI(term) {
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
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw Error(`Timed out waiting for ${description}`);
  };
  const rotationOf = (element) => {
    const transform = getComputedStyle(element).transform;
    if (!transform || transform === "none") return 0;
    const match = transform.match(/matrix\(([^)]+)\)/);
    if (!match) return 0;
    const [, b] = match[1].split(",").map((value) => Number.parseFloat(value));
    return Math.asin(Math.max(-1, Math.min(1, b))) * (180 / Math.PI);
  };

  const search = editor.searchSidebar;
  check(Boolean(search), "Search sidebar exists");

  // Keep the caret rotation assertion independent from the transition timing.
  const motionStyle = document.createElement("style");
  motionStyle.textContent =
    ".search-sidebar-file-caret { transition: none !important; }";
  document.head.appendChild(motionStyle);

  editor.sidebarManager.openMenu("search");
  await waitFor(() => search.isOpen && Boolean(search.container), "Search sidebar to open");
  await nextFrame();

  const container = search.container;
  const header = container.querySelector(".search-sidebar-header");
  check(Boolean(header), "the SEARCH header is present");
  const title = header.querySelector(".sidebar-main-title");
  check(title && title.textContent === "SEARCH", "the header title reads SEARCH");
  const filterToggle = search.filterToggleButton;
  check(Boolean(filterToggle), "the header filter toggle exists");
  check(
    filterToggle.querySelector("i.fi-rr-filter"),
    "the filter toggle carries the filter icon",
  );

  // The title bar must be indistinguishable from Source Control's: same box
  // and separator, same title typography, same borderless icon buttons. Mount
  // the real Git header briefly to compare computed styles, then unmount it.
  const gitContainer = editor.gitSidebar.render();
  document.body.appendChild(gitContainer);
  const gitHeader = gitContainer.querySelector(".git-sidebar-header");
  const boxSignature = (node) => {
    const style = getComputedStyle(node);
    return [
      style.display, style.alignItems, style.gap, style.minHeight,
      style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft,
      style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor,
    ].join("|");
  };
  check(
    boxSignature(gitHeader) === boxSignature(header),
    `the search title bar box matches the Source Control title bar (${boxSignature(gitHeader)} vs ${boxSignature(header)})`,
  );
  const insetSignature = (node, root) => {
    const box = node.getBoundingClientRect();
    const frame = root.getBoundingClientRect();
    return [box.left - frame.left, frame.right - box.right, box.height].join("|");
  };
  check(
    insetSignature(gitHeader, gitContainer) === insetSignature(header, container),
    `the search title bar sits at the same insets as Source Control (${insetSignature(gitHeader, gitContainer)} vs ${insetSignature(header, container)})`,
  );
  const typeSignature = (node) => {
    const style = getComputedStyle(node);
    return [
      style.fontSize, style.fontWeight, style.fontFamily, style.letterSpacing,
      style.textTransform, style.color, node.getBoundingClientRect().height,
    ].join("|");
  };
  check(
    typeSignature(gitHeader.querySelector(".sidebar-main-title")) === typeSignature(title),
    `the search title typography matches the Source Control title (${typeSignature(gitHeader.querySelector(".sidebar-main-title"))} vs ${typeSignature(title)})`,
  );
  const buttonSignature = (node) => {
    const style = getComputedStyle(node);
    return [
      style.width, style.height, style.borderTopWidth, style.borderRadius,
      style.backgroundColor, style.color, style.fontSize,
    ].join("|");
  };
  check(
    buttonSignature(gitContainer.querySelector('.git-sidebar-icon-button[data-action="menu"]')) ===
      buttonSignature(filterToggle),
    "the filter toggle matches the Source Control header icon buttons",
  );
  gitContainer.remove();
  const titleBarMatchesSourceControl = true;

  // Filters start collapsed; the toggle is not highlighted while closed.
  check(search.filtersExpanded === false, "filters start collapsed");
  check(search.includeInput.hidden === true, "include input starts hidden");
  check(search.excludeInput.hidden === true, "exclude input starts hidden");
  check(
    filterToggle.classList.contains("is-active") === false,
    "the filter toggle is not highlighted while filters are closed",
  );
  check(
    filterToggle.getAttribute("aria-expanded") === "false",
    "the filter toggle reports aria-expanded false while closed",
  );
  const filtersHiddenByDefault = true;

  // Opening the filters reveals both inputs and highlights the toggle.
  filterToggle.click();
  await nextFrame();
  check(search.filtersExpanded === true, "clicking the toggle expands filters");
  check(search.includeInput.hidden === false, "include input is revealed");
  check(search.excludeInput.hidden === false, "exclude input is revealed");
  check(
    filterToggle.classList.contains("is-active") === true,
    "the filter toggle is highlighted while filters are open",
  );
  check(
    filterToggle.getAttribute("aria-expanded") === "true",
    "the filter toggle reports aria-expanded true while open",
  );
  const filtersOpenActive = true;

  // Closing the filters hides the inputs and clears the highlight (no stuck ring).
  filterToggle.click();
  await nextFrame();
  check(search.filtersExpanded === false, "clicking again collapses filters");
  check(search.includeInput.hidden === true, "include input hides again");
  check(search.excludeInput.hidden === true, "exclude input hides again");
  check(
    filterToggle.classList.contains("is-active") === false,
    "the filter toggle highlight clears when filters close",
  );
  const filtersClosedInactive = true;

  // Run a real workspace search against the fixture files.
  search.query = term;
  search.input.value = term;
  await search.runSearch();
  await waitFor(
    () => !search.isSearching && search.results.length > 0,
    "the workspace search to return results",
  );
  await nextFrame();
  await waitFor(
    () => search.resultsLayer.querySelectorAll(".search-sidebar-file-header").length > 0,
    "result file headers to render",
  );

  const headers = () => [...search.resultsLayer.querySelectorAll(".search-sidebar-file-header")];
  const matches = () => [...search.resultsLayer.querySelectorAll(".search-sidebar-match")];
  check(search.totalMatches === 3, `the fixture yields 3 matches (got ${search.totalMatches})`);
  check(headers().length === 2, "matches group under 2 file headers");
  check(matches().length === 3, "all 3 match rows render");
  check(
    search.resultsLayer.querySelector(".search-sidebar-file-count") === null,
    "no per-file count badge is rendered",
  );
  const firstHeader = headers()[0];
  check(firstHeader.children.length === 3, "a file header holds caret, icon and name only");
  check(firstHeader.getAttribute("role") === "button", "the file header is a button");
  check(firstHeader.tabIndex === 0, "the file header is keyboard focusable");
  check(
    firstHeader.getAttribute("aria-expanded") === "true",
    "an expanded file header reports aria-expanded true",
  );
  const caret = firstHeader.querySelector(".search-sidebar-file-caret");
  check(Boolean(caret), "the file header carries a caret");
  const expandedRotation = rotationOf(caret);
  check(Math.abs(expandedRotation) < 1, "the expanded caret points down");
  const noCountBadge = true;
  const headerChildren = firstHeader.children.length;

  // Collapsing a file hides its matches and rotates the caret.
  firstHeader.click();
  await nextFrame();
  await waitFor(() => matches().length === 1, "collapsing to hide the file's matches");
  const collapsedHeader = headers().find(
    (node) => node.dataset.file === firstHeader.dataset.file,
  );
  check(Boolean(collapsedHeader), "the collapsed header remains rendered");
  check(
    collapsedHeader.classList.contains("is-collapsed") === true,
    "the collapsed header carries the is-collapsed class",
  );
  check(
    collapsedHeader.getAttribute("aria-expanded") === "false",
    "the collapsed header reports aria-expanded false",
  );
  const collapsedRotation = rotationOf(collapsedHeader.querySelector(".search-sidebar-file-caret"));
  check(Math.abs(collapsedRotation + 90) < 1, "the collapsed caret rotates to point right");
  check(matches().length === 1, "only the other file's match remains visible");
  const collapseHidesMatches = true;
  const caretRotates = true;

  // Expanding restores the matches.
  collapsedHeader.click();
  await nextFrame();
  await waitFor(() => matches().length === 3, "expanding to restore the file's matches");
  const restoredHeader = headers().find(
    (node) => node.dataset.file === firstHeader.dataset.file,
  );
  check(
    restoredHeader.classList.contains("is-collapsed") === false,
    "the restored header drops the is-collapsed class",
  );
  check(
    restoredHeader.getAttribute("aria-expanded") === "true",
    "the restored header reports aria-expanded true",
  );
  const expandRestoresMatches = true;

  // Keyboard activation toggles the group just like a click. The virtualized
  // scroller rebuilds rows on a frame, so settle it and re-query the header
  // immediately before dispatching to avoid acting on a replaced node.
  const settleResults = () => waitFor(
    () => search.resultsScroller.frame === null &&
      search.resultsScroller.renderedVersion === search.resultsScroller.itemsVersion,
    "the results scroller to finish rendering",
  );
  const headerFor = (file) => headers().find((node) => node.dataset.file === file);
  const targetFile = firstHeader.dataset.file;
  // The virtualized scroller rebuilds rows on a frame and a synthetic key can
  // land on a node that is being replaced; re-dispatch on a fresh header until
  // the collapse/expand actually converges (same pattern as Source Control).
  const pressKey = async (key, expected, description) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await settleResults();
      headerFor(targetFile).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      const converged = await waitFor(
        () => matches().length === expected, description, 600,
      ).catch(() => false);
      if (converged) return;
    }
    throw Error(description);
  };
  await pressKey("Enter", 1, "Enter to collapse the focused header");
  await settleResults();
  const keyboardCollapsed = headerFor(targetFile);
  check(
    keyboardCollapsed.getAttribute("aria-expanded") === "false",
    "Enter collapses the header",
  );
  await pressKey(" ", 3, "Space to expand the focused header");
  const keyboardCollapse = true;

  // The replace sub-row reveals an input and a same-size Replace All button.
  check(search.replaceRow.hidden === true, "the replace row starts hidden");
  search.replaceExpandButton.click();
  await nextFrame();
  check(search.replaceRow.hidden === false, "the replace toggle reveals the replace row");
  check(search.replaceInput.hidden === false, "the replace input is revealed");
  check(search.replaceAllButton.hidden === false, "the Replace All button is revealed");
  check(
    Boolean(search.replaceAllButton.querySelector("i.fi-rr-exchange")),
    "the Replace All button uses the replace/swap icon, not a refresh glyph",
  );
  const replaceIcon = true;
  check(
    search.replaceExpandButton.getAttribute("aria-expanded") === "true",
    "the replace toggle reports aria-expanded true",
  );
  const inputHeight = search.replaceInput.getBoundingClientRect().height;
  const buttonHeight = search.replaceAllButton.getBoundingClientRect().height;
  check(
    Math.abs(inputHeight - buttonHeight) <= 0.5 && inputHeight > 0,
    `the Replace All button matches the input height (${inputHeight} vs ${buttonHeight})`,
  );
  const replaceRowShown = true;
  const replaceSameHeight = true;
  search.replaceExpandButton.click();
  await nextFrame();
  check(search.replaceRow.hidden === true, "the replace toggle hides the row again");

  // Leave the sidebar in a representative state for optional screenshot capture:
  // filters open, replace row open, all file groups expanded.
  if (!search.filtersExpanded) {
    search.toggleFilters();
    await nextFrame();
  }
  if (!search.replaceExpanded) {
    search.replaceExpandButton.click();
    await nextFrame();
  }
  search.input.blur();

  motionStyle.remove();
  return {
    headerTitle: title.textContent,
    titleBarMatchesSourceControl,
    filtersHiddenByDefault,
    filtersOpenActive,
    filtersClosedInactive,
    totalMatches: search.totalMatches,
    fileHeaders: headers().length,
    matchRows: matches().length,
    noCountBadge,
    headerChildren,
    collapseHidesMatches,
    caretRotates,
    expandRestoresMatches,
    keyboardCollapse,
    replaceRowShown,
    replaceSameHeight,
    replaceIcon,
  };
};