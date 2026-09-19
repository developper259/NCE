const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  FileManager,
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

test("WorkspaceSearch searches recursively while ignoring node_modules", async () => {
  const root = await tempWorkspace();
  try {
    const search = new WorkspaceSearch({ window: null });
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
    await fsp.rm(root, { recursive: true, force: true });
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
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("invalid ASAR stays opaque in explorer, search, and project map", async () => {
  const root = await tempWorkspace();
  const archive = path.join(root, "broken.asar");
  await fsp.writeFile(archive, Buffer.from("not an Electron archive\0target"));
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
    const search = new WorkspaceSearch({ window: null });
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

test("atomic write failures keep the original and clean temporary files", async () => {
  for (const failure of ["write", "rename"]) {
    const original = new Map([["/workspace/file", "original"]]);
    const temporary = new Map();
    const operations = {
      stat: async () => ({ mode: 0o640 }),
      open: async (name) => ({
        writeFile: async (content) => {
          if (failure === "write")
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          temporary.set(name, content);
        },
        sync: async () => {},
        close: async () => {},
      }),
      rename: async (from, to) => {
        if (failure === "rename")
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        original.set(to, temporary.get(from));
        temporary.delete(from);
      },
      unlink: async (name) => {
        temporary.delete(name);
      },
    };
    await assert.rejects(
      atomicWriteFile("/workspace/file", "replacement", operations),
      { code: "EACCES" },
    );
    assert.equal(original.get("/workspace/file"), "original");
    assert.equal(temporary.size, 0);
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

test("FileManager rejects a sparse file above 20 MiB and handles empty files", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-size-"));
  const manager = new FileManager({});
  try {
    const large = path.join(root, "large");
    const handle = await fsp.open(large, "w");
    await handle.truncate(20 * 1024 * 1024 + 1);
    await handle.close();
    assert.equal(
      (await manager.initializeFile(large)).errorCode,
      "FILE_TOO_LARGE",
    );
    const empty = path.join(root, "empty");
    await fsp.writeFile(empty, "");
    const initialized = await manager.initializeFile(empty);
    assert.equal(initialized.totalLines, 1);
    assert.equal(initialized.size, 0);
    assert.deepEqual((await manager.getFileChunk(empty, 0, 1)).lines, [""]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
