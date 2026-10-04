const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");

const SearchSidebar = loadGlobal(
  "src/js/sidebar/Search.Sidebar.js",
  "SearchSidebar",
  {
    Sidebar: class {
      constructor(id, title, icon, side, editor) {
        this.id = id;
        this.title = title;
        this.icon = icon;
        this.side = side;
        this.editor = editor;
        this.isOpen = false;
      }
    },
    SearchResultsScroller: class {},
    NCEPath: { equals: (left, right) => left === right },
    USERCONFIG_FILE_ICONS: { default: "file" },
  },
);

function createSearchSidebar() {
  const calls = [];
  const sidebar = new SearchSidebar({
    fileExplorer: { rootPath: "/workspace" },
    api: {
      async searchInFiles(...args) {
        calls.push(args);
        return { results: [], totalMatches: 0, filesSearched: 0, offset: 0 };
      },
    },
  });
  sidebar.isOpen = true;
  return { sidebar, calls };
}

test("workspace search preserves leading and trailing query whitespace", async () => {
  const { sidebar, calls } = createSearchSidebar();
  sidebar.query = "  hello  ";

  await sidebar.runSearch();

  assert.equal(sidebar.query, "  hello  ");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "  hello  ");
});

test("workspace search treats a whitespace-only query as empty without rewriting it", async () => {
  const { sidebar, calls } = createSearchSidebar();
  sidebar.query = "   ";

  await sidebar.runSearch();

  assert.equal(sidebar.query, "   ");
  assert.equal(calls.length, 0);
});
