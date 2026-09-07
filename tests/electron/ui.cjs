module.exports = async function exerciseUI() {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const file = editor.tabManager.createEmptyFile();
  await editor.tabManager.setFocusFile(file);
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
  markdown.render('# Title\n**bold**\n- item\n\n<script>window.__nceXss = true</script>\n[jump](javascript:alert(1))\n[web](https://example.com)\n[mail](mailto:test@example.com)\n![image](https://example.com/x.png)\n```javascript\nconst value = 1;\n```', container);
  check(container.querySelector('h1')?.textContent === 'Title', 'Markdown heading');
  check(container.querySelector('strong')?.textContent === 'bold', 'Markdown bold');
  check(Boolean(container.querySelector('li')), 'Markdown list');
  check(!container.querySelector('script,img') && !window.__nceXss, 'Markdown XSS and images');
  check(!container.querySelector('a[href^="javascript:"]'), 'Unsafe link');
  check(Boolean(container.querySelector('a[href="https://example.com"]')) && Boolean(container.querySelector('a[href="mailto:test@example.com"]')), 'Safe links');
  const deadline = Date.now() + 5000;
  while (!container.querySelector('[class*="nsh-"]') && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  check(Boolean(container.querySelector('[class*="nsh-"]')), 'Markdown JS highlighting');
  container.remove();
  file.isSaved = true;
  await editor.tabManager.closeFile(file.id);
  return true;
};
