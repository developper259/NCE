module.exports = async function exerciseUI() {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  check(Boolean(document.querySelector('.nce-titlebar')), 'NCE Title Bar');
  check(getComputedStyle(document.querySelector('.nce-titlebar')).webkitAppRegion === 'drag', 'Title Bar drag region');

  const confirmTrashSetting = SettingsView.getSettings().find(
    setting => setting.key === 'files.confirmMoveToTrash',
  );
  const confirmPermanentSetting = SettingsView.getSettings().find(
    setting => setting.key === 'files.confirmPermanentDelete',
  );
  check(confirmTrashSetting?.category === 'Files', 'Confirm Move to Trash Files category');
  check(confirmTrashSetting?.label === 'Confirm Move to Trash', 'Confirm Move to Trash label');
  check(confirmTrashSetting?.description === 'Ask before moving files or folders to the Trash.', 'Confirm Move to Trash description');
  check(confirmPermanentSetting?.category === 'Files', 'Confirm Permanent Deletion Files category');
  check(confirmPermanentSetting?.label === 'Confirm Permanent Deletion', 'Confirm Permanent Deletion label');
  check(confirmPermanentSetting?.description === 'Ask before permanently deleting files or folders.', 'Confirm Permanent Deletion description');
  const confirmationSettingView = Object.create(SettingsView.prototype);
  confirmationSettingView.editor = editor;
  const confirmationControl = confirmationSettingView.createCheckbox(
    confirmTrashSetting,
    'setting-files-confirmMoveToTrash-smoke',
  );
  const confirmationInput = confirmationControl.querySelector('input');
  const nonEmptyControl = confirmationSettingView.createCheckbox(
    confirmPermanentSetting,
    'setting-files-confirmPermanentDelete-smoke',
  );
  const nonEmptyInput = nonEmptyControl.querySelector('input');
  const previousConfirmTrash = SETTINGS_GET('files.confirmMoveToTrash');
  const previousConfirmPermanent = SETTINGS_GET('files.confirmPermanentDelete');
  let autoSaveCallsFromDeletePreference = 0;
  const originalSetAutoSaveState = editor.setAutoSaveState;
  editor.setAutoSaveState = function (...args) {
    autoSaveCallsFromDeletePreference++;
    return originalSetAutoSaveState.apply(this, args);
  };
  document.body.append(confirmationControl);
  document.body.append(nonEmptyControl);
  try {
    const waitForConfirmDelete = async value => {
      const deadline = Date.now() + 3000;
      while ((SETTINGS_GET('files.confirmMoveToTrash') !== value || confirmationInput.disabled) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 10));
      check(SETTINGS_GET('files.confirmMoveToTrash') === value, `files.confirmMoveToTrash becomes ${value}`);
      check(confirmationInput.checked === value, `checkbox reflects files.confirmMoveToTrash ${value}`);
      check(confirmationInput.disabled === false, 'Confirm File Deletion write settles before another click');
    };
    confirmationInput.click();
    await waitForConfirmDelete(!previousConfirmTrash);
    confirmationInput.click();
    await waitForConfirmDelete(previousConfirmTrash);
    const waitForNonEmpty = async value => {
      const deadline = Date.now() + 3000;
      while ((SETTINGS_GET('files.confirmPermanentDelete') !== value || nonEmptyInput.disabled) && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 10));
      check(SETTINGS_GET('files.confirmPermanentDelete') === value, `files.confirmPermanentDelete becomes ${value}`);
      check(nonEmptyInput.checked === value, `checkbox reflects files.confirmPermanentDelete ${value}`);
      check(SETTINGS_GET('files.confirmMoveToTrash') === previousConfirmTrash, 'permanent-delete preference leaves Trash preference unchanged');
      check(nonEmptyInput.disabled === false, 'Ask for Not Empty Folder write settles before another click');
    };
    nonEmptyInput.click();
    await waitForNonEmpty(!previousConfirmPermanent);
    nonEmptyInput.click();
    await waitForNonEmpty(previousConfirmPermanent);
    check(autoSaveCallsFromDeletePreference === 0, 'Confirm File Deletion never changes Auto Save');
  } finally {
    editor.setAutoSaveState = originalSetAutoSaveState;
    confirmationControl.remove();
    nonEmptyControl.remove();
  }

  editor.titleBar.destroy();
  const commandCalls = [];
  const titleEditor = {
    autoSaveEnabled: false,
    getAutoSaveState() { return this.autoSaveEnabled; },
    toggleAutoSave() { this.autoSaveEnabled = !this.autoSaveEnabled; titleBar.refreshAutoSaveState(); },
    api: {
      platform: 'win32',
      quit: () => commandCalls.push('exit'),
      appCommand: command => commandCalls.push(command),
    },
    tabManager: { activeFile: { name: 'this-is-a-very-long-typescript-file-name-used-for-testing.ts', isSaved: false, isVisuallyDirty() { return !this.isSaved; } } },
    fileExplorer: { projectName: 'A very long NCE project name used for layout testing' },
    keyBinding: {
      control_save: () => commandCalls.push('save'),
      control_undo: () => commandCalls.push('undo'),
      control_toggle_file_explorer: () => commandCalls.push('explorer'),
      control_open_command: () => commandCalls.push('palette'),
      control_quit_app: () => commandCalls.push('exit'),
    },
  };
  const titleBar = new TitleBar(titleEditor);
  check(titleBar.menuButtons.length === 5, 'Windows renderer menus including Terminal');
  check(titleBar.root.querySelector('[data-command="open_recent_menu"]'), 'Open Recent renderer submenu');
  check(titleBar.root.querySelector('.nce-titlebar-submenu .nce-titlebar-menu-item')?.disabled === true, 'Empty Open Recent state');
  titleBar.setRecentFolders(['/tmp/workspace']);
  titleBar.openMenu('file');
  const recentTrigger = titleBar.root.querySelector('[data-command="open_recent_menu"]');
  recentTrigger.focus();
  titleBar.handleDocumentKeyDown({ key: 'ArrowRight', preventDefault() {}, stopPropagation() {} });
  check(document.activeElement?.textContent === '/tmp/workspace', 'Open Recent keyboard submenu entry');
  titleBar.handleDocumentKeyDown({ key: 'ArrowLeft', preventDefault() {}, stopPropagation() {} });
  check(document.activeElement === recentTrigger, 'Open Recent keyboard submenu exit');
  titleBar.setRecentFolders([]);
  titleBar.closeMenus({ restoreFocus: false });
  check(!titleBar.root.querySelector('[data-command="view.devtools"]'), 'No renderer DevTools menu item');
  check(titleBar.title.textContent.startsWith('● '), 'Dirty title indicator');
  titleBar.toggleMenu('file'); check(titleBar.openMenuId === 'file', 'Open File menu');
  const autoSaveItem = titleBar.root.querySelector('[data-command="auto_save"]');
  check(autoSaveItem?.getAttribute('role') === 'menuitemcheckbox', 'Auto Save checkbox role');
  check(autoSaveItem.getAttribute('aria-checked') === 'false', 'Auto Save initially off');
  autoSaveItem.click(); check(titleEditor.autoSaveEnabled && autoSaveItem.getAttribute('aria-checked') === 'true', 'Auto Save mouse toggle on');
  titleBar.openMenu('file'); autoSaveItem.focus();
  titleBar.handleDocumentKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  check(!titleEditor.autoSaveEnabled && autoSaveItem.getAttribute('aria-checked') === 'false', 'Auto Save keyboard toggle off');
  titleBar.openMenu('edit'); check(titleBar.openMenuId === 'edit', 'Switch menu');
  titleBar.handleDocumentKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  check(titleBar.openMenuId === null, 'Escape closes menu');
  titleBar.openMenu('file');
  titleBar.handleDocumentPointerDown({ target: document.body });
  check(titleBar.openMenuId === null, 'Outside click closes menu');
  titleBar.execute('save'); titleBar.execute('undo');
  titleBar.execute('toggle_file_explorer'); titleBar.execute('open_command');
  titleBar.execute('quit_app');
  titleBar.execute('help.about');
  check(commandCalls.join(',') === 'save,undo,explorer,palette,exit,help.about', 'Title Bar command dispatch');
  titleBar.destroy();
  editor.titleBar = new TitleBar(editor);

  const file = editor.tabManager.createEmptyFile();
  await editor.tabManager.setFocusFile(file);
  editor.setAutoSaveState(true, { persist: false });
  check(file.autoSave === true, 'Auto Save state reaches FileNode');
  file.setIsSaved(false);
  const autoSaveTab = editor.tabManager.createFileOBJ(file);
  check(autoSaveTab?.querySelector('.file-saved img'), 'Auto Save tab always keeps close button');
  editor.titleBar.refresh();
  check(!editor.titleBar.title.textContent.startsWith('● '), 'Auto Save title never shows dirty indicator');
  file.deletedFromDisk = true;
  const deletedTab = editor.tabManager.createFileOBJ(file);
  check(deletedTab?.querySelector('.file-unsaved'), 'Deleted Auto Save file stays visibly unsaved');
  editor.titleBar.refresh();
  check(editor.titleBar.title.textContent.startsWith('● '), 'Deleted Auto Save file stays dirty in title');
  file.deletedFromDisk = false;
  editor.setAutoSaveState(false, { persist: false });
  file.setIsSaved(true);
  editor.tabManager.refresh();
  editor.writerController.write('one two\nthree');
  editor.selectController.setSelection({ row: 2, column: 3 }, { row: 1, column: 4 });
  check(editor.selectController.containsSelected === 'two\nthr', 'Backward multiline selection');
  editor.writerController.write('replacement');
  check(file.serializeContent() === 'one replacementee', 'Selection replacement');
  await editor.historyController.undo();
  check(file.serializeContent() === 'one two\nthree', 'Undo selection replacement');
  editor.selectController.unSelectAll();
  editor.searchController.search('o');
  check(editor.searchController.results.length === 2, 'Search occurrences');
  editor.searchController.next(); editor.searchController.previous(); editor.searchController.close();
  editor.selectController.selectAll(true);
  check(editor.selectController.containsSelected === 'one two\nthree', 'Select All');
  editor.selectController.unSelectAll();
  editor.cursorController.setCursorPosition(999, 999);
  check(file.row === 2 && file.column === 5, 'Cursor boundaries');
  editor.bottomBar.refresh();
  check(Boolean(editor.bottomBar.cursorOBJ.textContent), 'Bottom bar cursor');

  let accepted;
  const panel = editor.quickPanel;
  panel.open({ items: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }], onAccept: item => { accepted = item.id; } });
  const key = key => panel.handleKeyDown({ key, preventDefault() {}, stopPropagation() {} });
  key('ArrowDown'); key('ArrowUp');
  panel.input.value = 'beta'; panel.handleInput();
  check(panel.session.visibleItems.length === 1, 'Quick panel filter');
  key('Enter'); check(accepted === 'b' && !panel.isOpen(), 'Quick panel accept');
  panel.open({ items: [] }); key('Escape'); check(!panel.isOpen(), 'Quick panel Escape');
  for (const id of ['file-explorer', 'search', 'agent']) {
    const menu = editor.sidebarManager.menus.get(id);
    check(Boolean(menu), `Sidebar registration: ${id}`);
    editor.sidebarManager.openMenu(id); check(menu.isOpen, `Sidebar open: ${id}`);
    editor.sidebarManager.toggleMenu(id); check(!menu.isOpen, `Sidebar toggle: ${id}`);
  }

  const container = document.createElement('div'); document.body.append(container);
  const markdown = new MarkdownRenderer({ getHighlightController: () => editor.highlightController });
  markdown.render('# Title\n**bold**\n- item\n\n<h1>Agent HTML stays text</h1>\n<script>window.__nceXss = true</script>\n[jump](javascript:alert(1))\n[web](https://example.com)\n[mail](mailto:test@example.com)\n![image](https://example.com/x.png)\n```javascript\nconst value = 1;\n```', container);
  check(container.querySelector('h1')?.textContent === 'Title', 'Markdown heading');
  check(!Array.from(container.querySelectorAll('h1')).some(node => node.textContent === 'Agent HTML stays text'), 'Agent raw HTML remains strict');
  check(container.querySelector('strong')?.textContent === 'bold', 'Markdown bold');
  check(Boolean(container.querySelector('li')), 'Markdown list');
  check(!container.querySelector('script,img') && !window.__nceXss, 'Markdown XSS and images');
  check(!container.querySelector('a[href^="javascript:"]'), 'Unsafe link');
  check(Boolean(container.querySelector('a[href="https://example.com"]')) && Boolean(container.querySelector('a[href="mailto:test@example.com"]')), 'Safe links');
  const deadline = Date.now() + 5000;
  while (!container.querySelector('[class*="nsh-"]') && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  check(Boolean(container.querySelector('[class*="nsh-"]')), 'Markdown JS highlighting');
  container.remove();

  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const createdMarkdownUrls = [];
  const revokedMarkdownUrls = [];
  const markdownImageReferences = [];
  URL.createObjectURL = function (blob) {
    const url = originalCreateObjectURL.call(URL, blob);
    createdMarkdownUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    revokedMarkdownUrls.push(url);
    return originalRevokeObjectURL.call(URL, url);
  };
  try {
    const previewContainer = document.createElement('div');
    previewContainer.className = 'markdown-preview-content';
    document.body.append(previewContainer);
    const preview = new MarkdownRenderer({
      readImageFile: async (reference, context) => {
        markdownImageReferences.push({ reference, context });
        return {
          success: true,
          mimeType: 'image/png',
          data: Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='), value => value.charCodeAt(0)),
        };
      },
    });
    const readme = `<p align="center"><img src="./assets/logo/NCE/dark-logo.png" alt="NCE" width="96" onerror="alert(1)" style="position:fixed" data-random="bad"></p>

<h1 align="center">NCE</h1>

<p align="center"><strong>A lightweight editor</strong></p>

## About

**NCE** is a code editor.

- Fast
- Simple

![Markdown Logo](./assets/logo/NCE/dark-logo.png)

Run \`npm install\`.

<pre><code class="language-js">const value = 1;</code></pre>

<script>window.__nceXss = true</script><iframe src="https://evil.example"></iframe>
<a href="javascript:alert(1)">bad</a><a href="https://github.com/">good</a>
<img src="https://tracking.example/pixel.png" alt="remote" width="calc(100%)">`;
    preview.render(readme, previewContainer, {
      mode: MarkdownRenderer.MODES.WORKSPACE_PREVIEW,
      sourcePath: '/project/README.md',
      workspaceRoot: '/project',
    });
    const waitFor = async (condition, message) => {
      const expires = Date.now() + 2000;
      while (!condition() && Date.now() < expires) await new Promise(resolve => setTimeout(resolve, 10));
      check(condition(), message);
    };
    await waitFor(() => previewContainer.querySelectorAll('img[src^="blob:"]').length === 2, 'Markdown local images load through blob URLs');
    check(previewContainer.querySelector('p[align="center"] img[width="96"]'), 'README HTML image and alignment survive sanitization');
    check(previewContainer.querySelector('h1[align="center"]')?.textContent === 'NCE', 'README HTML heading is rendered');
    check(previewContainer.querySelector('strong')?.textContent === 'A lightweight editor', 'README inline HTML formatting is rendered');
    check(previewContainer.querySelector('h2')?.textContent === 'About' && previewContainer.querySelectorAll('li').length === 2, 'Markdown headings and lists still render');
    check(!getComputedStyle(previewContainer).fontFamily.includes('JetBrains Mono'), 'Markdown document uses a sans-serif font');
    check(getComputedStyle(previewContainer.querySelector('h1')).borderBottomStyle === 'solid', 'README title has its document divider');
    check(getComputedStyle(previewContainer.querySelector('code')).fontFamily.includes('monospace'), 'Code remains monospace inside the document');
    check(!previewContainer.querySelector('script,iframe,[onerror],[style],[data-random]') && !window.__nceXss, 'Unsafe HTML and attributes are removed');
    check(!previewContainer.querySelector('a[href^="javascript:"]'), 'Workspace preview blocks unsafe links');
    check(previewContainer.querySelector('a[href="https://github.com/"][target="_blank"][rel="noopener noreferrer"]'), 'Workspace preview keeps safe external links isolated');
    check(!previewContainer.querySelector('img[src^="https://"],img[src^="data:"],img[src^="file:"]'), 'Remote and dangerous image sources never reach the DOM');
    check(markdownImageReferences.length === 2 && markdownImageReferences.every(({ reference, context }) => reference === './assets/logo/NCE/dark-logo.png' && context.sourcePath === '/project/README.md' && context.workspaceRoot === '/project'), 'Both Markdown and HTML images use the source-aware local image API');

    preview.render('![second](./second.png)', previewContainer, {
      mode: MarkdownRenderer.MODES.WORKSPACE_PREVIEW,
      sourcePath: '/project/README.md',
      workspaceRoot: '/project',
    });
    await waitFor(() => previewContainer.querySelector('img[src^="blob:"]')?.alt === 'second', 'Markdown preview rerenders the latest image');
    check(createdMarkdownUrls.length === 3 && revokedMarkdownUrls.includes(createdMarkdownUrls[0]) && revokedMarkdownUrls.includes(createdMarkdownUrls[1]), 'Rerender releases the previous image Blob URLs');
    preview.destroy(previewContainer);
    check(revokedMarkdownUrls.includes(createdMarkdownUrls[2]), 'Destroy releases the active image Blob URL');
    previewContainer.remove();
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }

  const updateContainer = document.createElement('div');
  document.body.append(updateContainer);
  const updateContexts = [];
  const updateRenderer = new MarkdownRenderer({
    readImageFile: async (_reference, context) => {
      updateContexts.push(context);
      return {
        success: true,
        mimeType: 'image/png',
        data: Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='), value => value.charCodeAt(0)),
      };
    },
  });
  const unchangedMarkdown = '![context](./asset.png)';
  updateRenderer.render(unchangedMarkdown, updateContainer, {
    mode: MarkdownRenderer.MODES.WORKSPACE_PREVIEW,
    sourcePath: '/project/README.md',
    workspaceRoot: '/project',
  });
  const waitForUpdate = async () => {
    const expires = Date.now() + 2000;
    while (updateContexts.length < 1 && Date.now() < expires) await new Promise(resolve => setTimeout(resolve, 10));
    check(updateContexts.length === 1, 'Initial workspace image request completes');
  };
  await waitForUpdate();
  updateRenderer.update(unchangedMarkdown, updateContainer, {
    sourcePath: '/project/docs/README.md',
  });
  const updatedExpires = Date.now() + 2000;
  while (updateContexts.length < 2 && Date.now() < updatedExpires) await new Promise(resolve => setTimeout(resolve, 10));
  check(updateContexts.length === 2 && updateContexts[1].sourcePath === '/project/docs/README.md', 'Update rerenders identical Markdown when its source path changes');
  updateRenderer.destroy(updateContainer);
  updateContainer.remove();

  const raceContainer = document.createElement('div');
  document.body.append(raceContainer);
  const pendingImages = new Map();
  const raceRenderer = new MarkdownRenderer({
    readImageFile: (reference) => new Promise(resolve => pendingImages.set(reference, resolve)),
  });
  raceRenderer.render('![old](./old.png)', raceContainer, { mode: MarkdownRenderer.MODES.WORKSPACE_PREVIEW, sourcePath: '/project/README.md', workspaceRoot: '/project' });
  raceRenderer.render('![new](./new.png)', raceContainer, { mode: MarkdownRenderer.MODES.WORKSPACE_PREVIEW, sourcePath: '/project/README.md', workspaceRoot: '/project' });
  const imageData = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='), value => value.charCodeAt(0));
  pendingImages.get('./new.png')({ success: true, mimeType: 'image/png', data: imageData });
  await new Promise(resolve => setTimeout(resolve, 20));
  pendingImages.get('./old.png')({ success: true, mimeType: 'image/png', data: imageData });
  await new Promise(resolve => setTimeout(resolve, 20));
  check(raceContainer.querySelector('img')?.alt === 'new' && raceContainer.querySelector('img')?.getAttribute('src')?.startsWith('blob:'), 'Late image response cannot replace the current preview');
  raceRenderer.destroy(raceContainer);
  raceContainer.remove();
  file.isSaved = true;
  await editor.tabManager.closeFile(file.id);
  return true;
};
