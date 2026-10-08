const assert = require("node:assert/strict");
const test = require("node:test");
const { loadGlobal } = require("./helpers/runtime");
const { loadMain } = require("./helpers/main-runtime");

const SavePopup = loadGlobal("src/js/addon/SavePopup.js", "SavePopup");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function loadFileManager(showMessageBox) {
  const { FileManager } = loadMain("dist/ts/addon/FileManager.js", {
    electron: { dialog: { showMessageBox } },
  });
  return new FileManager({ window: {} });
}

test("SavePopup shares an in-flight confirmation by file object, not basename", async () => {
  const files = [
    { id: "workspace-a:1", name: "same.js" },
    { id: "workspace-b:1", name: "same.js" },
  ];
  const calls = [];
  const manager = new SavePopup(
    { api: { confirmUnsavedChanges: (...args) => {
      const result = deferred();
      calls.push({ args, result });
      return result.promise;
    } } },
    { getFileByID: (id) => files.find((file) => file.id === id) },
  );

  const sameFileRequests = Array.from(
    { length: 10 },
    () => manager.confirmClose(files[0].id),
  );
  const otherFileRequest = manager.confirmClose(files[1].id);
  await Promise.resolve();

  assert.ok(sameFileRequests.every((promise) => promise === sameFileRequests[0]));
  assert.notEqual(otherFileRequest, sameFileRequests[0]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ args }) => args), [
    [files[0].id, "same.js"],
    [files[1].id, "same.js"],
  ]);

  calls[0].result.resolve("cancel");
  calls[1].result.resolve("dontSave");
  assert.deepEqual(
    await Promise.all([...sameFileRequests, otherFileRequest]),
    Array(10).fill("cancel").concat("dontSave"),
  );
});

test("main process coalesces ten requests for a file and permits a later prompt", async () => {
  const dialogs = [];
  const started = [];
  const manager = loadFileManager((_window, options) => {
    const result = deferred();
    dialogs.push({ options, result });
    started[dialogs.length - 1]?.resolve();
    return result.promise;
  });

  const waitForDialog = (index) => {
    if (dialogs.length > index) return Promise.resolve();
    started[index] = deferred();
    return started[index].promise;
  };

  const requests = Array.from(
    { length: 10 },
    () => manager.confirmUnsavedChanges("document-1", "same.js"),
  );
  await waitForDialog(0);
  assert.ok(requests.every((promise) => promise === requests[0]));
  assert.equal(dialogs.length, 1);
  dialogs[0].result.resolve({ response: 0 });
  assert.deepEqual(await Promise.all(requests), Array(10).fill("save"));

  const next = manager.confirmUnsavedChanges("document-1", "same.js");
  await waitForDialog(1);
  assert.equal(dialogs.length, 2);
  dialogs[1].result.resolve({ response: 2 });
  assert.equal(await next, "cancel");
});

test("main process serializes distinct files with the same name and binds each decision", async () => {
  const dialogs = [];
  const started = [];
  let activeDialogs = 0;
  let maximumActiveDialogs = 0;
  const manager = loadFileManager((_window, options) => {
    const result = deferred();
    activeDialogs += 1;
    maximumActiveDialogs = Math.max(maximumActiveDialogs, activeDialogs);
    dialogs.push({
      options,
      result,
      resolve(response) {
        activeDialogs -= 1;
        result.resolve({ response });
      },
    });
    started[dialogs.length - 1]?.resolve();
    return result.promise;
  });
  const waitForDialog = (index) => {
    if (dialogs.length > index) return Promise.resolve();
    started[index] = deferred();
    return started[index].promise;
  };

  const fileA = manager.confirmUnsavedChanges("workspace-a:1", "same.js");
  const fileB = manager.confirmUnsavedChanges("workspace-b:1", "same.js");
  await waitForDialog(0);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].options.message, /same\.js/);
  dialogs[0].resolve(2);
  assert.equal(await fileA, "cancel");

  await waitForDialog(1);
  assert.equal(dialogs.length, 2);
  dialogs[1].resolve(1);
  assert.equal(await fileB, "dontSave");
  assert.equal(maximumActiveDialogs, 1);
});

test("closing or rejecting the native dialog resolves to Cancel", async () => {
  const closed = loadFileManager(async () => ({ response: -1 }));
  const rejected = loadFileManager(async () => {
    throw new Error("dialog closed with its window");
  });

  assert.equal(await closed.confirmUnsavedChanges(1, "a.js"), "cancel");
  assert.equal(await rejected.confirmUnsavedChanges(1, "a.js"), "cancel");
});
