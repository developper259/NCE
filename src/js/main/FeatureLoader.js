const NCE_RENDERER_BASE_URL = (() => {
  const scriptUrl = document.currentScript?.src;
  return scriptUrl
    ? new URL(".", scriptUrl).href
    : new URL("./", window.location.href).href;
})();
const NCE_RENDERER_BUNDLE_LOADS = new Map();

function rendererBundleIsLoaded(bundle) {
  if (bundle === "agent") {
    return typeof Agent !== "undefined" && typeof AgentSidebar !== "undefined";
  }
  if (bundle === "markdown") {
    return typeof MarkdownRenderer !== "undefined" && typeof MarkdownView !== "undefined";
  }
  if (bundle === "terminal") {
    return typeof window.NCE_TERMINAL_RUNTIME?.createPanel === "function";
  }
  return false;
}

function ensureRendererBundle(bundle) {
  const metrics = window.NCEPerformanceMetrics;
  metrics?.increment(`renderer.bundle.${bundle}.requests`);
  if (rendererBundleIsLoaded(bundle)) {
    metrics?.increment(`renderer.bundle.${bundle}.alreadyLoaded`);
    return Promise.resolve();
  }
  const pending = NCE_RENDERER_BUNDLE_LOADS.get(bundle);
  if (pending) {
    metrics?.increment(`renderer.bundle.${bundle}.coalesced`);
    return pending;
  }

  const bundleUrls = {
    agent: "agent.js",
    markdown: "markdown.js",
    terminal: "../js/terminal/entry.js",
  };
  const filename = bundleUrls[bundle];
  if (!filename) return Promise.reject(new Error(`Unknown renderer bundle: ${bundle}`));

  const measure = metrics?.begin(`renderer.bundle.${bundle}.load`);
  metrics?.increment(`renderer.bundle.${bundle}.loads`);
  const load = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.dataset.nceRendererBundle = bundle;
    if (bundle === "terminal") script.type = "module";
    script.src = new URL(filename, NCE_RENDERER_BASE_URL).href;

    const fail = (message) => {
      script.remove();
      NCE_RENDERER_BUNDLE_LOADS.delete(bundle);
      metrics?.end(measure);
      metrics?.increment(`renderer.bundle.${bundle}.failures`);
      reject(new Error(message));
    };

    script.onload = () => {
      if (!rendererBundleIsLoaded(bundle)) {
        fail(`Renderer ${bundle} bundle loaded without its entry classes`);
        return;
      }
      metrics?.end(measure);
      metrics?.mark(`renderer.bundle.${bundle}.ready`);
      resolve();
    };
    script.onerror = () => fail(`Failed to load renderer ${bundle} bundle`);
    document.head.appendChild(script);
  });
  NCE_RENDERER_BUNDLE_LOADS.set(bundle, load);
  return load;
}

function ensureMarkdownBundle() {
  return ensureRendererBundle("markdown");
}

function ensureTerminalBundle() {
  return ensureRendererBundle("terminal");
}

function ensureAgentBundle() {
  return ensureMarkdownBundle().then(() => ensureRendererBundle("agent"));
}
