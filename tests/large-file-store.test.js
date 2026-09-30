const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  LargeFileStore,
  LARGE_FILE_SCAN_CHUNK_SIZE,
} = require("../dist/ts/addon/LargeFileStore.js");

async function fixture(content) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "nce-large-store-"));
  const filePath = path.join(root, "fixture.txt");
  await fsp.writeFile(filePath, content);
  return { root, filePath };
}

test("large-file byte index preserves line, EOL, Unicode, and EOF semantics", async () => {
  const store = new LargeFileStore();
  const cases = [
    { content: "", lines: [""], endings: [], eol: "\n", final: false },
    { content: "abc", lines: ["abc"], endings: [], eol: "\n", final: false },
    { content: "abc\n", lines: ["abc"], endings: ["\n"], eol: "\n", final: true },
    { content: "abc\r\ndef\r\n", lines: ["abc", "def"], endings: ["\r\n", "\r\n"], eol: "\r\n", final: true },
    { content: "a\nb\r\nc", lines: ["a", "b", "c"], endings: ["\n", "\r\n"], eol: "\n", final: false },
    { content: "😀\n\nz", lines: ["😀", "", "z"], endings: ["\n", "\n"], eol: "\n", final: false },
    { content: "a\r\nb\nc\r\n", lines: ["a", "b", "c"], endings: ["\r\n", "\n", "\r\n"], eol: "\r\n", final: true },
  ];

  for (const scenario of cases) {
    const { root, filePath } = await fixture(scenario.content);
    try {
      const entry = await store.index(filePath, await fsp.stat(filePath));
      assert.equal(entry.totalLines, scenario.lines.length);
      assert.equal(entry.lineStarts instanceof Float64Array, true);
      assert.equal(entry.lineEndingKinds instanceof Uint8Array, true);
      assert.equal(entry.eol, scenario.eol);
      assert.equal(entry.hasFinalNewline, scenario.final);
      for (let start = 0; start < scenario.lines.length; start += 1) {
        const result = await store.getChunk(filePath, start, 1);
        assert.equal(result.success, true);
        assert.deepEqual(result.lines, [scenario.lines[start]]);
        assert.deepEqual(result.lineEndings, scenario.endings.slice(start, start + 1));
      }
      store.release(filePath);
      assert.equal(store.has(filePath), false);
    } finally {
      store.release(filePath);
      await fsp.rm(root, { recursive: true, force: true });
    }
  }
});

test("large-file scan handles UTF-8 and CRLF exactly at scan buffer boundaries", async () => {
  const store = new LargeFileStore();
  const scanSize = LARGE_FILE_SCAN_CHUNK_SIZE;
  const first = `${"a".repeat(scanSize - 1)}\r\n`;
  const second = `${"b".repeat(scanSize - 3)}😀`;
  const content = `${first}${second}\nlast`;
  const { root, filePath } = await fixture(content);
  try {
    const entry = await store.index(filePath, await fsp.stat(filePath));
    assert.equal(entry.totalLines, 3);
    assert.equal(entry.eol, "\r\n");
    assert.equal(entry.hasFinalNewline, false);
    assert.deepEqual((await store.getChunk(filePath, 0, 1)).lines, [first.slice(0, -2)]);
    assert.deepEqual((await store.getChunk(filePath, 1, 2)).lines, [second, "last"]);
    assert.deepEqual(
      (await store.getChunk(filePath, 1, 2)).lineEndings,
      ["\n"],
    );
  } finally {
    store.release(filePath);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("large-file indexes reject changed disk versions and release cleanly", async () => {
  const store = new LargeFileStore();
  const { root, filePath } = await fixture("one\ntwo\n");
  try {
    await store.index(filePath, await fsp.stat(filePath));
    assert.equal((await store.getChunk(filePath, 0, 1)).success, true);
    await fsp.writeFile(filePath, "new version\nthird\n");
    const stale = await store.getChunk(filePath, 0, 1);
    assert.equal(stale.success, false);
    assert.equal(stale.errorCode, "STALE_FILE_INDEX");
    store.release(filePath);
    assert.equal(store.has(filePath), false);

    await fsp.writeFile(filePath, "one\ntwo\n");
    await store.index(filePath, await fsp.stat(filePath));
    await fsp.writeFile(filePath, "ONE\nTWO\n");
    const fixedTime = new Date(Date.now() + 5000);
    await fsp.utimes(filePath, fixedTime, fixedTime);
    const changedContent = await store.getChunk(filePath, 0, 1);
    assert.equal(changedContent.success, false);
    assert.equal(changedContent.errorCode, "STALE_FILE_INDEX");
    store.release(filePath);
    await fsp.rm(filePath);
  } finally {
    store.release(filePath);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("large-file index rejects invalid UTF-8 outside the binary sample", async () => {
  const store = new LargeFileStore();
  const bytes = Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0xc3, 0x28])]);
  const { root, filePath } = await fixture(bytes);
  try {
    await assert.rejects(store.index(filePath, await fsp.stat(filePath)), {
      code: "INVALID_UTF8",
    });
  } finally {
    store.release(filePath);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("cancelling a scan releases its build and does not publish an index", async () => {
  const store = new LargeFileStore();
  const content = Buffer.alloc(8 * 1024 * 1024, 0x61);
  const { root, filePath } = await fixture(content);
  try {
    const pending = store.index(filePath, await fsp.stat(filePath));
    store.release(filePath);
    await assert.rejects(pending, { code: "FILE_LOAD_CANCELLED" });
    assert.equal(store.has(filePath), false);
    await fsp.rm(filePath);
  } finally {
    store.release(filePath);
    await fsp.rm(root, { recursive: true, force: true });
  }
});
