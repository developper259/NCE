const fs = require("node:fs");
const path = require("node:path");
const { isInside } = require("../utils/files.cjs");

function resolveWorkspacePath(fixtures, name, fixtureRoot) {
  const workspace = fixtures.workspaces.find((item) => item.name === name);
  if (!workspace) throw new Error(`Workspace fixture '${name}' is not present in the generated profile`);
  if (path.isAbsolute(workspace.path)) throw new Error(`Workspace fixture '${name}' must store a relative path`);
  const root = path.resolve(fixtureRoot);
  const resolved = path.resolve(root, workspace.path);
  if (!isInside(root, resolved) || resolved === root) {
    throw new Error(`Workspace fixture '${name}' resolves outside the fixture root`);
  }
  return resolved;
}

function validateFixtureManifest(fixtureRoot, manifest) {
  const root = path.resolve(fixtureRoot);
  const problems = [];
  const inspectText = (text) => {
    let lines = 1;
    let currentLength = 0;
    let maxLineLength = 0;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === "\r" && text[index + 1] === "\n") continue;
      if (character === "\n") {
        maxLineLength = Math.max(maxLineLength, currentLength);
        currentLength = 0;
        lines += 1;
      } else currentLength += 1;
    }
    maxLineLength = Math.max(maxLineLength, currentLength);
    if (text.endsWith("\n")) lines -= 1;
    return { lines, maxLineLength };
  };

  for (const [name, fixture] of Object.entries(manifest?.files || {})) {
    if (!fixture || path.isAbsolute(fixture.path || "")) {
      problems.push(`file '${name}' has no portable relative path`);
      continue;
    }
    const resolved = path.resolve(root, fixture.path);
    if (!isInside(root, resolved) || resolved === root) {
      problems.push(`file '${name}' resolves outside the fixture root`);
      continue;
    }
    try {
      const content = fs.readFileSync(resolved);
      if (content.length !== fixture.bytes) problems.push(`file '${name}' has ${content.length} bytes; expected ${fixture.bytes}`);
      if (fixture.lines > 0) {
        const text = content.toString("utf8");
        const inspection = inspectText(text);
        if (inspection.lines !== fixture.lines) problems.push(`file '${name}' has ${inspection.lines} lines; expected ${fixture.lines}`);
        if (inspection.maxLineLength !== fixture.maxLineLength) problems.push(`file '${name}' max line length is ${inspection.maxLineLength}; expected ${fixture.maxLineLength}`);
      }
    } catch (error) {
      problems.push(`file '${name}' cannot be read: ${error.message}`);
    }
  }

  for (const workspace of manifest?.workspaces || []) {
    let resolved;
    try { resolved = resolveWorkspacePath(manifest, workspace.name, root); }
    catch (error) { problems.push(error.message); continue; }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      problems.push(`workspace '${workspace.name}' is missing or is not a directory`);
      continue;
    }
    let fileCount = 0;
    let folderCount = 0;
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        // Real NCE workspace runs create their own state below this directory.
        if (directory === resolved && entry.name === ".nce" && entry.isDirectory()) continue;
        if (entry.isDirectory()) { folderCount += 1; visit(path.join(directory, entry.name)); }
        else if (entry.isFile()) fileCount += 1;
      }
    };
    visit(resolved);
    if (fileCount !== workspace.files) problems.push(`workspace '${workspace.name}' has ${fileCount} files; expected ${workspace.files}`);
    if (folderCount !== workspace.folders) problems.push(`workspace '${workspace.name}' has ${folderCount} folders; expected ${workspace.folders}`);
    if (fileCount + folderCount !== workspace.entries) problems.push(`workspace '${workspace.name}' has ${fileCount + folderCount} entries; expected ${workspace.entries}`);
  }

  if (problems.length) throw new Error(`Fixture manifest validation failed:\n- ${problems.join("\n- ")}`);
  return { files: Object.keys(manifest.files || {}).length, workspaces: (manifest.workspaces || []).length };
}

