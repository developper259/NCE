const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createElement(tagName) {
  const listeners = new Map();
  return {
    tagName: tagName.toUpperCase(),
    children: [],
    attributes: new Map(),
    checked: false,
    disabled: false,
    className: "",
    htmlFor: "",
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    addEventListener(type, callback) { listeners.set(type, callback); },
    async emit(type) { return listeners.get(type)?.({ target: this }); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
  };
}

function createSettingsViewContext() {
  const writes = [];
  const document = { createElement };
  const window = {
    api: {
      async setSetting(key, value) {
        writes.push([key, value]);
        return true;
      },
    },
  };
  const context = vm.createContext({
    document,
    window,
    console: { error() {} },
    Map,
    Set,
    Object,
    String,
    Number,
    Boolean,
  });
  const root = path.resolve(__dirname, "..");
  vm.runInContext(
    fs.readFileSync(path.join(root, "src/config/Settings.js"), "utf8") +
      "\n" +
      fs.readFileSync(path.join(root, "src/js/view/SettingsView.js"), "utf8") +
      "\nthis.__SettingsView = SettingsView;",
    context,
  );
  return { context, writes };
}

test("Files settings expose both persistent confirmation checkboxes", () => {
  const { context } = createSettingsViewContext();
  const settings = context.__SettingsView.getSettings().filter((item) =>
    ["files.confirmMoveToTrash", "files.confirmPermanentDelete"].includes(item.key),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(settings.map(({ key, category, label, description, control }) => ({
    key,
    category,
    label,
    description,
    control,
  })))), [
    {
      key: "files.confirmMoveToTrash",
      category: "Files",
      label: "Confirm Move to Trash",
      description: "Ask before moving files or folders to the Trash.",
      control: "checkbox",
    },
    {
      key: "files.confirmPermanentDelete",
      category: "Files",
      label: "Confirm Permanent Deletion",
      description: "Ask before permanently deleting files or folders.",
      control: "checkbox",
    },
  ]);
  const view = Object.create(context.__SettingsView.prototype);
  view.query = "permanent";
  view.category = "Editor";
  assert.deepEqual(
    JSON.parse(JSON.stringify(view.getVisibleSettings().map((setting) => setting.key))),
    ["files.confirmPermanentDelete"],
  );
});

test("checkbox changes persist the selected setting without calling Auto Save for file deletion", async () => {
  const { context, writes } = createSettingsViewContext();
  context.SETTINGS_INITIALIZE({ files: {
    autoSave: false,
    confirmMoveToTrash: true,
    confirmPermanentDelete: true,
  } });
  const autoSaveCalls = [];
  const refreshed = [];
  const view = Object.create(context.__SettingsView.prototype);
  view.editor = {
    setAutoSaveState(value) { autoSaveCalls.push(value); },
    getAutoSaveState() { return context.SETTINGS_GET("files.autoSave"); },
    bottomBar: { refreshScrollers() { refreshed.push(true); } },
  };
  const inputs = new Map();
  view.host = {
    querySelector(selector) {
      return inputs.get(selector.slice(1)) || null;
    },
  };

  const deleteControl = view.createCheckbox(
    { key: "files.confirmMoveToTrash" },
    "setting-files-confirmMoveToTrash",
  );
  const deleteInput = deleteControl.children[0];
  inputs.set(deleteInput.id, deleteInput);
  assert.equal(deleteInput.checked, true);
  deleteInput.checked = false;
  await deleteInput.emit("change");
  assert.deepEqual(writes, [["files.confirmMoveToTrash", false]]);
  assert.deepEqual(autoSaveCalls, []);
  assert.equal(context.SETTINGS_GET("files.confirmMoveToTrash"), false);
  assert.equal(context.SETTINGS_GET("files.confirmPermanentDelete"), true);
  assert.equal(deleteInput.disabled, false);

  view.sync("files.confirmMoveToTrash");
  assert.equal(deleteInput.checked, false);
  context.SETTINGS_INITIALIZE({ files: { confirmMoveToTrash: true } });
  assert.equal(context.SETTINGS_GET("files.confirmPermanentDelete"), true);
  view.sync("files.confirmMoveToTrash");
  assert.equal(deleteInput.checked, true);

  const nonEmptyControl = view.createCheckbox(
    { key: "files.confirmPermanentDelete" },
    "setting-files-confirmPermanentDelete",
  );
  const nonEmptyInput = nonEmptyControl.children[0];
  inputs.set(nonEmptyInput.id, nonEmptyInput);
  assert.equal(nonEmptyInput.checked, true);
  nonEmptyInput.checked = false;
  await nonEmptyInput.emit("change");
  assert.deepEqual(writes.slice(-1), [["files.confirmPermanentDelete", false]]);
  assert.equal(context.SETTINGS_GET("files.confirmMoveToTrash"), true);
  assert.equal(context.SETTINGS_GET("files.confirmPermanentDelete"), false);
  nonEmptyInput.checked = true;
  await nonEmptyInput.emit("change");
  assert.equal(context.SETTINGS_GET("files.confirmMoveToTrash"), true);
  assert.equal(context.SETTINGS_GET("files.confirmPermanentDelete"), true);

  const autoSaveControl = view.createCheckbox(
    { key: "files.autoSave", apply: (editor, value) => {
      editor.setAutoSaveState(value);
      return true;
    } },
    "setting-files-autoSave",
  );
  const autoSaveInput = autoSaveControl.children[0];
  autoSaveInput.checked = true;
  await autoSaveInput.emit("change");
  assert.deepEqual(autoSaveCalls, [true]);
  assert.equal(refreshed.length, 4);
});

test("a rejected checkbox write restores the persisted value", async () => {
  const { context } = createSettingsViewContext();
  context.window.api.setSetting = async () => false;
  context.SETTINGS_INITIALIZE({ files: { confirmMoveToTrash: true, confirmPermanentDelete: true } });
  const view = Object.create(context.__SettingsView.prototype);
  view.editor = { bottomBar: { refreshScrollers() {} } };
  const checkbox = view.createCheckbox(
    { key: "files.confirmMoveToTrash" },
    "setting-files-confirmMoveToTrash",
  ).children[0];
  checkbox.checked = false;
  await checkbox.emit("change");
  assert.equal(checkbox.checked, true);
  assert.equal(context.SETTINGS_GET("files.confirmMoveToTrash"), true);
});
