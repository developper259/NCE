class MarkdownRenderer {
  constructor(options = {}) {
    this.throttleMs = Math.max(16, Number(options.throttleMs) || 50);
    this.highlightDelayMs = Math.max(
      this.throttleMs,
      Number(options.highlightDelayMs) || 180,
    );
    this.getHighlightController = options.getHighlightController || null;
    this.supportedLanguagesPromise = null;
    this.detectedLanguages = new Map();
    this.highlightCache = new Map();
    this.maxHighlightCacheEntries = 32;
    this.states = new WeakMap();
    this.markdown = this.createMarkdownEngine();
  }

  createMarkdownEngine() {
    const markdownItFactory = window.markdownit;

    if (typeof markdownItFactory !== "function") {
      console.error(
        "markdown-it is not available; Markdown will stay plain text.",
      );
      return null;
    }

    const markdown = markdownItFactory({
      html: false,
      breaks: true,
      linkify: false,
      typographer: false,
    });

    markdown.disable("image");
    markdown.validateLink = (url) => this.isSafeLink(url);
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

  normalize(markdown) {
    return typeof markdown === "string" ? markdown : "";
  }

  getState(container) {
    let state = this.states.get(container);
    if (!state) {
      state = {
        markdown: "",
        renderedMarkdown: null,
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
    state.onRendered = options.onRendered || null;
    state.highlightImmediately = options.highlightImmediately !== false;
    state.revision += 1;
    this.cancelScheduled(state);
    this.commit(container, state);
  }

  update(markdown, container, options = {}) {
    if (!(container instanceof Element)) return;

    const state = this.getState(container);
    const nextMarkdown = this.normalize(markdown);
    if (nextMarkdown !== state.markdown) {
      state.revision += 1;
      if (state.highlightTimer !== null) {
        clearTimeout(state.highlightTimer);
        state.highlightTimer = null;
      }
    }
    state.markdown = nextMarkdown;
    state.onRendered = options.onRendered || state.onRendered;
    state.highlightImmediately = false;

    if (
      state.markdown === state.renderedMarkdown ||
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

  commit(container, state) {
    if (state.markdown === state.renderedMarkdown) {
      if (state.highlightImmediately) {
        state.revision += 1;
        this.scheduleCodeHighlight(container, state, true);
      }
      const onRendered = state.onRendered;
      state.onRendered = null;
      onRendered?.();
      return;
    }

    if (!this.markdown) {
      container.textContent = state.markdown;
    } else {
      const template = document.createElement("template");
      template.innerHTML = this.markdown.render(state.markdown);
      container.replaceChildren(template.content.cloneNode(true));
    }

    state.renderedMarkdown = state.markdown;
    state.lastRenderAt = performance.now();
    state.revision += 1;
    this.scheduleCodeHighlight(
      container,
      state,
      state.highlightImmediately,
    );

    const onRendered = state.onRendered;
    state.onRendered = null;
    onRendered?.();
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
        .then((languages) =>
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
          typeof token.type === "string" &&
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
    this.states.delete(container);
  }
}
