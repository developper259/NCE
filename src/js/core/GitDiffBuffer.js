async function buildGitDiffBuffer(editor, options) {
  const filePath = options?.filePath;
  const versions = options?.versions;
  const id = editor.tabManager?.getNextID?.() ?? Date.now();
  const file = new FileNode(editor, id, NCEPath.basename(filePath), null);
  file.isDiffView = true;
  file.isSaved = true;
  file.eol = "\n";
  file.hasFinalNewline = false;
  file.lineEndings = [];
  file.diffActive = false;
  file.diffSnapshot = null;

  const fail = (code) => {
    file.loadError = { code };
    file.lines = [new LineNode("")];
    file.totalLines = 1;
    file.diffRows = [];
    file.loadingState = {
      status: "loaded",
      isLoading: false,
      isFullyLoaded: true,
      loadedLineCount: 1,
      expectedTotalLines: 1,
    };
    file.isLoaded = true;
    return file;
  };

  if (!versions || versions.success !== true) return fail("GIT_DIFF_ERROR");
  if (versions.binary === true) return fail("BINARY_FILE");
  if (versions.tooLarge === true) return fail("FILE_TOO_LARGE");
  const rows = LineDiff.buildRows(versions.oldContent || "", versions.newContent || "");
  if (!rows.length || !rows.some((row) => row.type !== "unchanged"))
    return fail("GIT_DIFF_EMPTY");

  const lines = LineDiff.buildDocumentLines(rows).map((text) => new LineNode(text));
  if (!lines.length) lines.push(new LineNode(""));
  file.lines = lines;
  file.totalLines = Math.max(
    LineDiff.splitLines(versions.oldContent || "").length,
    lines.length,
  );
  file.loadingState = {
    status: "loaded",
    isLoading: false,
    isFullyLoaded: true,
    loadedLineCount: lines.length,
    expectedTotalLines: lines.length,
  };
  file.isLoaded = true;
  file.diffRows = rows;
  const firstChange = rows.find((row) =>
    row.type !== "unchanged" && Number.isInteger(row.documentIndex)) ||
    rows.find((row) => row.type !== "unchanged");
  file.row = Number.isInteger(firstChange?.documentIndex)
    ? firstChange.documentIndex + 1
    : 1;
  file.column = 0;
  try {
    file.language = await editor.highlightController?.detectLanguage?.(file.name) ||
      "plaintext";
  } catch {
    file.language = "plaintext";
  }
  return file;
}
