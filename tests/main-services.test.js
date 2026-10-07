const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const fsModule = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  FileManager,
  LARGE_FILE_MODE_THRESHOLD,
  MAX_IMAGE_FILE_SIZE,
  resolveMarkdownImagePath,
  validateEntryName,
  atomicWriteFile,
} = require("../dist/ts/addon/FileManager.js");
const { WorkspaceSearch } = require("../dist/ts/addon/WorkspaceSearch.js");
const {
  AgentProcessRunner,
} = require("../dist/ts/addon/AgentProcessRunner.js");
const {
  NceWorkspaceStorage,
  MAX_WORKSPACE_STATE_BYTES,
} = require("../dist/ts/addon/NceWorkspaceStorage.js");

async function tempWorkspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-workspace-"));
  await fsp.mkdir(path.join(root, "sub"));
  await fsp.mkdir(path.join(root, "node_modules"));
  await fsp.writeFile(path.join(root, "a.js"), "const target = 1;\n");
  await fsp.writeFile(path.join(root, "b.txt"), "TARGET twice\ntarget\n");
  await fsp.writeFile(path.join(root, "sub", "c.js"), "target();\n");
  await fsp.writeFile(
    path.join(root, "node_modules", "ignored.js"),
    "target\n",
  );
  await fsp.mkdir(path.join(root, ".nce", "temp"), { recursive: true });
  await fsp.writeFile(path.join(root, ".nce", "internal.js"), "target\n");
  return root;
}

async function cleanupSearchWorkspaces(search, ...roots) {
  if (search)
    await Promise.all(roots.map((root) => search.workspaceIndex.flush(root)));
  await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
}