function resetWorkspaceStateDirectories(fixtureRoot, manifest) {
  const removed = [];
  for (const workspace of manifest?.workspaces || []) {
    const root = resolveWorkspacePath(manifest, workspace.name, fixtureRoot);
    const internal = path.join(root, ".nce");
    if (!isInside(root, internal) || path.dirname(internal) !== root) {
      throw new Error(`Refusing to clean workspace state outside '${root}'`);
    }
    if (fs.existsSync(internal)) {
      fs.rmSync(internal, { recursive: true, force: true });
      removed.push(workspace.name);
    }
  }
  return { workspacesReset: removed };
}

function fileLoadDiagnostic(file, expectedLines, expectedBytes) {
  const state = file?.loadingState || {};
  const loadError = state.error || file?.loadError;
  const loadErrorDetails = loadError
    ? `; load error=${loadError.code || "UNKNOWN"}: ${loadError.message || String(loadError)}`
    : "";
  return `path=${file?.path || "<missing>"}; expected lines=${expectedLines ?? state.expectedTotalLines ?? "unknown"}; ` +
    `current lines=${file?.totalLines ?? file?.lines?.length ?? "unknown"}; ` +
    `expected bytes=${expectedBytes ?? "unknown"}; current bytes=${state.loadedBytes ?? "unknown"}; ` +
    `chunks=${state.loadedLineCount ?? "unknown"}/${state.expectedTotalLines ?? "unknown"}; loading state=${state.status || "unknown"}${loadErrorDetails}`;
}

