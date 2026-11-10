module.exports = async function exerciseNotificationUI() {
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
  const waitFor = async (predicate, description, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw Error(`Timed out waiting for ${description}`);
  };
  const rectOf = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  };

  const manager = editor.notificationManager;
  const toastView = editor.notificationToastView;
  const centerView = editor.notificationCenterView;
  check(Boolean(manager && toastView && centerView), "notification manager and views are initialized");
  check(typeof manager.notify === "function", "notification API is available");

  // Keep the visual assertions independent from Chromium's animation scheduler.
  const motionStyle = document.createElement("style");
  motionStyle.textContent =
    ".nce-toast, .nce-toast-host, .nce-notification-center { transition: none !important; }";
  document.head.appendChild(motionStyle);

  manager.clearHistory();
  manager.clear();
  await nextFrame();

  const specs = [
    {
      type: "success",
      title: "Commit created",
      message: "feat: notification visual regression",
      source: "Git",
    },
    {
      type: "error",
      title: "Agent run failed",
      message: "The model request failed.",
      source: "Agent",
      actions: [{ label: "Retry", action() {} }],
    },
    {
      type: "warning",
      title: "Folder unavailable",
      message: "The selected folder could not be opened.",
      source: "Files",
    },
    {
      type: "info",
      title: "Git repository initialized",
      message: "Source Control is ready for this workspace.",
      source: "Git",
    },
  ];
  for (const spec of specs) manager.notify({ ...spec, duration: 60000 });
  await waitFor(
    () => document.querySelectorAll(".nce-toast").length === specs.length,
    "four toasts to render",
  );
  await waitFor(
    () => [...document.querySelectorAll(".nce-toast")]
      .every((toast) => toast.classList.contains("is-visible") &&
        getComputedStyle(toast).opacity === "1"),
    "toasts to finish their reveal animation",
  );

  const host = document.querySelector(".nce-toast-host");
  const hostStyle = getComputedStyle(host);
  const hostRect = rectOf(host);
  const view = { width: innerWidth, height: innerHeight };
  const bottomBar = document.querySelector(".bottomBar");
  const bottomBarRect = bottomBar ? rectOf(bottomBar) : null;
  const toasts = [...document.querySelectorAll(".nce-toast")];
  const toastRects = toasts.map(rectOf);
  check(hostStyle.position === "fixed", "toast host is fixed to the viewport");
  check(Number(hostStyle.zIndex) === 24, "toast host stacking level is stable");
  check(hostStyle.pointerEvents === "none", "toast host lets pointer events pass through");
  check(hostRect.right <= view.width + 0.5, "toast host stays inside the viewport");
  check(hostRect.right > view.width - 40, "toast host stays right anchored");
  check(hostRect.width <= 361, "toast host respects its compact width");
  check(hostRect.left >= 0 && hostRect.top >= 0, "toast host stays on screen");
  if (bottomBarRect) {
    check(hostRect.bottom <= bottomBarRect.top + 1, "toasts stay above the status bar");
  }
  for (const rect of toastRects) {
    check(rect.width > 200 && rect.height > 30, "toast keeps a readable size");
    check(
      rect.top >= 0 && rect.bottom <= view.height && rect.left >= 0 && rect.right <= view.width,
      "toast stays inside the window",
    );
  }
  for (let index = 1; index < toastRects.length; index += 1) {
    const gap = toastRects[index].top - toastRects[index - 1].bottom;
    check(Math.abs(gap - 8) <= 1.5, `toast stack gap is 8px (got ${gap})`);
  }
  const toastStyles = toasts.map((toast) => getComputedStyle(toast));
  check(
    toastStyles.every((style) => style.pointerEvents === "auto" &&
      style.opacity === "1" && style.visibility === "visible"),
    "toasts are visible and interactive",
  );
  check(
    toastStyles.every((style) => Number.parseFloat(style.borderLeftWidth) >= 2),
    "toasts keep their type accent border",
  );
  const closeButton = toasts[0].querySelector(".nce-toast-close");
  check(Boolean(closeButton), "toast close button exists");
  check(
    getComputedStyle(closeButton).cursor === "pointer",
    "toast close button shows a pointer cursor",
  );
  const toastAction = document.querySelector(".nce-toast-action");
  check(Boolean(toastAction), "toast action exists");
  check(
    getComputedStyle(toastAction).cursor === "pointer",
    "toast actions show a pointer cursor",
  );

  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  const colorOf = (token) => {
    probe.style.color = "";
    probe.style.color = getComputedStyle(document.documentElement)
      .getPropertyValue(token)
      .trim();
    return getComputedStyle(probe).color;
  };
  const backgroundColorOf = (token) => {
    probe.style.backgroundColor = "";
    probe.style.backgroundColor = getComputedStyle(document.documentElement)
      .getPropertyValue(token)
      .trim();
    return getComputedStyle(probe).backgroundColor;
  };

  try {
    const expectedIcons = [
      "fi-rr-check",
      "fi-rr-cross-circle",
      "fi-rr-triangle-warning",
      "fi-rr-info",
    ];
    const expectedColors = [
      colorOf("--state-success"),
      colorOf("--state-error"),
      colorOf("--state-warning"),
      colorOf("--state-info"),
    ];
    specs.forEach((spec, index) => {
      check(toasts[index].dataset.type === spec.type, `toast ${index} type`);
      const icon = toasts[index].querySelector(".nce-toast-icon i");
      check(icon && icon.classList.contains(expectedIcons[index]), `toast ${index} icon`);
      check(
        getComputedStyle(toasts[index]).borderLeftColor === expectedColors[index],
        `toast ${index} uses its state token`,
      );
    });

    const bell = document.querySelector(".nce-notification-bell");
    const badge = bell?.querySelector(".nce-notification-badge");
    check(Boolean(bell && badge), "notification bell and badge exist");
    check(Boolean(bell.closest(".bottomBar")), "bell lives in the bottom bar");
    check(
      getComputedStyle(badge).backgroundColor === colorOf("--accent-fill"),
      "notification count badge uses the accent token",
    );
    check(
      getComputedStyle(badge).borderRadius === "50%",
      "notification count badge is round",
    );
    const rightGroup = bell.closest(".bottomBar .right");
    const bellGroup = bell.closest(".nce-bottom-bar-actions");
    check(Boolean(rightGroup && bellGroup), "bell belongs to the right status group");
    check(
      rightGroup.lastElementChild === bellGroup,
      "bell sits at the far right of the status group",
    );
    check(
      getComputedStyle(bell).borderRadius === "0px",
      "bell keeps square corners",
    );
    const bellRect = rectOf(bell);
    const badgeRect = rectOf(badge);
    const bottomBarRect = rectOf(document.querySelector(".bottomBar"));
    check(
      bellRect.width >= 22 && bellRect.height >= 18 && bellRect.right <= view.width,
      "bell keeps its compact bottom-bar hit area",
    );
    check(
      bellRect.top >= bottomBarRect.top - 1 && bellRect.bottom <= bottomBarRect.bottom + 1,
      "bell stays inside the bottom bar",
    );
    check(
      getComputedStyle(bell).cursor === "pointer",
      "bell shows a pointer cursor",
    );
    check(badge.hidden === false && badge.textContent === String(specs.length), "badge shows the unread count");
    check(
      badgeRect.width >= 11 && badgeRect.height >= 11 &&
        badgeRect.top <= bellRect.top + 2 && badgeRect.right <= bellRect.right + 1,
      "badge stays inside the bell bounds",
    );

    bell.click();
    await waitFor(
      () => centerView.isOpen &&
        document.querySelector(".nce-notification-center")?.classList.contains("is-open") &&
        getComputedStyle(document.querySelector(".nce-notification-center")).opacity === "1",
      "notification center to open",
    );
    await nextFrame();
    const center = document.querySelector(".nce-notification-center");
    const centerRect = rectOf(center);
    const centerStyle = getComputedStyle(center);
    const titlebarRect = rectOf(document.querySelector(".nce-titlebar"));
    check(
      getComputedStyle(document.querySelector(".nce-toast-host")).visibility === "hidden",
      "toasts yield to the open center",
    );
    check(
      center.getAttribute("role") === "dialog" &&
        center.getAttribute("aria-label") === "Notifications",
      "center exposes its dialog semantics",
    );
    check(
      centerStyle.position === "fixed" && Number(centerStyle.zIndex) === 25,
      "center stacking level is stable",
    );
    check(
      centerStyle.visibility === "visible" && centerStyle.opacity === "1",
      "center is fully visible",
    );
    check(centerStyle.boxShadow !== "none", "center keeps its native shadow");
    check(centerRect.top >= titlebarRect.bottom, "center stays below the title bar");
    check(
      centerRect.right <= view.width - 4 && centerRect.left >= 0 && centerRect.width <= 361,
      "center stays right anchored and inside the window",
    );
    check(
      centerRect.bottom <= bottomBarRect.top - 4 && centerRect.bottom >= bottomBarRect.top - 40,
      "center opens from the bottom bar",
    );
    check(centerRect.bottom <= view.height, "center stays above the window bottom");

    const items = [...center.querySelectorAll(".nce-notification-item")];
    check(items.length === specs.length, "center renders the full history");
    const titles = items.map((item) =>
      item.querySelector(".nce-notification-item-title").textContent);
    check(
      titles[0] === specs[specs.length - 1].title &&
        titles[titles.length - 1] === specs[0].title,
      "center sorts newest first",
    );
    check(
      items[0].dataset.read === "false" &&
        !items[0].querySelector(".nce-notification-unread-dot").hidden,
      "unread items keep their visual marker",
    );
    const count = center.querySelector(".nce-notification-center-count");
    check(count.textContent === `${specs.length} unread`, "center shows the unread count");
    check(
      !centerView.markAllButton.disabled && !centerView.clearButton.disabled,
      "center header actions are enabled",
    );
    check(
      getComputedStyle(center.querySelector(".nce-notification-center-list")).overflowY === "auto",
      "center history scrolls independently",
    );
    check(
      getComputedStyle(items[0]).cursor === "pointer",
      "notification rows show a pointer cursor",
    );
    check(
      getComputedStyle(centerView.markAllButton).cursor === "pointer" &&
        getComputedStyle(centerView.clearButton).cursor === "pointer",
      "center header actions show a pointer cursor",
    );
    check(
      getComputedStyle(items[0].querySelector(".nce-notification-item-control")).cursor === "pointer",
      "notification row controls show a pointer cursor",
    );
    const itemAction = center.querySelector(".nce-notification-action");
    check(Boolean(itemAction), "notification contextual action exists");
    check(
      getComputedStyle(itemAction).cursor === "pointer",
      "notification contextual actions show a pointer cursor",
    );

    centerView.markAllButton.click();
    await nextFrame();
    check(manager.getUnreadCount() === 0, "mark all clears unread state");
    check(badge.hidden === true, "badge hides when everything is read");
    check(count.hidden === true, "unread counter hides when everything is read");
    check(
      getComputedStyle(centerView.markAllButton).cursor === "default",
      "disabled center actions fall back to the default cursor",
    );

    manager.clearHistory();
    await waitFor(
      () => document.querySelectorAll(".nce-toast").length === 0,
      "toasts to clear with the history",
      2500,
    );
    await nextFrame();
    check(centerView.list.children.length === 0, "center list empties with the history");
    check(
      centerView.empty.hidden === false &&
        centerView.empty.textContent === "No notifications",
      "center shows its empty state",
    );
    check(centerView.clearButton.disabled === true, "clear action disables on empty history");
    check(
      getComputedStyle(centerView.clearButton).cursor === "default",
      "disabled clear action uses the default cursor",
    );

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => !centerView.isOpen, "center to close on Escape");
    check(center.getAttribute("aria-hidden") === "true", "closed center is hidden from assistive tech");

    const previousTheme = editor.themeManager.getResolvedTheme();
    editor.themeManager.applyTheme("light");
    await nextFrame();
    check(document.documentElement.dataset.theme === "light", "light theme applies");
    for (const spec of specs) manager.notify({ ...spec, duration: 60000 });
    await waitFor(
      () => document.querySelectorAll(".nce-toast").length === specs.length,
      "light-theme toasts to render",
    );
    await waitFor(
      () => [...document.querySelectorAll(".nce-toast")]
        .every((toast) => toast.classList.contains("is-visible") &&
          getComputedStyle(toast).opacity === "1"),
      "light-theme toasts to reveal",
    );
    check(
      getComputedStyle(document.querySelector(".nce-toast")).backgroundColor ===
        backgroundColorOf("--bg-secondary"),
      "toast surface follows the active theme",
    );
    editor.themeManager.applyTheme(previousTheme);
    await nextFrame();

    centerView.open();
    await waitFor(() => centerView.isOpen, "center to reopen for the visual fixture");
    await nextFrame();
    return { toasts: specs.length, surfaces: 4, centerOpen: centerView.isOpen };
  } finally {
    probe.remove();
  }
};
