const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobal } = require('./helpers/runtime');

const buildTabContextMenu = loadGlobal(
  'src/js/contextMenu/Tab.ContextMenu.js',
  'buildTabContextMenu',
);

test('tab context menu exposes the requested order and dynamic enabled states', () => {
  const files = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const tabManager = {
    files,
    getFileIndexByID: (id) => files.findIndex((file) => file.id === id),
    closeFile() {},
    closeOtherFiles() {},
    closeFilesToLeft() {},
    closeFilesToRight() {},
    closeFiles() {},
  };
  const menu = buildTabContextMenu(tabManager);

  assert.deepEqual(Object.keys(menu), [
    'close', 'closeOthers', 'sep1', 'closeLeft', 'closeRight', 'sep2', 'closeAll',
  ]);
  assert.equal(menu.closeLeft.enabled(files[0]), false);
  assert.equal(menu.closeRight.enabled(files[0]), true);
  assert.equal(menu.closeLeft.enabled(files[1]), true);
  assert.equal(menu.closeRight.enabled(files[2]), false);
  assert.equal(menu.closeOthers.enabled(files[1]), true);

  tabManager.files = [files[1]];
  assert.equal(menu.closeOthers.enabled(files[1]), false);
  assert.equal(menu.closeAll.enabled(files[1]), true);
});

test('ContextMenuManager sends disabled items to Electron without registering callbacks', async () => {
  let listener;
  let payload;
  const window = {
    api: {
      onContextMenuTriggered(callback) { listener = callback; },
      async openContextMenu(actions) { payload = actions; },
    },
  };
  const ContextMenuManager = loadGlobal(
    'src/js/manager/ContextMenuManager.js',
    'ContextMenuManager',
    { window },
  );
  const manager = new ContextMenuManager();
  let calls = 0;
  manager.setMenu('tabs', {
    enabled: { name: 'Enabled', enabled: () => true, callback: () => calls++ },
    disabled: { name: 'Disabled', enabled: () => false, callback: () => calls++ },
  });

  await manager.openContextMenu('tabs', { id: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(
    payload.map(({ name, enabled }) => ({ name, enabled })),
  )), [
    { name: 'Enabled', enabled: true },
    { name: 'Disabled', enabled: false },
  ]);
  listener('Disabled');
  assert.equal(calls, 0);

  await manager.openContextMenu('tabs', { id: 1 });
  listener('Enabled');
  assert.equal(calls, 1);
});
