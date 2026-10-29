const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

function createDocument() {
  const doc = {};
  class FakeNode {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.className = "";
      this.title = "";
      this.type = "";
      this.hidden = false;
      this._text = "";
      this.ownerDocument = doc;
    }
    set textContent(value) { this._text = String(value); }
    get textContent() { return this._text; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) {
      this.children = children.flatMap((child) =>
        child?.tagName === "#fragment" ? child.children : [child]);
    }
    addEventListener() {}
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
  }
  doc.createElement = (tag) => new FakeNode(tag);
  doc.createDocumentFragment = () => new FakeNode("#fragment");
  return doc;
}

const document = createDocument();
const GitDiffView = loadGlobal("src/js/view/GitDiffView.js", "GitDiffView", {
  document,
  NCEPath: { basename: (value) => String(value || "").split("/").pop() },
});

function createView(getDiff) {
  const calls = [];
  const host = document.createElement("div");
  const view = new GitDiffView({
    domManager: { getElement: () => host },
    api: {
      git: {
        async getDiff(filePath, options) {
          calls.push([filePath, options]);
          return typeof getDiff === "function" ? getDiff(filePath, options) : getDiff;
        },
      },
    },
  });
  return { view, host, calls };
}

function tab(overrides = {}) {
  return {
    filePath: "/workspace/src/app.js",
    relativePath: "src/app.js",
    staged: false,
    statusKind: "modified",
    originalPath: null,
    ...overrides,
  };
}

test("GitDiffView classifies unified diff lines", () => {
  assert.equal(GitDiffView.classifyLine("diff --git a/x b/x"), "meta");
  assert.equal(GitDiffView.classifyLine("index 111..222 100644"), "meta");
  assert.equal(GitDiffView.classifyLine("--- a/x"), "meta");
  assert.equal(GitDiffView.classifyLine("+++ b/x"), "meta");
  assert.equal(GitDiffView.classifyLine("@@ -1 +1 @@"), "hunk");
  assert.equal(GitDiffView.classifyLine("+added"), "add");
  assert.equal(GitDiffView.classifyLine("-removed"), "del");
  assert.equal(GitDiffView.classifyLine(" context"), "context");
  assert.equal(GitDiffView.classifyLine("\\ No newline at end of file"), "meta");
});

test("GitDiffView explains every bounded diff reason", () => {
  assert.match(GitDiffView.describeUnavailable("untracked"), /Untracked/);
  assert.match(GitDiffView.describeUnavailable("binary"), /Binary/);
  assert.match(GitDiffView.describeUnavailable("too-large"), /too large/);
  assert.match(GitDiffView.describeUnavailable("no-changes"), /No changes/);
});

test("GitDiffView renders the requested staged diff with status classes", async () => {
  const { view, host, calls } = createView({
    success: true,
    available: true,
    patch: "diff --git a/src/app.js b/src/app.js\n@@ -1 +1 @@\n-old\n+new",
  });
  try {
    view.show(tab({ staged: true, originalPath: "src/old-app.js" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(host.hidden, false);
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ["/workspace/src/app.js", { staged: true }]);
    assert.equal(view.title.textContent, "app.js");
    assert.equal(view.badge.textContent, "Staged");
    assert.equal(view.subtitle.textContent, "src/app.js ← src/old-app.js");
    assert.equal(view.status.hidden, true);
    const classes = view.patch.children.map((child) => child.className);
    assert.equal(classes.some((name) => name.includes("git-diff-add")), true);
    assert.equal(classes.some((name) => name.includes("git-diff-del")), true);
    assert.equal(classes.some((name) => name.includes("git-diff-hunk")), true);
  } finally {
    view.destroy();
  }
});

test("GitDiffView shows an untracked preview instead of a fake diff", async () => {
  const { view } = createView({
    success: true,
    available: false,
    reason: "untracked",
    preview: "preview text\n",
  });
  try {
    view.show(tab());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(view.status.textContent, /Untracked/);
    assert.equal(view.patch.children.length, 1);
    assert.equal(view.patch.children[0].className, "git-diff-view-preview");
    assert.equal(view.patch.children[0].textContent, "preview text\n");
  } finally {
    view.destroy();
  }
});

test("GitDiffView reports binary, missing, and failed diffs without pretending", async () => {
  const binary = createView({ success: true, available: false, reason: "binary" });
  try {
    binary.view.show(tab());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(binary.view.status.textContent, /Binary/);
    assert.equal(binary.view.patch.children.length, 0);
  } finally {
    binary.view.destroy();
  }

  const failure = createView({ success: false, code: "INVALID_PATH", error: "Not allowed." });
  try {
    failure.view.show(tab());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(failure.view.status.textContent, "Not allowed.");
    assert.equal(failure.view.status.dataset.state, "error");
  } finally {
    failure.view.destroy();
  }

  const thrown = createView(() => { throw new Error("ipc failed"); });
  try {
    thrown.view.show(tab());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(thrown.view.status.textContent, /could not be loaded/);
    assert.equal(thrown.view.status.dataset.state, "error");
  } finally {
    thrown.view.destroy();
  }
});

test("GitDiffView refreshes its tab and stops tracking it after close", async () => {
  const { view, calls } = createView({
    success: true,
    available: true,
    patch: "@@ -1 +1 @@\n-old\n+new",
  });
  try {
    const target = tab();
    view.show(target);
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 2);
    view.close(target);
    assert.equal(view.tab, null);
    assert.equal(view.patch.children.length, 0);
    view.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 2, "a closed tab is not reloaded");
  } finally {
    view.destroy();
  }
});