async function waitForFileFullyLoaded({ file, getActiveFile, expectedPath, expectedLines, expectedBytes, timeoutMs = 30000 }) {
  const diagnostic = () => {
    const state = file?.loadingState || {};
    const loadError = state.error || file?.loadError;
    const loadErrorDetails = loadError
      ? `; load error=${loadError.code || "UNKNOWN"}: ${loadError.message || String(loadError)}`
      : "";
    return `path=${file?.path || "<missing>"}; expected lines=${expectedLines ?? state.expectedTotalLines ?? "unknown"}; ` +
      `current lines=${file?.totalLines ?? file?.lines?.length ?? "unknown"}; ` +
      `expected bytes=${expectedBytes ?? "unknown"}; current bytes=${state.loadedBytes ?? "unknown"}; ` +
      `chunks=${state.loadedLineCount ?? "unknown"}/${state.expectedTotalLines ?? "unknown"}; loading state=${state.status || "unknown"}${loadErrorDetails}`;
  };
  if (!file) throw new Error(`FILE_NOT_ACTIVE: no active file; ${diagnostic()}`);
  if (expectedPath && file.path !== expectedPath) throw new Error(`FILE_PATH_MISMATCH: expected ${expectedPath}; ${diagnostic()}`);
  const loader = file.editor?.fileLoader;
  if (typeof loader?.waitForFileLoaded !== "function") throw new Error(`FILE_LOAD_SIGNAL_UNAVAILABLE: ${diagnostic()}`);

  let timer;
  try {
    await Promise.race([
      loader.waitForFileLoaded(file),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`FILE_LOAD_TIMEOUT: ${diagnostic()}`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    throw new Error(`FILE_FULL_LOAD_FAILED: ${error?.message || error}; ${diagnostic()}`);
  } finally {
    clearTimeout(timer);
  }

  if (typeof getActiveFile === "function" && getActiveFile() !== file) {
    throw new Error(`FILE_ACTIVE_CHANGED: active file changed while loading; ${diagnostic()}`);
  }
  const state = file.loadingState;
  const actualLines = Number(state?.loadedLineCount);
  const modelLines = Number(file.totalLines ?? file.lines?.length);
  const complete = state?.status === "loaded" && state.isFullyLoaded === true &&
    actualLines === Number(state.expectedTotalLines) && modelLines === Number(state.expectedTotalLines) &&
    file.isLoaded === true;
  if (!complete) throw new Error(`FILE_NOT_FULLY_LOADED: ${diagnostic()}`);
  if (Number.isFinite(expectedLines) && modelLines !== expectedLines) {
    throw new Error(`FILE_LINE_COUNT_MISMATCH: ${diagnostic()}`);
  }
  return { loadedLines: modelLines, expectedLines: Number(state.expectedTotalLines), loadingState: state.status };
}

function logicalDocumentLength(lines, hasFinalNewline = false) {
  const safeLines = Array.isArray(lines) ? lines : [];
  const lineCharacters = safeLines.reduce((total, line) => total + String(line ?? "").length, 0);
  return lineCharacters + Math.max(0, safeLines.length - 1) + (hasFinalNewline ? 1 : 0);
}

function validateLogicalSelectAll({ selection, selectedLength, lines, lineLengths: suppliedLengths, hasFinalNewline = false }) {
  const lineLengths = Array.isArray(suppliedLengths)
    ? suppliedLengths.map(Number)
    : Array.isArray(lines) ? lines.map((line) => String(line ?? "").length) : [];
  const expectedLength = lineLengths.reduce((total, length) => total + length, 0) +
    Math.max(0, lineLengths.length - 1) + (hasFinalNewline ? 1 : 0);
  const lastRow = Math.max(1, lineLengths.length);
  const lastColumn = lineLengths.at(-1) || 0;
  const includesFinalNewline = selection?.includesFinalNewline === true;
  const validRange = selection?.startRow === 1 && selection?.startColumn === 0 &&
    selection?.endRow === lastRow && selection?.endColumn === lastColumn &&
    includesFinalNewline === (hasFinalNewline === true);
  if (!validRange || selectedLength !== expectedLength) {
    throw new Error(`SELECT_ALL_RANGE_MISMATCH: expected length=${expectedLength}, actual length=${selectedLength}, ` +
      `expected end=${lastRow}:${lastColumn}, actual end=${selection?.endRow ?? "?"}:${selection?.endColumn ?? "?"}, ` +
      `expected final newline=${hasFinalNewline === true}, actual final newline=${includesFinalNewline}`);
  }
  return { expectedLength, lastRow, lastColumn };
}

function horizontalScrollFixture(mode) {
  return mode === "quick" ? "long-line-100k" : "long-line-1m";
}

function workspaceRootEntryCount(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => entry?.name !== ".nce").length;
}

async function cleanupWorkspaceState(explorer, api) {
  if (explorer?.rootPath) await explorer.invalidateWorkspace();
  await api.stopWatching();
  return { rootPath: explorer?.rootPath || "", isLoaded: explorer?.isLoaded === true };
}

async function performLogicalSelectAll({ selectController, sendSelectAll }) {
  await sendSelectAll();
  return {
    selection: selectController.getLogicalSelection(),
    selectedLength: selectController.getSelectionLength(),
  };
}

function summarizeFrameIntervals(frameIntervals) {
  const values = frameIntervals.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const percentile = (q) => {
    if (!values.length) return null;
    const index = Math.min(values.length - 1, Math.floor((values.length - 1) * q));
    return values[index];
  };
  const countOver = (limit) => values.filter((value) => value > limit).length;
  return {
    frames: values.length,
    frameIntervalP50Ms: percentile(0.5),
    frameIntervalP95Ms: values.length >= 20 ? percentile(0.95) : null,
    frameIntervalP99Ms: values.length >= 100 ? percentile(0.99) : null,
    frameIntervalMaxMs: values.length ? values.at(-1) : null,
    framesOver16_7Ms: countOver(16.7),
    framesOver33_3Ms: countOver(33.3),
    framesOver50Ms: countOver(50),
    framesOver100Ms: countOver(100),
  };
}

function classifyWorkspaceFailure(diagnostic) {
  if (!diagnostic?.pathStatus?.exists || !diagnostic?.pathStatus?.isDirectory || diagnostic.pathStatus?.readable === false) return "WORKSPACE_PATH_INVALID";
  if (diagnostic.watcherError || diagnostic.watcherStarted !== true) return "WATCHER_START_FAILED";
  if (diagnostic.initialFolderLoadError || diagnostic.initialFolderLoadCompleted !== true || diagnostic.initialFolderEntryCount === 0) return "INITIAL_FOLDER_LOAD_FAILED";
  return "OTHER";
}

module.exports = {
  resolveWorkspacePath,
  validateFixtureManifest,
  resetWorkspaceStateDirectories,
  fileLoadDiagnostic,
  waitForFileFullyLoaded,
  logicalDocumentLength,
  validateLogicalSelectAll,
  performLogicalSelectAll,
  summarizeFrameIntervals,
  classifyWorkspaceFailure,
  horizontalScrollFixture,
  workspaceRootEntryCount,
  cleanupWorkspaceState,
};