test("NceWorkspaceStorage creates only local cache/temp infrastructure", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-storage-"));
  try {
    const storage = new NceWorkspaceStorage(root);
    assert.equal(await fsp.stat(storage.nceRoot).catch(() => null), null);
    await storage.writeCacheJson("metadata/value.json", { value: 7 });
    assert.deepEqual(await storage.readCacheJson("metadata/value.json"), {
      value: 7,
    });
    await fsp.writeFile(storage.getCachePath("broken.json"), "{");
    assert.equal(await storage.readCacheJson("broken.json"), null);
    await assert.rejects(() => storage.writeCacheText("../outside", "no"));
    await assert.rejects(() => storage.writeCacheText("/absolute", "no"));
    assert.equal(
      await fsp.readFile(path.join(storage.nceRoot, ".gitignore"), "utf8"),
      "*\n!.gitignore\n",
    );
    assert.deepEqual((await fsp.readdir(root)).sort(), [".nce"]);
    assert.deepEqual((await fsp.readdir(storage.nceRoot)).sort(), [
      ".gitignore",
      "cache",
      "temp",
    ]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("workspace state is atomic, version-preserving, and corruption-safe", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-state-"));
  try {
    const storage = new NceWorkspaceStorage(root);
    const original = { version: 1, tabManager: { tabs: [{ id: 1 }] } };
    await storage.writeWorkspaceState(original);
    assert.deepEqual(await storage.readWorkspaceState(), original);
    assert.equal(
      await fsp.readFile(path.join(root, ".nce", ".gitignore"), "utf8"),
      "*\n!.gitignore\n",
    );

    const rename = fsp.rename;
    fsp.rename = async () => { throw new Error("injected rename failure"); };
    try {
      await assert.rejects(() =>
        storage.writeWorkspaceState({ version: 1, tabManager: { tabs: [] } }),
      );
    } finally {
      fsp.rename = rename;
    }
    assert.deepEqual(await storage.readWorkspaceState(), original);
    assert.equal(
      (await fsp.readdir(path.join(root, ".nce"))).some((name) => name.endsWith(".tmp")),
      false,
    );

    await fsp.writeFile(storage.workspaceStatePath, "{ invalid", "utf8");
    const originalWarn = console.warn;
    console.warn = () => {};
    try { assert.equal(await storage.readWorkspaceState(), null); }
    finally { console.warn = originalWarn; }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("workspace state rejects oversized reads and writes without replacing valid state", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-state-limit-"));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const storage = new NceWorkspaceStorage(root);
    const original = { version: 1, tabManager: { tabs: [] } };
    await storage.writeWorkspaceState(original);
    await assert.rejects(
      () => storage.writeWorkspaceState({ padding: "x".repeat(MAX_WORKSPACE_STATE_BYTES) }),
      /size limit/,
    );
    assert.deepEqual(await storage.readWorkspaceState(), original);

    await fsp.writeFile(
      storage.workspaceStatePath,
      "x".repeat(MAX_WORKSPACE_STATE_BYTES + 1),
      "utf8",
    );
    assert.equal(await storage.readWorkspaceState(), null);
  } finally {
    console.warn = originalWarn;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("workspace state path resolution confines canonical targets and symlinks", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-path-root-"));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-path-outside-"));
  try {
    await fsp.mkdir(path.join(root, "src"));
    await fsp.writeFile(path.join(root, "src", "safe.js"), "safe\n");
    await fsp.writeFile(path.join(outside, "secret.js"), "secret\n");
    await fsp.symlink(path.join(outside, "secret.js"), path.join(root, "src", "escape.js"));
    const manager = new FileManager({ window: null, watcher: null });

    const safe = await manager.resolveWorkspaceStatePath(root, "src/safe.js");
    assert.equal(safe?.isDirectory, false);
    assert.equal(safe?.readable, true);
    assert.equal((await manager.resolveWorkspaceStatePath(root, "src"))?.isDirectory, true);
    for (const unsafe of [
      "../outside", "/etc/passwd", "C:\\Windows\\win.ini",
      "\\\\server\\share", "src/../../outside", "src/\0bad",
    ]) {
      assert.equal(await manager.resolveWorkspaceStatePath(root, unsafe), null);
    }
    assert.equal(await manager.resolveWorkspaceStatePath(root, "src/escape.js"), null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test("FileManager initializes, chunks, saves, and rejects binary/invalid UTF-8", async () => {
  const root = await tempWorkspace();
  try {
    const manager = new FileManager({ window: null, watcher: null });
    const textPath = path.join(root, "a.js");
    const initialized = await manager.initializeFile(textPath);
    assert.equal(initialized.success, true);
    assert.equal(initialized.totalLines, 1);
    assert.equal(initialized.incrementalEligible, true);
    assert.deepEqual(await manager.getFileChunk(textPath, 0, 1), {
      success: true,
      lines: ["const target = 1;"],
    });
    await manager.saveFile(textPath, "updated\n");
    assert.equal(await fsp.readFile(textPath, "utf8"), "updated\n");

    const binaryPath = path.join(root, "binary.bin");
    const invalidPath = path.join(root, "invalid.txt");
    await fsp.writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02]));
    await fsp.writeFile(invalidPath, Buffer.from([0xc3, 0x28]));
    assert.equal(
      (await manager.initializeFile(binaryPath)).errorCode,
      "BINARY_FILE",
    );
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.equal((await manager.initializeFile(invalidPath)).success, false);
    } finally {
      console.error = originalError;
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("FileManager reads bounded stable text for merge and checks merged-save fingerprints", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-merge-read-"));
  try {
    const filePath = path.join(root, "source.txt");
    const manager = new FileManager({ window: null, watcher: null });
    await fsp.writeFile(filePath, "base\r\nline\r\n");
    const disk = await manager.readFileForMerge(filePath);
    assert.deepEqual(disk, {
      success: true,
      content: "base\r\nline\r\n",
      fingerprint: `${Buffer.byteLength("base\r\nline\r\n")}:${(await fsp.stat(filePath)).mtimeMs}`,
    });
    await manager.saveFile(filePath, "merged\r\nline\r\n", disk.fingerprint);
    assert.equal(await fsp.readFile(filePath, "utf8"), "merged\r\nline\r\n");
    const originalError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(
        manager.saveFile(filePath, "stale overwrite", disk.fingerprint),
        (error) => error.code === "FILE_CHANGED_ON_DISK",
      );
    } finally {
      console.error = originalError;
    }
    assert.equal(await fsp.readFile(filePath, "utf8"), "merged\r\nline\r\n");
    assert.equal((await manager.readFileForMerge(path.join(root, "missing"))).reason, "missing");
    assert.equal((await manager.readFileForMerge(root)).reason, "not-a-file");

    const binaryPath = path.join(root, "binary.bin");
    const invalidPath = path.join(root, "invalid.txt");
    const largePath = path.join(root, "large.txt");
    await fsp.writeFile(binaryPath, Buffer.from([0, 1, 2]));
    await fsp.writeFile(invalidPath, Buffer.from([0xc3, 0x28]));
    await fsp.writeFile(largePath, Buffer.alloc(1024 * 1024 + 1, 0x61));
    assert.equal((await manager.readFileForMerge(binaryPath)).reason, "binary-file");
    assert.equal((await manager.readFileForMerge(invalidPath)).reason, "invalid-encoding");
    assert.equal((await manager.readFileForMerge(largePath)).reason, "file-too-large");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("FileManager reads allowlisted raster images with verified MIME and bounded paths", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-picture-"));
  try {
    const manager = new FileManager({});
    const png = path.join(root, "IMAGE.PNG");
    const directory = path.join(root, "directory.png");
    const unsupported = path.join(root, "unsupported.txt");
    await fsp.mkdir(directory);
    await fsp.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fsp.writeFile(unsupported, "not an image");
    const result = await manager.readImageFile(png);
    assert.equal(result.success, true);
    assert.equal(result.mimeType, "image/png");
    assert.deepEqual(Array.from(result.data), [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(result.size, 4);
    assert.equal((await manager.readImageFile(path.join(root, "missing.png"))).code, "SOURCE_NOT_FOUND");
    assert.equal((await manager.readImageFile(directory)).code, "NOT_A_FILE");
    assert.equal((await manager.readImageFile(`${png}\0bad`)).code, "INVALID_PATH");
    assert.equal((await manager.readImageFile(unsupported)).code, "UNSUPPORTED_IMAGE");
    const large = path.join(root, "large.png");
    await fsp.writeFile(large, "");
    await fsp.truncate(large, MAX_IMAGE_FILE_SIZE + 1);
    assert.equal((await manager.readImageFile(large)).code, "IMAGE_TOO_LARGE");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Markdown image paths stay relative to the Markdown source and workspace", async () => {
  const projectRoot = path.join(path.parse(process.cwd()).root, "project");
  const sourcePath = path.join(projectRoot, "docs", "guide", "README.md");
  const workspaceRoot = projectRoot;
  const imagePath = path.join(projectRoot, "docs", "images", "demo.png");
  assert.deepEqual(
    resolveMarkdownImagePath(
      sourcePath,
      path.join("..", "images", "demo.png"),
      workspaceRoot,
    ),
    {
      sourcePath,
      workspaceRoot,
      imagePath,
    },
  );
  assert.equal(
    resolveMarkdownImagePath(
      path.join(projectRoot, "README.md"),
      path.join("..", "..", "etc", "passwd.png"),
      projectRoot,
    ),
    null,
  );
  assert.equal(
    resolveMarkdownImagePath(
      path.join(projectRoot, "README.md"),
      "https://example.com/a.png",
      projectRoot,
    ),
    null,
  );
  assert.deepEqual(
    resolveMarkdownImagePath(
      "C:\\project\\docs\\README.md",
      "..\\images\\demo.png",
      "C:\\project",
    ),
    {
      sourcePath: "C:\\project\\docs\\README.md",
      workspaceRoot: "C:\\project",
      imagePath: "C:\\project\\images\\demo.png",
    },
  );

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-markdown-assets-"));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-markdown-outside-"));
  try {
    await fsp.mkdir(path.join(root, "docs"), { recursive: true });
    const markdownPath = path.join(root, "docs", "README.md");
    const imagePath = path.join(root, "logo.png");
    await fsp.writeFile(markdownPath, "# Test");
    await fsp.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const manager = new FileManager({});
    const allowed = await manager.readImageFile("../logo.png", {
      sourcePath: markdownPath,
      workspaceRoot: root,
    });
    assert.equal(allowed.success, true);
    assert.deepEqual(Array.from(allowed.data), [0x89, 0x50, 0x4e, 0x47]);
    assert.equal((await manager.readImageFile("../../outside.png", {
      sourcePath: markdownPath,
      workspaceRoot: root,
    })).code, "OUTSIDE_WORKSPACE");

    const outsideImage = path.join(outside, "secret.png");
    await fsp.writeFile(outsideImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fsp.symlink(outsideImage, path.join(root, "linked.png"));
    assert.equal((await manager.readImageFile("../linked.png", {
      sourcePath: markdownPath,
      workspaceRoot: root,
    })).code, "OUTSIDE_WORKSPACE");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test("WorkspaceSearch searches recursively while ignoring node_modules", async () => {
  const root = await tempWorkspace();
  let search;
  try {
    search = new WorkspaceSearch({ window: null });
    const result = await search.search(root, "target", {
      caseSensitive: false,
      limit: 20,
    });
    assert.equal(result.totalMatches, 4);
    assert.equal(
      result.results.some((entry) =>
        entry.relativePath.includes("node_modules"),
      ),
      false,
    );
    assert.equal(
      result.results.some((entry) => entry.relativePath === "sub/c.js"),
      true,
    );
    assert.equal(
      result.results.some((entry) => entry.relativePath.startsWith(".nce/")),
      false,
    );

    const onlyJs = await search.search(root, "target", { include: "*.js" });
    assert.equal(
      onlyJs.results.every((entry) => entry.name.endsWith(".js")),
      true,
    );
    const project = await search.getProjectMap(root, root, { maxDepth: 3 });
    assert.equal(project.success, true);
    assert.equal(
      project.entries.some((entry) => entry.name === "node_modules"),
      false,
    );
    assert.equal(
      project.entries.some((entry) => entry.name === ".nce"),
      false,
    );
  } finally {
    await cleanupSearchWorkspaces(search, root);
  }
});

test("WorkspaceSearch reuses one bounded scan and result buffer across pages", async () => {
  const root = await tempWorkspace();
  let search;
  try {
    search = new WorkspaceSearch({ window: null });
    const options = {
      sessionId: "workspace-search-session-pages",
      workspaceGeneration: 4,
      limit: 2,
    };
    const first = await search.search(root, "target", options);
    const beforePages = search.getSearchSessionStats(options.sessionId);
    const second = await search.search(root, "target", { ...options, offset: 2 });
    const third = await search.search(root, "target", { ...options, offset: 4 });
    const afterPages = search.getSearchSessionStats(options.sessionId);

    assert.equal(first.results.length, 2);
    assert.equal(first.hasMore, true);
    assert.equal(second.results.length, 2);
    assert.equal(second.hasMore, false);
    assert.deepEqual(third.results, []);
    assert.equal(first.totalMatches, 4);
    assert.equal(second.filesSearched, 3);
    assert.equal(afterPages.directoriesVisited, beforePages.directoriesVisited);
    assert.equal(afterPages.filesRead, beforePages.filesRead);
    assert.equal(afterPages.resultCount, beforePages.resultCount);
    assert.equal(afterPages.directoriesVisited, 2);
    assert.equal(afterPages.filesRead, 3);
    assert.equal(afterPages.cursor, 4);
    assert.equal(afterPages.activeSessions, 1);
  } finally {
    await cleanupSearchWorkspaces(search, root);
  }
});

test("WorkspaceSearch sessions preserve regex, whole-word, case and path filters", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-search-session-options-"));
  let search;
  const write = async (relativePath, content) => {
    const filePath = path.join(root, relativePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content);
  };
  try {
    await write("src/matches.txt", "Needle needleish\nneedle!\n");
    await write("src/excluded/skip.txt", "needle\n");
    await write("notes.log", "needle\n");
    await write(".hidden/hidden.txt", "needle\n");
    search = new WorkspaceSearch({ window: null });
    const filters = {
      include: "src/**, notes.log",
      exclude: "src/excluded/**",
      caseSensitive: false,
      useRegex: true,
      wholeWord: true,
      ignoreHiddenDirectories: true,
    };
    const direct = await search.search(root, "needle", { ...filters, limit: 20 });
    const sessionId = "workspace-search-session-filter-parity";
    const paged = [];
    let offset = 0;
    let page;
    do {
      page = await search.search(root, "needle", {
        ...filters,
        sessionId,
        workspaceGeneration: 1,
        offset,
        limit: 1,
      });
      paged.push(...page.results);
      offset += page.results.length;
    } while (page.hasMore);

    assert.deepEqual(paged, direct.results);
    assert.equal(page.totalMatches, 3);
    assert.equal(page.filesSearched, 2);

    const cappedFirst = await search.search(root, "needle", {
      ...filters,
      sessionId: "workspace-search-session-limit",
      workspaceGeneration: 1,
      maxMatches: 2,
      limit: 1,
    });
    const cappedSecond = await search.search(root, "needle", {
      ...filters,
      sessionId: "workspace-search-session-limit",
      workspaceGeneration: 1,
      maxMatches: 2,
      offset: 1,
      limit: 1,
    });
    assert.equal(cappedFirst.totalMatches, 2);
    assert.equal(cappedSecond.totalMatches, 2);
    assert.equal(cappedSecond.hasMore, false);
  } finally {
    await cleanupSearchWorkspaces(search, root);
  }
});

test("WorkspaceSearch replaces sessions when query or workspace generation changes", async () => {
  const firstRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-search-session-first-"));
  const secondRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-search-session-second-"));
  const sessionId = "workspace-search-session-replaced";
  let search;
  try {
    await fsp.writeFile(path.join(firstRoot, "first.txt"), "alpha beta\n");
    await fsp.writeFile(path.join(secondRoot, "second.txt"), "alpha beta\n");
    search = new WorkspaceSearch({ window: null });
    const alpha = await search.search(firstRoot, "alpha", {
      sessionId,
      workspaceGeneration: 1,
    });
    const beta = await search.search(firstRoot, "beta", {
      sessionId,
      workspaceGeneration: 1,
    });
    const switched = await search.search(secondRoot, "beta", {
      sessionId,
      workspaceGeneration: 2,
    });

    assert.equal(alpha.results[0].relativePath, "first.txt");
    assert.equal(beta.results[0].preview, "alpha beta");
    assert.equal(switched.results[0].path, path.join(secondRoot, "second.txt"));
    assert.equal(search.getSearchSessionStats(sessionId).activeSessions, 1);
  } finally {
    await cleanupSearchWorkspaces(search, firstRoot, secondRoot);
  }
});

test("WorkspaceSearch cancellation and TTL keep session storage bounded", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-search-session-cleanup-"));
  let search;
  try {
    await fsp.writeFile(path.join(root, "hit.txt"), "hit\n");
    search = new WorkspaceSearch({ window: null });
    const cancelledId = "workspace-search-session-cancelled";
    await search.search(root, "hit", { sessionId: cancelledId, limit: 1 });
    search.cancelSearch(cancelledId);
    assert.equal(search.getSearchSessionStats().activeSessions, 0);
    const latePage = await search.search(root, "hit", {
      sessionId: cancelledId,
      offset: 1,
    });
    assert.deepEqual(latePage.results, []);
    assert.equal(search.getSearchSessionStats().activeSessions, 0);

    const preCancelledId = "workspace-search-session-pre-cancelled";
    search.cancelSearch(preCancelledId);
    const cancelled = await search.search(root, "hit", {
      sessionId: preCancelledId,
      requestId: preCancelledId,
    });
    assert.deepEqual(cancelled.results, []);
    assert.equal(search.getSearchSessionStats().activeSessions, 0);

    for (let index = 0; index < 10; index += 1) {
      await search.search(root, "hit", {
        sessionId: `workspace-search-session-bound-${index}`,
      });
    }
    assert.equal(search.getSearchSessionStats().activeSessions, 8);
    search.cleanupSearchSessions(Date.now() + 6 * 60 * 1000);
    assert.equal(search.getSearchSessionStats().activeSessions, 0);
  } finally {
    await cleanupSearchWorkspaces(search, root);
  }
});

test("WorkspaceSearch streams the first stable batch before completion and reuses its scan", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-search-stream-order-"));
  let search;
  let slowReadStarted = false;
  let finished = false;
  try {
    await fsp.writeFile(
      path.join(root, "a-fast.txt"),
      Array.from({ length: 150 }, () => "needle").join("\n"),
    );
    await fsp.writeFile(path.join(root, "z-slow.txt"), "needle\nneedle\n");
    class DelayedWorkspaceSearch extends WorkspaceSearch {
      async readSearchFile(filePath) {
        if (path.basename(filePath) === "z-slow.txt") {
          slowReadStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return super.readSearchFile(filePath);
      }
    }
    search = new DelayedWorkspaceSearch({ window: null });
    const events = [];
    let firstBatchResolve;
    let completionResolve;
    const firstBatchReceived = new Promise((resolve) => { firstBatchResolve = resolve; });
    const completed = new Promise((resolve) => { completionResolve = resolve; });
    const sessionId = "workspace-search-session-stream-order";
    const started = await search.startSearchStream(root, "needle", {
      sessionId,
      requestId: sessionId,
      workspaceGeneration: 3,
      limit: 100,
    }, (message) => {
      events.push(message);
      if (message.type === "batch" && firstBatchResolve) {
        firstBatchResolve(message);
        firstBatchResolve = null;
      }
      if (message.type === "complete") {
        finished = true;
        completionResolve(message);
      }
    });

    assert.equal(started.success, true);
    const firstBatch = await firstBatchReceived;
    assert.equal(firstBatch.results.length, 100);
    assert.equal(slowReadStarted, false);
    assert.equal(finished, false);

    const completion = await completed;
    assert.equal(completion.totalMatches, 152);
    assert.equal(completion.filesSearched, 2);
    assert.equal(completion.scannedFiles, 2);
    assert.equal(finished, true);
    assert.ok(events.some((event) => event.type === "progress"));
    assert.ok(events.filter((event) => event.type === "batch").every((event) => event.results.length <= 100));
    const streamed = events.filter((event) => event.type === "batch").flatMap((event) => event.results);
    assert.equal(streamed.length, 100);
    assert.ok(streamed.every((result) => result.name === "a-fast.txt"));

    const beforePage = search.getSearchSessionStats(sessionId);
    const secondPage = await search.search(root, "needle", {
      sessionId,
      requestId: "workspace-search-session-stream-page-2",
      workspaceGeneration: 3,
      offset: 100,
      limit: 100,
    });
    const afterPage = search.getSearchSessionStats(sessionId);
    assert.equal(secondPage.results.length, 52);
    assert.equal(secondPage.hasMore, false);
    assert.equal(afterPage.directoriesVisited, beforePage.directoriesVisited);
    assert.equal(afterPage.filesRead, beforePage.filesRead);
    assert.equal(afterPage.cursor, 152);
    assert.deepEqual(
      streamed.concat(secondPage.results).map((result) => result.relativePath),
      [
        ...Array.from({ length: 150 }, () => "a-fast.txt"),
        "z-slow.txt",
        "z-slow.txt",
      ],
    );
  } finally {
    await cleanupSearchWorkspaces(search, root);
  }
});

test("WorkspaceSearch stream cancellation stops later batches and completion", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-search-stream-cancel-"));
  let releaseSlowRead;
  let search;
  try {
    await fsp.writeFile(path.join(root, "a-fast.txt"), Array.from({ length: 150 }, () => "hit").join("\n"));
    await fsp.writeFile(path.join(root, "z-slow.txt"), "hit\n");
    class CancellableWorkspaceSearch extends WorkspaceSearch {
      async readSearchFile(filePath) {
        if (path.basename(filePath) === "z-slow.txt")
          await new Promise((resolve) => { releaseSlowRead = resolve; });
        return super.readSearchFile(filePath);
      }
    }
    search = new CancellableWorkspaceSearch({ window: null });
    const events = [];
    let firstBatchResolve;
    let cancelledResolve;
    const firstBatchReceived = new Promise((resolve) => { firstBatchResolve = resolve; });
    const cancelled = new Promise((resolve) => { cancelledResolve = resolve; });
    const sessionId = "workspace-search-session-stream-cancel";
    await search.startSearchStream(root, "hit", {
      sessionId,
      requestId: sessionId,
      limit: 100,
    }, (message) => {
      events.push(message);
      if (message.type === "batch" && firstBatchResolve) {
        firstBatchResolve(message);
        firstBatchResolve = null;
      }
      if (message.type === "cancelled") cancelledResolve(message);
    });

    await firstBatchReceived;
    search.cancelSearch(sessionId);
    await cancelled;
    releaseSlowRead?.();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(events.filter((event) => event.type === "cancelled").length, 1);
    assert.equal(events.some((event) => event.type === "complete"), false);
    assert.equal(search.getSearchSessionStats().activeSessions, 0);
  } finally {
    releaseSlowRead?.();
    await cleanupSearchWorkspaces(search, root);
  }
});

test("WorkspaceSearch include patterns match directories, globs, files, and multiple paths", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-search-includes-"));
  let search;
  const files = [
    "src/index.js",
    "src/js/App.js",
    "src/js/nested/helper.js",
    "folder/readme.txt",
    "other.js",
  ];

  try {
    for (const relativePath of files) {
      const filePath = path.join(root, ...relativePath.split("/"));
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, "needle\n");
    }

    search = new WorkspaceSearch({ window: null });
    const matchingPaths = async (include) => {
      const result = await search.search(root, "needle", { include });
      return result.results.map((entry) => entry.relativePath).sort();
    };

    const srcFiles = ["src/index.js", "src/js/App.js", "src/js/nested/helper.js"];
    assert.deepEqual(await matchingPaths("src"), srcFiles);
    assert.deepEqual(await matchingPaths("src/"), srcFiles);
    assert.deepEqual(await matchingPaths("src/**"), srcFiles);
    assert.deepEqual(await matchingPaths("src/js/"), [
      "src/js/App.js",
      "src/js/nested/helper.js",
    ]);
    assert.deepEqual(await matchingPaths("src/js/**"), [
      "src/js/App.js",
      "src/js/nested/helper.js",
    ]);
    assert.deepEqual(await matchingPaths("folder/"), ["folder/readme.txt"]);
    assert.deepEqual(await matchingPaths("folder/**"), ["folder/readme.txt"]);
    assert.deepEqual(await matchingPaths("src/js/App.js"), ["src/js/App.js"]);
    assert.deepEqual(await matchingPaths("*.js"), [
      "other.js",
      "src/index.js",
      "src/js/App.js",
      "src/js/nested/helper.js",
    ]);
    assert.deepEqual(await matchingPaths("src/**/*.js"), [
      "src/index.js",
      "src/js/App.js",
      "src/js/nested/helper.js",
    ]);
    assert.deepEqual(await matchingPaths("src\\js\\**\\*.js, other.js"), [
      "other.js",
      "src/js/App.js",
      "src/js/nested/helper.js",
    ]);
  } finally {
    await cleanupSearchWorkspaces(search, root);
  }
});

test("WorkspaceSearch uses warm index candidates with filesystem result parity", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-search-index-parity-"));
  const readPaths = [];
  const fsModule = require("node:fs");
  const originalReaddir = fsModule.promises.readdir;
  let indexedReaddirCalls = 0;
  let search;
  const write = async (relativePath, content) => {
    const filePath = path.join(root, ...relativePath.split("/"));
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content);
  };
  class TrackingWorkspaceSearch extends WorkspaceSearch {
    async readSearchFile(filePath) {
      readPaths.push(path.relative(root, filePath).split(path.sep).join("/"));
      return super.readSearchFile(filePath);
    }
  }

  try {
    await write("src/a.txt", "needle in a\n");
    await write("src/a/child.txt", "needle in nested a\n");
    await write("src/z.txt", "needle in z\n");
    await write("src/excluded/skip.txt", "needle excluded\n");
    await write("src/.hidden/hidden.txt", "needle hidden\n");
    await write("outside.txt", "needle outside include\n");
    search = new TrackingWorkspaceSearch({ window: null });
    const options = {
      include: "src/**",
      exclude: "src/excluded/**",
      ignoreHiddenDirectories: true,
      limit: 20,
    };

    const filesystem = await search.search(root, "needle", {
      ...options,
      sessionId: "workspace-search-missing-index",
    });
    assert.deepEqual(filesystem.results.map((entry) => entry.relativePath), [
      "src/a/child.txt",
      "src/a.txt",
      "src/z.txt",
    ]);
    assert.equal(search.getSearchSessionStats("workspace-search-missing-index").usedIndex, false);
    assert.deepEqual(readPaths, ["src/a/child.txt", "src/a.txt", "src/z.txt"]);

    await search.workspaceIndex.flush(root);
    readPaths.length = 0;
    fsModule.promises.readdir = async (...args) => {
      indexedReaddirCalls++;
      return originalReaddir(...args);
    };
    const indexed = await search.search(root, "needle", {
      ...options,
      sessionId: "workspace-search-warm-index",
    });
    fsModule.promises.readdir = originalReaddir;

    assert.deepEqual(indexed.results, filesystem.results);
    assert.equal(indexedReaddirCalls, 0);
    assert.deepEqual(readPaths, ["src/a/child.txt", "src/a.txt", "src/z.txt"]);
    const stats = search.getSearchSessionStats("workspace-search-warm-index");
    assert.equal(stats.usedIndex, true);
    assert.equal(stats.candidateFiles, 3);
    assert.equal(stats.filesRead, 3);
  } finally {
    fsModule.promises.readdir = originalReaddir;
    await cleanupSearchWorkspaces(search, root);
  }
});

test("WorkspaceSearch falls back when its persistent index is stale", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-search-stale-index-"));
  let search;
  try {
    await fsp.writeFile(path.join(root, "existing.txt"), "needle existing\n");
    const builder = new WorkspaceSearch({ window: null });
    assert.ok(await builder.workspaceIndex.build(root));
    await builder.workspaceIndex.flush(root);

    search = new WorkspaceSearch({ window: null });
    assert.ok(await search.workspaceIndex.load(root), "the persisted index should load");
    await fsp.writeFile(path.join(root, "added-after-index.txt"), "needle added\n");
    const result = await search.search(root, "needle", {
      sessionId: "workspace-search-stale-index",
      limit: 20,
    });

    assert.deepEqual(result.results.map((entry) => entry.relativePath), [
      "added-after-index.txt",
      "existing.txt",
    ]);
    assert.equal(search.getSearchSessionStats("workspace-search-stale-index").usedIndex, false);
  } finally {
    await cleanupSearchWorkspaces(search, root);
  }
});

test("WorkspaceSearch resets indexed results when a watcher reports a concurrent addition", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-search-index-concurrent-add-"));
  const events = [];
  let added = false;
  let search;
  let completeResolve;
  const completed = new Promise((resolve) => { completeResolve = resolve; });
  class ConcurrentAdditionSearch extends WorkspaceSearch {
    async readSearchFile(filePath) {
      if (!added) {
        added = true;
        const addedPath = path.join(root, "added.txt");
        await fsp.writeFile(addedPath, "needle added\n");
        this.workspaceIndex.handleWatcherEvent(root, "add", addedPath);
      }
      return super.readSearchFile(filePath);
    }
  }

  try {
    await fsp.writeFile(path.join(root, "existing.txt"), "needle existing\n");
    search = new ConcurrentAdditionSearch({ window: null });
    assert.ok(await search.workspaceIndex.build(root));
    await search.workspaceIndex.flush(root);
    const sessionId = "workspace-search-index-concurrent-add";
    await search.startSearchStream(root, "needle", {
      sessionId,
      requestId: sessionId,
      limit: 20,
    }, (message) => {
      events.push(message);
      if (message.type === "complete") completeResolve(message);
    });
    const completion = await completed;

    const resetIndex = events.findIndex((event) => event.type === "reset");
    assert.ok(resetIndex >= 0, "the stream should announce that indexed results were discarded");
    const finalResults = events.slice(resetIndex + 1)
      .filter((event) => event.type === "batch")
      .flatMap((event) => event.results);
    assert.deepEqual(finalResults.map((entry) => entry.relativePath), [
      "added.txt",
      "existing.txt",
    ]);
    assert.equal(completion.totalMatches, 2);
    const stats = search.getSearchSessionStats(sessionId);
    assert.equal(stats.usedIndex, false);
    assert.equal(stats.candidateFiles, 2);
  } finally {
    await cleanupSearchWorkspaces(search, root);
  }
});

test("WorkspaceSearch cancellation stops an indexed content scan", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-search-index-cancel-"));
  const reads = [];
  let enteredResolve;
  let releaseRead;
  let search;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const blockedRead = new Promise((resolve) => { releaseRead = resolve; });
  class CancellableIndexedSearch extends WorkspaceSearch {
    async readSearchFile(filePath) {
      reads.push(path.basename(filePath));
      if (path.basename(filePath) === "a.txt") {
        enteredResolve();
        await blockedRead;
      }
      return super.readSearchFile(filePath);
    }
  }

  try {
    await fsp.writeFile(path.join(root, "a.txt"), "needle first\n");
    await fsp.writeFile(path.join(root, "b.txt"), "needle second\n");
    search = new CancellableIndexedSearch({ window: null });
    assert.ok(await search.workspaceIndex.build(root));
    await search.workspaceIndex.flush(root);
    const sessionId = "workspace-search-index-cancel";
    const pending = search.search(root, "needle", { sessionId, limit: 20 });
    await entered;
    search.cancelSearch(sessionId);
    releaseRead();
    const result = await pending;

    assert.deepEqual(result.results, []);
    assert.deepEqual(reads, ["a.txt"]);
    assert.equal(search.getSearchSessionStats().activeSessions, 0);
  } finally {
    releaseRead?.();
    await cleanupSearchWorkspaces(search, root);
  }
});

test("AgentProcessRunner preserves the complete large validation stream", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-process-output-"));
  const script = path.join(root, "emit-output.js");
  await fsp.writeFile(
    script,
    [
      'process.stdout.write("OUTPUT_BEGIN\\n");',
      `process.stdout.write("${"x".repeat(13000)}\\n");`,
      'process.stderr.write("OUTPUT_MIDDLE\\n");',
      'process.stdout.write("OUTPUT_END\\n");',
    ].join("\n"),
  );
  try {
    const runner = new AgentProcessRunner({
      agentApprovalManager: {
        request: async () => ({ decision: "allow" }),
      },
    });
    const result = await runner.run({
      strategy: "node-script",
      projectRoot: root,
      cwd: root,
      target: script,
      workspaceRoot: root,
      maxOutputCharacters: 12000,
      timeoutMs: 10000,
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.match(result.stdout, /OUTPUT_BEGIN/);
    assert.match(result.stderr, /OUTPUT_MIDDLE/);
    assert.match(result.stdout, /OUTPUT_END/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Quick Open project listing is recursive, relative, and uses workspace ignores", async () => {
  const root = await tempWorkspace();
  try {
    await fsp.writeFile(path.join(root, ".env"), "SECRET=test\n");
    await fsp.mkdir(path.join(root, "src", "nested"), { recursive: true });
    await fsp.writeFile(path.join(root, "src", "nested", "App.js"), "app\n");
    await fsp.writeFile(path.join(root, "archive.asar"), "opaque\n");
    const search = new WorkspaceSearch({ window: null });
    const result = await search.listProjectFiles(root);
    assert.equal(result.success, true);
    assert.deepEqual(result.entries.map((entry) => entry.relativePath).sort(), [
      ".env",
      "a.js",
      "b.txt",
      "src/nested/App.js",
      "sub/c.js",
    ]);
    assert.equal(
      result.entries.every((entry) => path.isAbsolute(entry.path)),
      true,
    );
    assert.equal(
      result.entries.some((entry) =>
        entry.relativePath.includes("node_modules"),
      ),
      false,
    );
    await search.workspaceIndex.flush(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Quick Open prunes hidden directories and lists only NCE-openable files", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-quick-open-filter-"));
  const write = async (relativePath, content) => {
    const filePath = path.join(root, relativePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content);
  };

  try {
    await write(".env", "ROOT_SECRET=value\n");
    await write(".benchmark/a.js", "benchmark\n");
    await write(".nce/cache/index.json", "{}\n");
    await write(".git/config", "[core]\n");
    await write("src/.cache/foo.js", "cached\n");
    await write("src/components/.hidden/bar.js", "hidden\n");
    await write("src/normal/foo.js", "export const value = 1;\n");
    await write("src/notes.custom", "plain text fallback\n");
    await write("normal/.env-like-file", "LOCAL=value\n");
    await write("src/README.md", "# Notes\n");
    await write("src/diagram.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await write("src/unknown-extension.mystery", Buffer.from([0, 1, 2, 3]));
    await write("src/archive.pdf", Buffer.from("%PDF-1.7\0binary"));
    await write("src/archive.asar", "opaque\n");

    const search = new WorkspaceSearch({ window: null });
    const result = await search.listProjectFiles(root, {
      openableOnly: true,
      ignoreHiddenDirectories: true,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.entries.map((entry) => entry.relativePath).sort(), [
      ".env",
      "normal/.env-like-file",
      "src/README.md",
      "src/diagram.png",
      "src/normal/foo.js",
      "src/notes.custom",
    ]);
    await search.workspaceIndex.flush(root);
    const index = await search.workspaceIndex.load(root);
    assert.ok(index.entries.some((entry) => entry.relativePath === ".env"));
    assert.ok(index.entries.some((entry) => entry.relativePath === ".benchmark/a.js"));
    assert.ok(index.entries.some((entry) => entry.relativePath === "src/components/.hidden/bar.js"));
    assert.equal(index.entries.some((entry) => entry.relativePath.startsWith(".nce/")), false);
    assert.equal(index.entries.some((entry) => entry.relativePath.startsWith(".git/")), false);
    assert.equal(index.entries.some((entry) => entry.relativePath.endsWith("archive.asar")), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Quick Open serves warm indexed paths without traversal and refreshes per workspace", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-quick-open-indexed-"));
  const otherRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-quick-open-indexed-other-"));
  const write = async (workspace, relativePath, content) => {
    const filePath = path.join(workspace, relativePath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, content);
    return filePath;
  };
  const fsModule = require("node:fs");
  const originalReaddir = fsModule.promises.readdir;
  let readdirCalls = 0;
  try {
    await write(root, ".env", "ROOT=value\n");
    await write(root, ".benchmark/hidden.js", "hidden\n");
    await write(root, "src/.hidden/hidden.js", "hidden\n");
    await write(root, "src/app.js", "export const app = true;\n");
    await write(root, "src/README.md", "# Notes\n");
    await write(root, "src/diagram.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await write(root, "src/notes.custom", "plain text fallback\n");
    await write(root, "src/binary.mystery", Buffer.from([0, 1, 2, 3]));
    await write(root, "src/archive.pdf", Buffer.from("%PDF-1.7\0binary"));
    await write(root, "src/archive.asar", "opaque\n");
    await write(otherRoot, "Other.ts", "export {};\n");

    const builder = new WorkspaceSearch({ window: null });
    assert.ok(await builder.workspaceIndex.build(root));
    assert.ok(await builder.workspaceIndex.build(otherRoot));
    const search = new WorkspaceSearch({ window: null });

    fsModule.promises.readdir = async (...args) => {
      readdirCalls++;
      return originalReaddir(...args);
    };
    const first = await search.listProjectFiles(root, {
      openableOnly: true,
      ignoreHiddenDirectories: true,
    });
    assert.equal(readdirCalls, 0);
    assert.deepEqual(first.entries.map((entry) => entry.relativePath), [
      ".env",
      "src/app.js",
      "src/diagram.png",
      "src/notes.custom",
      "src/README.md",
    ]);
    fsModule.promises.readdir = originalReaddir;

    // A persistent cache loads immediately; its reconciliation runs in the background.
    await search.workspaceIndex.flush(root);
    const removedPath = path.join(root, "src/README.md");
    await fsp.unlink(removedPath);
    search.workspaceIndex.handleWatcherEvent(root, "unlink", removedPath);
    const addedPath = await write(root, "src/Added.md", "# Added\n");
    search.workspaceIndex.handleWatcherEvent(root, "add", addedPath);
    await search.workspaceIndex.flush(root);

    const other = await search.listProjectFiles(otherRoot, {
      openableOnly: true,
      ignoreHiddenDirectories: true,
    });
    await search.workspaceIndex.flush(otherRoot);
    const updated = await search.listProjectFiles(root, {
      openableOnly: true,
      ignoreHiddenDirectories: true,
    });
    assert.deepEqual(other.entries.map((entry) => entry.relativePath), ["Other.ts"]);
    assert.ok(updated.entries.some((entry) => entry.relativePath === "src/Added.md"));
    assert.equal(updated.entries.some((entry) => entry.relativePath === "src/README.md"), false);
    assert.equal(readdirCalls, 0);
  } finally {
    fsModule.promises.readdir = originalReaddir;
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(otherRoot, { recursive: true, force: true });
  }
});

test("Large Workspace Mode preserves project-file results across indexed and filesystem paths", async () => {
  const indexedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-large-workspace-indexed-"));
  const fallbackRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-large-workspace-fallback-"));
  const files = [
    ["README.md", "# Workspace\n"],
    ["src/app.js", "export const app = true;\n"],
    ["src/notes.custom", "plain text fallback\n"],
    [".hidden/secret.js", "hidden\n"],
    ["src/binary.dat", Buffer.from([0, 1, 2, 3, 4])],
  ];
  const indexedSearch = new WorkspaceSearch({ window: null });
  const fallbackSearch = new WorkspaceSearch({ window: null });
  try {
    for (const root of [indexedRoot, fallbackRoot]) {
      for (const [relativePath, content] of files) {
        const filePath = path.join(root, relativePath);
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, content);
      }
    }

    const syntheticLargeEntries = files.map(([relativePath]) => {
      const name = path.posix.basename(relativePath);
      return {
        relativePath,
        name,
        extension: path.posix.extname(name).toLowerCase(),
        size: 2 * 1024 ** 3,
        mtimeMs: 1,
        type: "file",
      };
    });
    assert.equal(indexedSearch.workspaceIndex.primeFromScan(indexedRoot, syntheticLargeEntries), true);
    await indexedSearch.workspaceIndex.flush(indexedRoot);
    assert.equal(indexedSearch.workspaceIndex.getStats(indexedRoot).largeWorkspaceMode, true);

    const options = { openableOnly: true, ignoreHiddenDirectories: true };
    const indexed = await indexedSearch.listProjectFiles(indexedRoot, options);
    const fallback = await fallbackSearch.listProjectFiles(fallbackRoot, options);
    assert.equal(indexed.success, true);
    assert.equal(fallback.success, true);
    assert.deepEqual(
      indexed.entries.map((entry) => entry.relativePath).sort(),
      fallback.entries.map((entry) => entry.relativePath).sort(),
    );
    assert.deepEqual(indexed.entries.map((entry) => entry.relativePath).sort(), [
      "README.md",
      "src/app.js",
      "src/notes.custom",
    ]);
  } finally {
    await Promise.all([
      indexedSearch.workspaceIndex.flush(indexedRoot),
      fallbackSearch.workspaceIndex.flush(fallbackRoot),
    ]);
    await Promise.all([
      fsp.rm(indexedRoot, { recursive: true, force: true }),
      fsp.rm(fallbackRoot, { recursive: true, force: true }),
    ]);
  }
});

test("invalid ASAR stays opaque in explorer, search, and project map", async () => {
  const root = await tempWorkspace();
  const archive = path.join(root, "broken.asar");
  await fsp.writeFile(archive, Buffer.from("not an Electron archive\0target"));
  let search;
  try {
    const manager = new FileManager({});
    const names = await manager.getFolderContent(root);
    assert.equal(
      names.find((entry) => entry.name === "broken.asar")?.type,
      "file",
    );
    assert.equal(
      (await manager.initializeFile(archive)).errorCode,
      "BINARY_FILE",
    );
    assert.equal((await manager.getFileContent([archive]))[archive], undefined);
    search = new WorkspaceSearch({ window: null });
    const result = await search.search(root, "target");
    assert.equal(
      result.results.some((entry) => entry.name === "broken.asar"),
      false,
    );
    assert.equal(
      result.results.some((entry) => entry.name === "a.js"),
      true,
    );
    const map = await search.getProjectMap(root, root);
    const entry = map.entries.find((item) => item.name === "broken.asar");
    assert.deepEqual(
      { binary: entry.binary, lineCount: entry.lineCount },
      { binary: true, lineCount: null },
    );
  } finally {
    await cleanupSearchWorkspaces(search, root);
  }
});

test("FileManager classifies normal folder entries from Dirents without per-entry stats", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-dirents-"));
  const folderPath = path.join(root, "folder");
  await fsp.mkdir(folderPath);
  const fileNames = Array.from({ length: 32 }, (_, index) => `file-${index}.txt`);
  await Promise.all(fileNames.map((name) => fsp.writeFile(path.join(root, name), "x")));
  await fsp.writeFile(path.join(root, "archive.asar"), "opaque archive fixture");

  let symlinksSupported = true;
  try {
    await fsp.symlink(fileNames[0], path.join(root, "linked-file.txt"));
    await fsp.symlink(folderPath, path.join(root, "linked-folder"), "dir");
  } catch (error) {
    symlinksSupported = false;
    await Promise.all([
      fsp.rm(path.join(root, "linked-file.txt"), { force: true }),
      fsp.rm(path.join(root, "linked-folder"), { force: true }),
    ]);
    if (!new Set(["EACCES", "EPERM", "ENOTSUP", "EINVAL"]).has(error?.code)) {
      await fsp.rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  const originalReaddir = fsModule.promises.readdir;
  const originalLoad = Module._load;
  const readdirCalls = [];
  const statPaths = [];
  fsModule.promises.readdir = function (dirPath, options) {
    if (path.resolve(dirPath) === path.resolve(root)) readdirCalls.push(options);
    return Reflect.apply(originalReaddir, this, arguments);
  };
  Module._load = function (request, parent, isMain) {
    if (request === "original-fs") {
      return {
        promises: {
          stat(filePath) {
            statPaths.push(filePath);
            return fsp.stat(filePath);
          },
        },
      };
    }
    return Reflect.apply(originalLoad, this, arguments);
  };

  try {
    const manager = new FileManager({});
    const items = await manager.getFolderContent(root);
    const names = items.map((item) => item.name);
    const expected = [
      "folder",
      ...(symlinksSupported ? ["linked-folder"] : []),
      "archive.asar",
      ...fileNames,
      ...(symlinksSupported ? ["linked-file.txt"] : []),
    ];
    expected.sort((a, b) => {
      const aFolder = a === "folder" || a === "linked-folder";
      const bFolder = b === "folder" || b === "linked-folder";
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return a.localeCompare(b);
    });

    assert.deepEqual(names, expected);
    assert.ok(items.every((item) => item.path === path.join(root, item.name)));
    assert.equal(items.find((item) => item.name === "archive.asar")?.type, "file");
    assert.equal(readdirCalls.length, 1);
    assert.deepEqual(readdirCalls[0], { withFileTypes: true });
    assert.deepEqual(
      statPaths.sort(),
      symlinksSupported
        ? [path.join(root, "linked-file.txt"), path.join(root, "linked-folder")].sort()
        : [],
    );
    if (symlinksSupported) {
      assert.equal(items.find((item) => item.name === "linked-folder")?.type, "folder");
      assert.equal(items.find((item) => item.name === "linked-file.txt")?.type, "file");
    }
  } finally {
    fsModule.promises.readdir = originalReaddir;
    Module._load = originalLoad;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("FileManager preserves listing failure behavior for an unreadable opaque entry", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-dirents-error-"));
  const target = path.join(root, "target.txt");
  const link = path.join(root, "linked.txt");
  await fsp.writeFile(target, "x");
  try {
    await fsp.symlink(target, link);
  } catch (error) {
    await fsp.rm(root, { recursive: true, force: true });
    if (new Set(["EACCES", "EPERM", "ENOTSUP", "EINVAL"]).has(error?.code)) {
      t.skip("symbolic links are unavailable on this platform");
      return;
    }
    throw error;
  }

  const originalLoad = Module._load;
  const originalConsoleError = console.error;
  const loggedErrors = [];
  Module._load = function (request, parent, isMain) {
    if (request === "original-fs") {
      return { promises: { stat: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } } };
    }
    return Reflect.apply(originalLoad, this, arguments);
  };
  console.error = (...args) => loggedErrors.push(args);
  try {
    const items = await new FileManager({}).getFolderContent(root);
    assert.deepEqual(items, []);
    assert.equal(loggedErrors.length, 1);
    assert.equal(loggedErrors[0][1].code, "EACCES");
  } finally {
    Module._load = originalLoad;
    console.error = originalConsoleError;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("atomic save preserves bytes, cleans its sibling temp, and brackets watcher state", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-atomic-save-"));
  const target = path.join(root, "unicode.txt");
  const calls = [];
  const watcher = {
    beginOwnWrite(file) {
      calls.push(["begin", file]);
      return Symbol("save");
    },
    commitOwnWrite(file, token) {
      calls.push(["commit", file, typeof token]);
    },
    cancelOwnWrite() {
      calls.push(["cancel"]);
    },
  };
  try {
    await fsp.writeFile(target, "old");
    const manager = new FileManager({ watcher });
    assert.equal(
      await manager.saveFile(target, "é 你好 😀\r\nLF\nmixed"),
      target,
    );
    assert.equal(await fsp.readFile(target, "utf8"), "é 你好 😀\r\nLF\nmixed");
    assert.deepEqual(
      calls.map((call) => call[0]),
      ["begin", "commit"],
    );
    assert.equal(
      (await fsp.readdir(root)).some(
        (name) => name.includes(".nce-") && name.endsWith(".tmp"),
      ),
      false,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("FileManager propagates filesystem save errors to the renderer", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-save-error-"));
  const watcherCalls = [];
  const manager = new FileManager({
    watcher: {
      beginOwnWrite() { return Symbol("save"); },
      cancelOwnWrite(_filePath, token) { watcherCalls.push(token); },
    },
  });
  const previousConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(manager.saveFile(root, "cannot replace a directory"));
    assert.equal(watcherCalls.length, 1);
    assert.equal((await fsp.readdir(root)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    console.error = previousConsoleError;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("atomic save retries transient rename errors before using a copy fallback", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-atomic-retry-"));
  const target = path.join(root, "file.txt");
  let renameAttempts = 0;
  const operations = new Proxy(fsp, {
    get(targetOperations, property) {
      if (property === "rename") return async (from, to) => {
        renameAttempts++;
        if (renameAttempts < 3) throw Object.assign(new Error("temporarily locked"), { code: "EBUSY" });
        return fsp.rename(from, to);
      };
      if (property === "copyFile") return async () => { throw new Error("copy fallback should not run"); };
      const value = Reflect.get(targetOperations, property, targetOperations);
      return typeof value === "function" ? value.bind(targetOperations) : value;
    },
  });
  try {
    await fsp.writeFile(target, "original");
    await atomicWriteFile(target, "replacement", operations);
    assert.equal(renameAttempts, 3);
    assert.equal(await fsp.readFile(target, "utf8"), "replacement");
    assert.equal((await fsp.readdir(root)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("atomic save uses a verified copy fallback when replacement rename stays denied", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-atomic-fallback-"));
  const target = path.join(root, "file.txt");
  let copyCalls = 0;
  const operations = new Proxy(fsp, {
    get(targetOperations, property) {
      if (property === "rename") return async () => {
        throw Object.assign(new Error("replacement denied"), { code: "EPERM" });
      };
      if (property === "copyFile") return async (from, to, mode) => {
        copyCalls++;
        return fsp.copyFile(from, to, mode);
      };
      const value = Reflect.get(targetOperations, property, targetOperations);
      return typeof value === "function" ? value.bind(targetOperations) : value;
    },
  });
  try {
    await fsp.writeFile(target, "original");
    await atomicWriteFile(target, "replacement", operations);
    assert.equal(await fsp.readFile(target, "utf8"), "replacement");
    assert.equal(copyCalls, 1, "one replacement copy; the backup is created with the target's permissions");
    assert.equal((await fsp.readdir(root)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("failed copy fallback restores the original and preserves the complete recovery temp", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-atomic-recovery-"));
  const target = path.join(root, "file.txt");
  let backupPath = "";
  let siblingOpenCount = 0;
  const operations = new Proxy(fsp, {
    get(targetOperations, property) {
      if (property === "rename") return async () => {
        throw Object.assign(new Error("replacement denied"), { code: "EPERM" });
      };
      if (property === "open") return async (filePath, ...args) => {
        if (args[0] === "wx") {
          siblingOpenCount++;
          if (siblingOpenCount === 2) backupPath = filePath;
        }
        return fsp.open(filePath, ...args);
      };
      if (property === "copyFile") return async (from, to, mode) => {
        if (to === target && from !== backupPath) {
          await fsp.copyFile(from, to, mode);
          throw Object.assign(new Error("destination copy interrupted"), { code: "EIO" });
        }
        return fsp.copyFile(from, to, mode);
      };
      const value = Reflect.get(targetOperations, property, targetOperations);
      return typeof value === "function" ? value.bind(targetOperations) : value;
    },
  });
  try {
    await fsp.writeFile(target, "original");
    let failure;
    try {
      await atomicWriteFile(target, "replacement", operations);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, "SAVE_REPLACEMENT_FAILED");
    assert.equal(await fsp.readFile(target, "utf8"), "original");
    assert.ok(failure?.temporaryPath);
    assert.equal(await fsp.readFile(failure.temporaryPath, "utf8"), "replacement");
    assert.equal(await fsp.stat(backupPath).catch(() => null), null, "verified restoration allows backup cleanup");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("non-retryable atomic rename failures preserve the original and clean incomplete temps", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-atomic-hard-failure-"));
  const target = path.join(root, "file.txt");
  const operations = new Proxy(fsp, {
    get(targetOperations, property) {
      if (property === "rename") return async () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      };
      const value = Reflect.get(targetOperations, property, targetOperations);
      return typeof value === "function" ? value.bind(targetOperations) : value;
    },
  });
  try {
    await fsp.writeFile(target, "original");
    await assert.rejects(atomicWriteFile(target, "replacement", operations), { code: "ENOSPC" });
    assert.equal(await fsp.readFile(target, "utf8"), "original");
    assert.equal((await fsp.readdir(root)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("copy fallback does not follow a symbolic-link destination", { skip: process.platform === "win32" }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-atomic-symlink-"));
  const target = path.join(root, "original.txt");
  const link = path.join(root, "linked.txt");
  const operations = new Proxy(fsp, {
    get(targetOperations, property) {
      if (property === "rename") return async () => {
        throw Object.assign(new Error("replacement denied"), { code: "EPERM" });
      };
      const value = Reflect.get(targetOperations, property, targetOperations);
      return typeof value === "function" ? value.bind(targetOperations) : value;
    },
  });
  try {
    await fsp.writeFile(target, "original");
    await fsp.symlink(target, link);
    let failure;
    try {
      await atomicWriteFile(link, "replacement", operations);
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, "SAVE_REPLACEMENT_FAILED");
    assert.match(failure?.message || "", /symbolic link/);
    assert.equal(await fsp.readFile(target, "utf8"), "original");
    assert.equal(await fsp.readlink(link), target);
    assert.ok(failure?.temporaryPath);
    assert.equal(await fsp.readFile(failure.temporaryPath, "utf8"), "replacement");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("FileManager mutation safety, cache invalidation and nested creation", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-operations-"));
  const manager = new FileManager({});
  try {
    assert.equal(
      (await manager.createFile(root, "nested/a.txt", "original")).success,
      true,
    );
    const a = path.join(root, "nested", "a.txt");
    const b = path.join(root, "nested", "b.txt");
    await manager.initializeFile(a);
    assert.equal((await manager.copyEntry(a, b)).success, true);
    assert.equal((await manager.copyEntry(a, b)).success, false);
    assert.equal((await manager.moveEntry(a, b)).success, false);
    assert.equal(await fsp.readFile(a, "utf8"), "original");
    const duplicate = await manager.duplicateEntry(a);
    assert.equal(duplicate.success, true);
    const moved = path.join(root, "moved.txt");
    assert.equal((await manager.moveEntry(a, moved)).success, true);
    assert.equal((await manager.getFileChunk(a, 0, 1)).success, false);
    await manager.initializeFile(moved);
    const renamed = path.join(root, "renamed.txt");
    assert.equal((await manager.renameEntry(moved, renamed)).success, true);
    assert.equal((await manager.getFileChunk(moved, 0, 1)).success, false);
    await manager.initializeFile(renamed);
    assert.equal((await manager.deleteEntry(renamed)).success, true);
    assert.equal((await manager.getFileChunk(renamed, 0, 1)).success, false);
    for (const invalid of [null, 123, {}, "", "   ", "bad\0path"]) {
      assert.equal(await manager.saveFile(invalid, "x"), undefined);
      assert.equal((await manager.deleteEntry(invalid)).success, false);
      assert.equal(
        (await manager.createFile(invalid, "file", "x")).success,
        false,
      );
      assert.equal((await manager.copyEntry(invalid, b)).success, false);
    }
    assert.equal(
      (await manager.createFile(root, "../escape.txt", "bad")).success,
      false,
    );
    assert.equal(
      (await manager.createFolder(root, "..\\escape")).success,
      false,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("FileManager deletes files and folders only with explicit recursive force", async () => {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), "nce-delete-contract-"),
  );
  const manager = new FileManager({});
  try {
    const file = path.join(root, "file.txt");
    await fsp.writeFile(file, "content");
    assert.deepEqual(await manager.deleteEntry(file, false), {
      success: true,
      path: file,
      type: "file",
    });

    const emptyFolder = path.join(root, "empty");
    await fsp.mkdir(emptyFolder);
    assert.deepEqual(await manager.deleteEntry(emptyFolder, false), {
      success: true,
      path: emptyFolder,
      type: "folder",
    });

    const nonEmpty = path.join(root, "non-empty");
    const child = path.join(nonEmpty, "child.txt");
    await fsp.mkdir(nonEmpty);
    await fsp.writeFile(child, "keep");
    const refused = await manager.deleteEntry(nonEmpty, false);
    assert.equal(refused.success, false);
    assert.equal(refused.code, "FOLDER_NOT_EMPTY");
    assert.equal(await fsp.readFile(child, "utf8"), "keep");

    const forced = await manager.deleteEntry(nonEmpty, true);
    assert.equal(forced.success, true);
    assert.equal(forced.type, "folder");
    assert.equal(forced.forced, true);
    await assert.rejects(fsp.access(nonEmpty));

    const missing = await manager.deleteEntry(
      path.join(root, "missing"),
      false,
    );
    assert.equal(missing.code, "SOURCE_NOT_FOUND");

    assert.equal(
      (await manager.deleteEntry(path.parse(root).root, true)).code,
      "INVALID_PATH",
    );
    if (process.platform !== "win32") {
      const external = await fsp.mkdtemp(
        path.join(os.tmpdir(), "nce-delete-link-target-"),
      );
      const link = path.join(root, "external-link");
      try {
        await fsp.writeFile(path.join(external, "keep.txt"), "keep");
        await fsp.symlink(external, link, "dir");
        const linkResult = await manager.deleteEntry(link, true);
        assert.equal(linkResult.success, true);
        await fsp.access(path.join(external, "keep.txt"));
      } finally {
        await fsp.rm(external, { recursive: true, force: true });
      }
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("FileManager handles case-only file/folder renames, conflicts and missing sources", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-case-rename-"));
  const manager = new FileManager({});
  try {
    const oldFile = path.join(root, "Controller.js");
    const newFile = path.join(root, "controller.js");
    await fsp.writeFile(oldFile, "unchanged");
    assert.equal((await manager.renameEntry(oldFile, newFile)).success, true);
    assert.equal(await fsp.readFile(newFile, "utf8"), "unchanged");

    const oldFolder = path.join(root, "Components");
    const newFolder = path.join(root, "components");
    await fsp.mkdir(oldFolder);
    await fsp.writeFile(path.join(oldFolder, "A.js"), "A");
    assert.equal(
      (await manager.renameEntry(oldFolder, newFolder)).success,
      true,
    );
    assert.equal(await fsp.readFile(path.join(newFolder, "A.js"), "utf8"), "A");

    const a = path.join(root, "a.js");
    const b = path.join(root, "b.js");
    await fsp.writeFile(a, "a");
    await fsp.writeFile(b, "b");
    const conflict = await manager.renameEntry(a, b);
    assert.equal(conflict.code, "TARGET_EXISTS");
    assert.equal(await fsp.readFile(a, "utf8"), "a");
    assert.equal(await fsp.readFile(b, "utf8"), "b");
    assert.equal(
      (
        await manager.renameEntry(
          path.join(root, "missing"),
          path.join(root, "new"),
        )
      ).code,
      "SOURCE_NOT_FOUND",
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("rename basename validation is platform-aware", () => {
  for (const name of ["", "   ", ".", "..", "a/b", "a\\b"])
    assert.equal(validateEntryName(name, "linux"), "INVALID_NAME");
  for (const name of ["CON", "nul.txt", "bad:name", "trailing.", "trailing "])
    assert.equal(validateEntryName(name, "win32"), "INVALID_NAME");
  for (const name of ["my file.js", ".test.js", "résumé.ts", "你好.js"]) {
    assert.equal(validateEntryName(name, "linux"), null);
    assert.equal(validateEntryName(name, "darwin"), null);
  }
});

test("FileManager selects normal and large-file paths by the 20 MiB threshold", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-size-"));
  const manager = new FileManager({});
  const writeTextSize = async (filePath, size) => {
    const handle = await fsp.open(filePath, "w");
    const block = Buffer.alloc(1024 * 1024, 0x61);
    try {
      for (let offset = 0; offset < size; offset += block.length) {
        const count = Math.min(block.length, size - offset);
        await handle.write(block, 0, count, offset);
      }
    } finally {
      await handle.close();
    }
  };
  try {
    assert.equal(LARGE_FILE_MODE_THRESHOLD, 20 * 1024 * 1024);
    for (const size of [19 * 1024 * 1024, LARGE_FILE_MODE_THRESHOLD]) {
      const normal = path.join(root, `normal-${size}.txt`);
      await writeTextSize(normal, size);
      const initialized = await manager.initializeFile(normal);
      assert.equal(initialized.success, true);
      assert.equal(initialized.largeFileMode, false);
      assert.equal(initialized.size, size);
      assert.equal((manager).fileCache.has(normal), true);
      manager.clearFileCache(normal);
    }

    const large = path.join(root, "large.txt");
    await writeTextSize(large, LARGE_FILE_MODE_THRESHOLD + 1);
    const initializedLarge = await manager.initializeFile(large);
    assert.equal(initializedLarge.success, true);
    assert.equal(initializedLarge.largeFileMode, true);
    assert.equal(initializedLarge.size, LARGE_FILE_MODE_THRESHOLD + 1);
    assert.equal(initializedLarge.errorCode, undefined);
    assert.equal((manager).fileCache.has(large), false);
    assert.equal((manager).largeFileStore.has(large), true);
    manager.clearFileCache(large);
    assert.equal((manager).largeFileStore.has(large), false);

    const binary = path.join(root, "binary.bin");
    const binaryHandle = await fsp.open(binary, "w");
    try {
      await binaryHandle.truncate(LARGE_FILE_MODE_THRESHOLD + 1);
      await binaryHandle.write(Buffer.from([0]), 0, 1, 0);
    } finally {
      await binaryHandle.close();
    }
    assert.equal((await manager.initializeFile(binary)).errorCode, "BINARY_FILE");

    const empty = path.join(root, "empty");
    await fsp.writeFile(empty, "");
    const initialized = await manager.initializeFile(empty);
    assert.equal(initialized.totalLines, 1);
    assert.equal(initialized.size, 0);
    assert.equal(initialized.largeFileMode, false);
    assert.deepEqual((await manager.getFileChunk(empty, 0, 1)).lines, [""]);
  } finally {
    manager.clearFileCache();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Large File Mode indexes and reads the 42, 50, and 84 MB text fixtures progressively", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-large-fixtures-"));
  const manager = new FileManager({});
  const filePath = path.join(root, "fixture.txt");
  const writeRepeatedLines = async (lineCount, lineBytes) => {
    const linesPerBlock = Math.floor((1024 * 1024) / lineBytes);
    const block = Buffer.alloc(linesPerBlock * lineBytes, 0x78);
    for (let offset = lineBytes - 1; offset < block.length; offset += lineBytes)
      block[offset] = 0x0a;
    const handle = await fsp.open(filePath, "w");
    try {
      let remaining = lineCount;
      let position = 0;
      while (remaining > 0) {
        const count = Math.min(remaining, linesPerBlock);
        const bytes = count * lineBytes;
        await handle.write(block, 0, bytes, position);
        position += bytes;
        remaining -= count;
      }
    } finally {
      await handle.close();
    }
    const sentinels = new Map([
      [0, "FIRST-SENTINEL"],
      [Math.floor(lineCount / 2), "MIDDLE-SENTINEL"],
      [lineCount - 1, "LAST-SENTINEL"],
    ]);
    const patchHandle = await fsp.open(filePath, "r+");
    try {
      for (const [line, label] of sentinels) {
        const value = Buffer.from(`${label.padEnd(lineBytes - 1, "x")}\n`);
        await patchHandle.write(value, 0, value.length, line * lineBytes);
      }
    } finally {
      await patchHandle.close();
    }
    return sentinels;
  };

  try {
    for (const scenario of [
      { size: 42_000_000, lines: 500_000, lineBytes: 84 },
      { size: 50_000_000, lines: 500_000, lineBytes: 100 },
      { size: 84_000_000, lines: 1_000_000, lineBytes: 84 },
    ]) {
      const sentinels = await writeRepeatedLines(scenario.lines, scenario.lineBytes);
      assert.equal((await fsp.stat(filePath)).size, scenario.size);
      const initialized = await manager.initializeFile(filePath);
      assert.equal(initialized.success, true);
      assert.equal(initialized.largeFileMode, true);
      assert.equal(initialized.totalLines, scenario.lines);
      assert.equal((manager).fileCache.has(filePath), false);
      for (const line of [0, Math.floor(scenario.lines / 2), scenario.lines - 2]) {
        const chunk = await manager.getFileChunk(filePath, line, 2);
        assert.equal(chunk.success, true);
        assert.equal(chunk.lines.length, 2);
        assert.equal(chunk.lines[0].length, scenario.lineBytes - 1);
        assert.equal(chunk.lines[1].length, scenario.lineBytes - 1);
        if (sentinels.has(line))
          assert.equal(chunk.lines[0].startsWith(sentinels.get(line)), true);
        if (sentinels.has(line + 1))
          assert.equal(chunk.lines[1].startsWith(sentinels.get(line + 1)), true);
      }
      manager.clearFileCache(filePath);
      assert.equal((manager).largeFileStore.has(filePath), false);
    }
  } finally {
    manager.clearFileCache();
    await fsp.rm(root, { recursive: true, force: true });
  }
});
