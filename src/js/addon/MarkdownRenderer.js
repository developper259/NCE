class MarkdownRenderer {
  static MODES = Object.freeze({
    STRICT: "strict",
    WORKSPACE_PREVIEW: "workspace-preview",
  });

  static PREVIEW_TAGS = new Set([
    "p", "div", "span", "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "s", "del", "u", "pre", "code", "kbd",
    "ul", "ol", "li", "blockquote", "br", "hr", "a", "img", "table",
    "thead", "tbody", "tr", "th", "td", "details", "summary", "sub", "sup",
  ]);

  static DROP_CONTENT_TAGS = new Set([
    "script", "style", "iframe", "object", "embed", "video", "audio", "source",
    "canvas", "form", "input", "button", "textarea", "select", "link", "meta",
    "base", "svg", "math",
  ]);

  static MAX_IMAGE_DIMENSION = 8192;

  constructor(options = {}) {
    this.throttleMs = Math.max(16, Number(options.throttleMs) || 50);
    this.highlightDelayMs = Math.max(
      this.throttleMs,
      Number(options.highlightDelayMs) || 180,
    );
    this.getHighlightController = options.getHighlightController || null;
    this.readImageFile = options.readImageFile || null;
    this.supportedLanguagesPromise = null;
    this.detectedLanguages = new Map();
    this.highlightCache = new Map();
    this.maxHighlightCacheEntries = 32;
    this.states = new WeakMap();
    this.strictMarkdown = this.createMarkdownEngine({ html: false, images: false });
    this.previewMarkdown = this.createMarkdownEngine({ html: true, images: true });
    // Keep this alias for integrations that inspect the historical strict engine.
    this.markdown = this.strictMarkdown;
  }

  createMarkdownEngine({ html, images }) {
    const markdownItFactory = window.markdownit;

    if (typeof markdownItFactory !== "function") {
      console.error(
        "markdown-it is not available; Markdown will stay plain text.",
      );
      return null;
    }

    const markdown = markdownItFactory({
      html,
      breaks: true,
      linkify: false,
      typographer: false,
    });

    if (!images) markdown.disable("image");
    markdown.validateLink = (url) =>
      this.isSafeLink(url) || (images && this.isSafeLocalImageReference(url));
    const defaultLinkOpen =
      markdown.renderer.rules.link_open ||
      ((tokens, index, renderOptions, environment, renderer) =>
        renderer.renderToken(tokens, index, renderOptions));

    markdown.renderer.rules.link_open = (
      tokens,
      index,
      renderOptions,
      environment,
      renderer,
    ) => {
      tokens[index].attrSet("target", "_blank");
      tokens[index].attrSet("rel", "noopener noreferrer");
      return defaultLinkOpen(
        tokens,
        index,
        renderOptions,
        environment,
        renderer,
      );
    };

    return markdown;
  }

  isSafeLink(value) {
    if (typeof value !== "string" || !value.trim()) return false;

    try {
      const url = new URL(value.trim());
      return ["http:", "https:", "mailto:"].includes(url.protocol);
    } catch {
      return false;
    }
  }

  isSafeLocalImageReference(value) {
    if (typeof value !== "string") return false;
    const reference = value.trim();
    if (!reference || /[\u0000-\u001f\u007f]/.test(reference)) return false;
    if (/^(?:[a-z][a-z\d+.-]*:|\/|\\|[a-z]:[\\/])/i.test(reference)) return false;
    if (reference.startsWith("//") || /[?#]/.test(reference)) return false;
    return true;
  }

  normalizeMode(value) {
    return value === MarkdownRenderer.MODES.WORKSPACE_PREVIEW
      ? MarkdownRenderer.MODES.WORKSPACE_PREVIEW
      : MarkdownRenderer.MODES.STRICT;
  }

  normalize(markdown) {
    return typeof markdown === "string" ? markdown : "";
  }

  getState(container) {
    let state = this.states.get(container);
    if (!state) {
      state = {
        markdown: "",
        renderedMarkdown: null,
        mode: MarkdownRenderer.MODES.STRICT,
        sourcePath: null,
        workspaceRoot: null,
        renderedMode: null,
        renderedSourcePath: null,
        renderedWorkspaceRoot: null,
        objectUrls: new Set(),
        forceRender: false,
        lastRenderAt: 0,
        timer: null,
        frame: null,
        highlightTimer: null,
        revision: 0,
        highlightImmediately: true,
        onRendered: null,
      };
      this.states.set(container, state);
    }
    return state;
  }

  render(markdown, container, options = {}) {
    if (!(container instanceof Element)) return;

    const state = this.getState(container);
    state.markdown = this.normalize(markdown);
    state.mode = this.normalizeMode(options.mode);
    state.sourcePath = typeof options.sourcePath === "string" ? options.sourcePath : null;
    state.workspaceRoot = typeof options.workspaceRoot === "string" ? options.workspaceRoot : null;
    state.onRendered = options.onRendered || null;
    state.highlightImmediately = options.highlightImmediately !== false;
    state.forceRender = true;
    state.revision += 1;
    this.cancelScheduled(state);
    this.commit(container, state);
  }

  update(markdown, container, options = {}) {
    if (!(container instanceof Element)) return;

    const state = this.getState(container);
    const nextMarkdown = this.normalize(markdown);
    const nextMode = options.mode === undefined ? state.mode : this.normalizeMode(options.mode);
    const nextSourcePath = options.sourcePath === undefined
      ? state.sourcePath : typeof options.sourcePath === "string" ? options.sourcePath : null;
    const nextWorkspaceRoot = options.workspaceRoot === undefined
      ? state.workspaceRoot : typeof options.workspaceRoot === "string" ? options.workspaceRoot : null;
    const renderContextChanged = nextMode !== state.mode ||
      nextSourcePath !== state.sourcePath || nextWorkspaceRoot !== state.workspaceRoot;
    if (nextMarkdown !== state.markdown || renderContextChanged) {
      state.revision += 1;
      if (state.highlightTimer !== null) {
        clearTimeout(state.highlightTimer);
        state.highlightTimer = null;
      }
    }
    state.markdown = nextMarkdown;
    state.mode = nextMode;
    state.sourcePath = nextSourcePath;
    state.workspaceRoot = nextWorkspaceRoot;
    state.onRendered = options.onRendered || state.onRendered;
    state.highlightImmediately = false;
    state.forceRender = false;

    if (
      this.isCurrentRender(state) ||
      state.timer !== null ||
      state.frame !== null
    ) {
      return;
    }

    const elapsed = performance.now() - state.lastRenderAt;
    const delay = Math.max(0, this.throttleMs - elapsed);

    state.timer = setTimeout(() => {
      state.timer = null;
      const renderFrame = () => {
        state.frame = null;
        this.commit(container, state);
      };

      if (typeof requestAnimationFrame === "function") {
        state.frame = requestAnimationFrame(renderFrame);
      } else {
        renderFrame();
      }
    }, delay);
  }

  isCurrentRender(state) {
    return state.markdown === state.renderedMarkdown &&
      state.mode === state.renderedMode &&
      state.sourcePath === state.renderedSourcePath &&
      state.workspaceRoot === state.renderedWorkspaceRoot;
  }

  commit(container, state) {
    if (this.isCurrentRender(state) && !state.forceRender) {
      if (state.highlightImmediately) {
        state.revision += 1;
        this.scheduleCodeHighlight(container, state, true);
      }
      const onRendered = state.onRendered;
      state.onRendered = null;
      onRendered?.();
      return;
    }

    this.releaseObjectUrls(state);
    if (state.mode === MarkdownRenderer.MODES.WORKSPACE_PREVIEW && this.previewMarkdown) {
      const template = document.createElement("template");
      template.innerHTML = this.previewMarkdown.render(state.markdown);
      const safeFragment = this.sanitizePreviewFragment(template.content);
      container.replaceChildren(safeFragment);
    } else if (!this.strictMarkdown) {
      container.textContent = state.markdown;
    } else {
      const template = document.createElement("template");
      template.innerHTML = this.strictMarkdown.render(state.markdown);
      container.replaceChildren(template.content.cloneNode(true));
    }

    state.renderedMarkdown = state.markdown;
    state.renderedMode = state.mode;
    state.renderedSourcePath = state.sourcePath;
    state.renderedWorkspaceRoot = state.workspaceRoot;
    state.forceRender = false;
    state.lastRenderAt = performance.now();
    state.revision += 1;
    const revision = state.revision;
    this.scheduleCodeHighlight(container, state, state.highlightImmediately);
    if (state.mode === MarkdownRenderer.MODES.WORKSPACE_PREVIEW)
      void this.loadPreviewImages(container, state, revision);

    const onRendered = state.onRendered;
    state.onRendered = null;
    onRendered?.();
  }

  sanitizePreviewFragment(sourceFragment) {
    const fragment = document.createDocumentFragment();
    this.sanitizePreviewChildren(sourceFragment, fragment);
    return fragment;
  }

  sanitizePreviewChildren(sourceParent, safeParent) {
    for (const sourceNode of Array.from(sourceParent.childNodes || [])) {
      if (sourceNode.nodeType === Node.TEXT_NODE) {
        safeParent.appendChild(document.createTextNode(sourceNode.nodeValue || ""));
        continue;
      }
      if (sourceNode.nodeType !== Node.ELEMENT_NODE) continue;

      const tag = sourceNode.localName?.toLowerCase();
      if (sourceNode.namespaceURI !== "http://www.w3.org/1999/xhtml") continue;
      if (MarkdownRenderer.DROP_CONTENT_TAGS.has(tag)) continue;
      if (!MarkdownRenderer.PREVIEW_TAGS.has(tag)) {
        this.sanitizePreviewChildren(sourceNode, safeParent);
        continue;
      }

      const safeElement = document.createElement(tag);
      this.sanitizePreviewAttributes(sourceNode, safeElement, tag);
      if (tag === "table") {
        const wrapper = document.createElement("div");
        wrapper.className = "markdown-table-wrapper";
        wrapper.appendChild(safeElement);
        safeParent.appendChild(wrapper);
      } else {
        safeParent.appendChild(safeElement);
      }
      if (tag !== "img" && tag !== "br" && tag !== "hr")
        this.sanitizePreviewChildren(sourceNode, safeElement);
    }
  }

  sanitizePreviewAttributes(sourceElement, safeElement, tag) {
    for (const attribute of Array.from(sourceElement.attributes || [])) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith("on") || name === "style" || name === "id" || name.startsWith("data-")) continue;
      if (name === "title" && value.length <= 512) {
        safeElement.setAttribute("title", value);
      } else if (name === "align" && /^(left|center|right|justify)$/i.test(value.trim()) &&
          /^(p|div|h[1-6]|td|th|table)$/.test(tag)) {
        safeElement.setAttribute("align", value.trim().toLowerCase());
      } else if (tag === "img" && name === "src" && this.isSafeLocalImageReference(value)) {
        safeElement.setAttribute("data-nce-image-source", value.trim());
      } else if (tag === "img" && name === "alt" && value.length <= 2048) {
        safeElement.setAttribute("alt", value);
      } else if (tag === "img" && (name === "width" || name === "height")) {
        const dimension = Number(value);
        if (Number.isInteger(dimension) && dimension >= 1 &&
            dimension <= MarkdownRenderer.MAX_IMAGE_DIMENSION)
          safeElement.setAttribute(name, String(dimension));
      } else if (tag === "a" && name === "href" && this.isSafeLink(value)) {
        safeElement.setAttribute("href", value.trim());
        safeElement.setAttribute("target", "_blank");
        safeElement.setAttribute("rel", "noopener noreferrer");
      } else if ((tag === "th" || tag === "td") && (name === "colspan" || name === "rowspan")) {
        const span = Number(value);
        if (Number.isInteger(span) && span >= 1 && span <= 1000)
          safeElement.setAttribute(name, String(span));
      } else if (tag === "details" && name === "open") {
        safeElement.setAttribute("open", "");
      } else if (tag === "code" && name === "class" &&
          /^language-[a-z0-9_+-]{1,40}$/i.test(value.trim())) {
        // markdown-it uses this one class form for fenced-code language hints.
        safeElement.className = value.trim();
      }
    }
  }

  async loadPreviewImages(container, state, revision) {
    const images = Array.from(container.querySelectorAll("img[data-nce-image-source]"));
    await Promise.all(images.map(async (image) => {
      const reference = image.getAttribute("data-nce-image-source");
      image.classList.add("markdown-image-loading");
      try {
        if (!this.readImageFile || !state.sourcePath || !reference) throw new Error("Image unavailable");
        const result = await this.readImageFile(reference, {
          sourcePath: state.sourcePath,
          workspaceRoot: state.workspaceRoot,
        });
        if (!this.isCurrentImageRequest(container, image, state, revision)) return;
        if (!result?.success || !result.data || !/^image\/(?:png|jpeg|webp|gif|bmp|x-icon|svg\+xml)$/.test(result.mimeType || ""))
          throw new Error("Image unavailable");

        const objectUrl = URL.createObjectURL(new Blob([result.data], { type: result.mimeType }));
        if (!this.isCurrentImageRequest(container, image, state, revision)) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        state.objectUrls.add(objectUrl);
        image.removeAttribute("data-nce-image-source");
        image.addEventListener("load", () => {
          if (!this.isCurrentImageRequest(container, image, state, revision)) return;
          image.classList.remove("markdown-image-loading");
          image.classList.add("markdown-image-loaded");
        }, { once: true });
        image.addEventListener("error", () => {
          if (this.isCurrentImageRequest(container, image, state, revision))
            this.markImageError(image);
        }, { once: true });
        image.src = objectUrl;
      } catch {
        if (this.isCurrentImageRequest(container, image, state, revision))
          this.markImageError(image);
      }
    }));
  }

  isCurrentImageRequest(container, image, state, revision) {
    return state.mode === MarkdownRenderer.MODES.WORKSPACE_PREVIEW &&
      state.revision === revision && image.isConnected && container.contains(image);
  }

  markImageError(image) {
    const placeholder = document.createElement("span");
    placeholder.className = "markdown-image-error";
    placeholder.textContent = image.alt || "Image unavailable";
    image.replaceWith(placeholder);
  }

  releaseObjectUrls(state) {
    for (const objectUrl of state.objectUrls)
      URL.revokeObjectURL(objectUrl);
    state.objectUrls.clear();
  }

  cancelScheduled(state) {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.frame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(state.frame);
      state.frame = null;
    }
    if (state.highlightTimer !== null) {
      clearTimeout(state.highlightTimer);
      state.highlightTimer = null;
    }
  }

  scheduleCodeHighlight(container, state, immediately = false) {
    if (state.highlightTimer !== null) {
      clearTimeout(state.highlightTimer);
      state.highlightTimer = null;
    }

    const revision = state.revision;
    const run = () => {
      state.highlightTimer = null;
      this.highlightCodeBlocks(container, state, revision).catch((error) => {
        console.error("Erreur lors du highlight Markdown :", error);
      });
    };

    if (immediately) {
      Promise.resolve().then(run);
    } else {
      state.highlightTimer = setTimeout(run, this.highlightDelayMs);
    }
  }

  getCodeBlockLanguage(codeElement) {
    const languageClass = Array.from(codeElement.classList).find((className) =>
      className.startsWith("language-"),
    );
    if (!languageClass) return "";
    return languageClass.slice("language-".length).toLowerCase();
  }

  async highlightCodeBlocks(container, state, revision) {
    const controller = this.getHighlightController?.();
    if (
      !controller ||
      typeof controller.highlight !== "function" ||
      typeof controller.getSupportedLanguage !== "function" ||
      typeof controller.detectLanguage !== "function"
    ) {
      return;
    }

    const supportedLanguages = await this.getSupportedCodeLanguages(controller);
    if (state.revision !== revision || !container.isConnected) return;

    const codeBlocks = Array.from(container.querySelectorAll("pre > code"));
    for (const codeElement of codeBlocks) {
      if (state.revision !== revision || !container.isConnected) return;

      const languageHint = this.getCodeBlockLanguage(codeElement);
      const code = codeElement.textContent || "";
      if (!languageHint || !code || code.length > 20000) {
        continue;
      }

      const language = await this.resolveCodeLanguage(
        controller,
        languageHint,
        supportedLanguages,
      );
      if (state.revision !== revision || !container.isConnected) return;
      if (!language) continue;

      const tokens = await this.getHighlightedCodeTokens(
        controller,
        code,
        language,
      );
      if (
        state.revision !== revision ||
        !codeElement.isConnected ||
        codeElement.textContent !== code
      ) {
        return;
      }

      this.applyCodeTokens(codeElement, code, tokens);
    }
  }

  async getSupportedCodeLanguages(controller) {
    if (!this.supportedLanguagesPromise) {
      this.supportedLanguagesPromise = Promise.resolve(
        controller.getSupportedLanguage(),
      )
        .then(
          (languages) =>
            new Set(
              (Array.isArray(languages) ? languages : [])
                .filter((language) => typeof language === "string")
                .map((language) => language.toLowerCase()),
            ),
        )
        .catch((error) => {
          this.supportedLanguagesPromise = null;
          throw error;
        });
    }

    return this.supportedLanguagesPromise;
  }

  async resolveCodeLanguage(controller, languageHint, supportedLanguages) {
    if (supportedLanguages.has(languageHint)) return languageHint;

    if (!this.detectedLanguages.has(languageHint)) {
      const detected = Promise.resolve(
        controller.detectLanguage(`code.${languageHint}`),
      )
        .then((language) =>
          typeof language === "string" ? language.toLowerCase() : "",
        )
        .catch((error) => {
          this.detectedLanguages.delete(languageHint);
          throw error;
        });
      this.detectedLanguages.set(languageHint, detected);
    }

    const language = await this.detectedLanguages.get(languageHint);
    return supportedLanguages.has(language) ? language : "";
  }

  async getHighlightedCodeTokens(controller, code, language) {
    const cacheKey = `${language}\u0000${code}`;
    if (this.highlightCache.has(cacheKey)) {
      const cached = this.highlightCache.get(cacheKey);
      this.highlightCache.delete(cacheKey);
      this.highlightCache.set(cacheKey, cached);
      return cached;
    }

    const pending = Promise.resolve(controller.highlight(code, language, true));
    this.highlightCache.set(cacheKey, pending);

    while (this.highlightCache.size > this.maxHighlightCacheEntries) {
      const oldestKey = this.highlightCache.keys().next().value;
      this.highlightCache.delete(oldestKey);
    }

    try {
      const tokens = await pending;
      if (this.highlightCache.get(cacheKey) === pending) {
        this.highlightCache.set(cacheKey, tokens);
      }
      return tokens;
    } catch (error) {
      if (this.highlightCache.get(cacheKey) === pending) {
        this.highlightCache.delete(cacheKey);
      }
      throw error;
    }
  }

  applyCodeTokens(codeElement, code, tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) return;

    const tokensByLine = new Map();
    for (const token of tokens) {
      const line = Number(token?.line);
      if (!Number.isInteger(line) || line < 1) continue;
      if (!tokensByLine.has(line)) tokensByLine.set(line, []);
      tokensByLine.get(line).push(token);
    }

    const lines = code.split("\n");
    const fragment = document.createDocumentFragment();

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const lineTokens = (tokensByLine.get(lineIndex + 1) || []).sort(
        (left, right) => Number(left.column) - Number(right.column),
      );
      let position = 0;

      for (const token of lineTokens) {
        const start = Math.max(0, Number(token.column) - 1);
        const value = typeof token.value === "string" ? token.value : "";
        if (!value || start < position || start > line.length) continue;

        if (start > position) {
          fragment.appendChild(
            document.createTextNode(line.slice(position, start)),
          );
        }

        const span = document.createElement("span");
        const tokenClass =
          typeof token.className === "string" &&
          /^nsh-[a-z0-9-]+$/i.test(token.className)
            ? token.className
            : typeof token.type === "string" &&
                /^nsh-[a-z0-9-]+$/i.test(token.type)
              ? token.type
              : "nsh-token";
        span.className = tokenClass;
        span.textContent = value;
        fragment.appendChild(span);
        position = Math.min(line.length, start + value.length);
      }

      if (position < line.length) {
        fragment.appendChild(document.createTextNode(line.slice(position)));
      }
      if (lineIndex < lines.length - 1) {
        fragment.appendChild(document.createTextNode("\n"));
      }
    }

    codeElement.classList.add("nsh-highlighter");
    codeElement.replaceChildren(fragment);
  }

  destroy(container) {
    const state = this.states.get(container);
    if (!state) return;
    state.revision += 1;
    this.cancelScheduled(state);
    this.releaseObjectUrls(state);
    this.states.delete(container);
  }
}
