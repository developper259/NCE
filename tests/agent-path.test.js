const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createAgent } = require("./helpers/agent-runtime");

const context = { window: {} };
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "../src/js/agent/utils/AgentPath.js"), "utf8"),
  context,
);
const AgentPath = context.window.AgentPath;

test("AgentPath.isInside honors normalized path boundaries", () => {
  for (const [candidate, parent] of [
    ["/foo/bar", "/foo/bar"],
    ["/foo/bar/a.js", "/foo/bar"],
    ["/foo/bar/sub/a.js", "/foo/bar/"],
    ["/foo/./bar/sub/../a.js", "/foo/bar"],
    ["tmp", "tmp/"],
    ["tmp/a.js", "./tmp"],
    ["/foo", "/"],
  ]) assert.equal(AgentPath.isInside(candidate, parent), true, candidate);

  for (const [candidate, parent] of [
    ["/foo/bar2/a.js", "/foo/bar"],
    ["/foo/other/a.js", "/foo/bar"],
    ["tmp2/a.js", "tmp"],
    ["", "/foo"],
  ]) assert.equal(AgentPath.isInside(candidate, parent), false, candidate);
});

test("AgentPath.isInside compares Windows paths without case or separator sensitivity", () => {
  for (const candidate of [
    "C:/Project/Tmp",
    "c:/project/tmp/a.js",
    "C:\\PROJECT\\TMP\\sub\\a.js",
    "C:/Project/Tmp/./sub/../a.js",
  ]) assert.equal(AgentPath.isInside(candidate, "C:\\Project\\Tmp\\"), true, candidate);
  assert.equal(AgentPath.isInside("c:/project/a.js", "C:/"), true);
  assert.equal(AgentPath.isInside("C:/Project/Tmp2/a.js", "c:/project/tmp"), false);
  assert.equal(AgentPath.isInside("D:/Project/Tmp/a.js", "C:/Project/Tmp"), false);
});

test("AgentPath normalizes drive roots, UNC shares, mixed separators and Unicode", () => {
  for (const [input, expected] of [
    ["C:\\Projects\\NCE", "C:/Projects/NCE"],
    ["c:\\", "C:/"],
    ["C:/Projects/./NCE/src/../app.js", "C:/Projects/NCE/app.js"],
    ["\\\\Server\\Share\\Project\\..\\src\\café.js", "//Server/Share/src/café.js"],
    ["//server/share", "//server/share"],
    ["", ""],
  ]) assert.equal(AgentPath.normalize(input), expected, input);

  assert.equal(AgentPath.dirname("C:/file.js"), "C:/");
  assert.equal(AgentPath.dirname("\\\\server\\share\\folder\\file.js"), "//server/share/folder");
  assert.equal(AgentPath.dirname("//server/share"), "//server/share");
});

test("AgentPath.relative uses Windows casing and preserves drive and UNC roots", () => {
  assert.equal(
    AgentPath.relative("C:\\Projects\\NCE", "c:/projects/nce/src/file.js"),
    "src/file.js",
  );
  assert.equal(
    AgentPath.relative("\\\\Server\\Share\\Project", "//server/share/project/src/a.js"),
    "src/a.js",
  );
  assert.equal(
    AgentPath.relative("C:/Projects/NCE", "D:/Projects/NCE/file.js"),
    "D:/Projects/NCE/file.js",
  );
  assert.equal(
    AgentPath.relative("//server/share/project", "//server/other/project/file.js"),
    "//server/other/project/file.js",
  );
  assert.equal(AgentPath.equals("C:/Projects/NCE", "c:\\projects\\nce\\"), true);
  assert.equal(AgentPath.equals("//SERVER/Share/a", "\\\\server\\share\\A"), true);
  assert.equal(AgentPath.equals("/Users/Élodie", "/users/Élodie"), false);
});

test("AgentPath containment respects boundaries, roots, traversal and path flavor", () => {
  assert.equal(AgentPath.isInside("c:/projects/nce/src/a.js", "C:\\Projects\\NCE\\"), true);
  assert.equal(AgentPath.isInside("\\\\server\\share\\project\\a.js", "//SERVER/SHARE/project"), true);
  assert.equal(AgentPath.isInside("//server/share2/project/a.js", "//server/share/project"), false);
  assert.equal(AgentPath.isInside("C:/projects/nce2/a.js", "C:/projects/nce"), false);
  assert.equal(AgentPath.isInside("D:/projects/nce/a.js", "C:/projects/nce"), false);
  assert.equal(AgentPath.isInside("/workspace/a.js", "C:/workspace"), false);
  assert.equal(AgentPath.isInside("/foo/bar", "/foo"), true);
  assert.equal(AgentPath.isInside("/foo/Bar", "/foo/bar"), false);
  assert.equal(AgentPath.isInside("C:/", "C:/"), true);
  assert.equal(AgentPath.isInside("", "/workspace"), false);
  assert.equal(AgentPath.isAbsolute("C:\\Projects\\NCE"), true);
  assert.equal(AgentPath.isAbsolute("\\\\server\\share"), true);
  assert.equal(AgentPath.isAbsolute("C:relative\\file.js"), false);
  assert.equal(AgentPath.resolve("C:/Projects/NCE", "src\\..\\file.js"), "C:/Projects/NCE/file.js");
  assert.equal(AgentPath.resolve("/", "workspace/file.js"), "/workspace/file.js");
  assert.equal(AgentPath.resolve("//server/share", "workspace/file.js"), "//server/share/workspace/file.js");
});

test("workspace paths and project-relative names share normalized Windows and UNC rules", () => {
  const agent = createAgent({
    api: {},
    fileExplorer: { rootPath: "C:\\Projects\\NCE" },
    tabManager: { activeFile: null },
  });
  assert.equal(
    agent.resolveWorkspacePath("src\\file.js", "C:/Projects/NCE/"),
    "C:/Projects/NCE/src/file.js",
  );
  assert.equal(
    agent.resolveWorkspacePath("src/../file.js", "C:/Projects/NCE"),
    "C:/Projects/NCE/file.js",
  );
  assert.equal(agent.resolveWorkspacePath("..\\NCE\\escape.js", "C:/Projects/NCE"), null);
  assert.equal(agent.resolveWorkspacePath("../../NCE/escape.js", "C:/Projects/NCE"), null);
  assert.equal(agent.resolveWorkspacePath("C:/Projects/NCE2/file.js", "C:/Projects/NCE"), null);
  assert.equal(agent.resolveWorkspacePath("D:/Projects/NCE/file.js", "C:/Projects/NCE"), null);
  assert.equal(agent.resolveWorkspacePath("C:relative\\file.js", "C:/Projects/NCE"), null);
  assert.equal(agent.resolveWorkspacePath("/Projects/NCE/file.js", "C:/Projects/NCE"), null);
  assert.equal(
    agent.toProjectRelativePath("c:\\projects\\nce\\SRC\\file.js", "C:/Projects/NCE"),
    "SRC/file.js",
  );
  assert.equal(
    agent.resolveWorkspacePath("src\\file.js", "\\\\Server\\Share\\NCE"),
    "//Server/Share/NCE/src/file.js",
  );
});

test("Agent read and write tools send normalized paths through the workspace boundary", async () => {
  const root = "C:\\Projects\\NCE";
  const readPath = "C:/Projects/NCE/src/read.js";
  const writePath = "C:/Projects/NCE/src/created.js";
  const fileContents = { [readPath]: "const read = true;" };
  const readRequests = [];
  const writeRequests = [];
  const existing = new Set([root, "C:/Projects/NCE/src"]);
  const editor = {
    api: {
      async getFileContent(paths) {
        readRequests.push(paths);
        return Object.fromEntries(paths.map((filePath) => [filePath, fileContents[filePath]]));
      },
      async pathExists(filePath) { return existing.has(filePath); },
      async agentFileOperation(_root, operation, args) {
        assert.equal(operation, "createFile");
        const [parentPath, fileName, content, overwrite] = args;
        writeRequests.push({ parentPath, fileName, content, overwrite });
        fileContents[`${parentPath}/${fileName}`] = content;
        existing.add(`${parentPath}/${fileName}`);
        return { success: true };
      },
    },
    fileExplorer: { rootPath: root },
    tabManager: { activeFile: null, getFileByPath: () => null },
  };
  const agent = createAgent(editor);

  const read = await agent.readFile("src\\read.js");
  assert.equal(read.success, true);
  assert.deepEqual(Array.from(readRequests[0]), [readPath]);

  const written = await agent.createWorkspaceFile({
    path: "src\\created.js",
    content: "const created = true;",
  });
  assert.equal(written.success, true);
  assert.deepEqual(writeRequests[0], {
    parentPath: "C:/Projects/NCE/src",
    fileName: "created.js",
    content: "const created = true;",
    overwrite: false,
  });
  assert.equal(written.path, "src/created.js");
});
