class KeyBinding {
  constructor(e) {
    this.editor = e;

    this.func = {
      save: this.control_save,
      open_file: this.control_open_file,
      open_folder: this.control_open_folder,
      new_file: this.control_new_file,
      close_file: this.control_close_file,
      close_all_file: this.control_close_all_file,
      copy: this.control_copy,
      paste: this.control_paste,
      cut: this.control_cut,
      undo: this.control_undo,
      redo: this.control_redo,
      find: this.control_find,
      replace: this.control_replace,
      open_command: this.control_open_command,
      delete_line: this.control_delete_line,
      select_all: this.control_select_all,

      toggle_file_explorer: this.control_toggle_file_explorer,
      toggle_search: this.control_toggle_search,
      toggle_agent: this.control_toggle_agent,

      Escape: this.key_escape,
      Tab: this.key_tab,
      Delete: this.key_delete,
      Backspace: this.key_backspace,
      Enter: this.key_enter,
      ArrowUp: this.key_arrow_up,
      ArrowDown: this.key_arrow_down,
      ArrowLeft: this.key_arrow_left,
      ArrowRight: this.key_arrow_right,
      Home: this.key_home,
      End: this.key_end,
      Insert: this.key_insert,
    };
  }

  exec(key, e) {
    let s = false;
    let c = false;
    let m = false;
    let a = false;

    if (e != undefined) {
      s = e.shiftKey;
      c = e.ctrlKey;
      m = e.metaKey;
      a = e.altKey;
    }
    if (this.func[key.action]) {
      console.log(`Executing action: ${key.action} (${key.description})`);
      this.func[key.action].call(this, s, c, m, a);
    } else if (this.func[key.key]) {
      console.log(`Executing action: ${key.key}`);
      this.func[key.key].call(this, s, c, m, a);
    }
  }

  // --- Control functions ---

  control_save(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    if (s) {
      this.editor.tabManager.activeFile.selectFileToSave();
      this.editor.tabManager.activeFile.save();
    } else {
      this.editor.tabManager.activeFile.save();
    }
  }

  async control_open_file(s, c, m, a) {
    const file = await this.editor.tabManager.selectFiles();
    this.editor.tabManager.openFiles(file);
  }

  async control_open_folder(s, c, m, a) {
    await this.editor.fileExplorer.selectFolder();
    this.editor.sidebarManager.openMenu("file-explorer");
  }

  control_new_file(s, c, m, a) {
    this.editor.tabManager.createEmptyFile();
  }

  control_close_file(s, c, m, a) {
    if (this.editor.tabManager.files.length != 0)
      this.editor.tabManager.closeActiveFile();
    else this.editor.api.quit();
  }

  control_close_all_file(s, c, m, a) {
    this.editor.tabManager.closeFiles();
  }

  async control_copy(s, c, m, a) {
    if (!document.hasFocus()) return;
    if (!this.editor.tabManager.activeFile) return;

    let txt = this.editor.selectController.containsSelected;

    if (!txt) {
      const lineNode =
        this.editor.lineController.lines[this.editor.cursorController.row - 1];
      txt = lineNode ? lineNode.getText() : "";
    }
    try {
      await navigator.clipboard.writeText(txt);
    } catch (err) {
      console.error("Erreur lors de la copie : ", err);
    }
  }

  async control_paste(s, c, m, a) {
    if (!document.hasFocus()) return;
    if (!this.editor.tabManager.activeFile) return;
    try {
      const text = await navigator.clipboard.readText();
      const handled = this.editor.smartTypingController?.handlePaste(text);
      if (!handled) this.editor.writerController.write(text);
    } catch (err) {
      console.error("Erreur lors du collage : ", err);
    }
  }

  async control_cut(s, c, m, a) {
    if (!document.hasFocus()) return;
    if (!this.editor.tabManager.activeFile) return;

    let hasSelection = this.editor.selectController.containsSelected;
    await this.control_copy();

    if (hasSelection) {
      this.key_backspace();
    } else {
      if (
        this.editor.lineController.lines.length !=
        this.editor.cursorController.row
      )
        this.editor.lineController.supLine(
          this.editor.cursorController.row - 1,
        );
      else
        this.editor.lineController.changeLine(
          "",
          this.editor.cursorController.row - 1,
        );

      this.editor.lineController.refresh();
      this.editor.cursorController.setCursorPosition(
        this.editor.cursorController.row,
        0,
      );
    }
  }

  control_undo(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;

    if (this.editor.historyController) {
      this.editor.selectController.unSelectAll();
      this.editor.lineController.markDirtyAll();
      this.editor.events.callEvent(Events.ON_CHANGE, {
        action: "undo",
        text: "",
        beforeRow: 0,
        beforeColumn: 0,
        afterRow: 0,
        afterColumn: 0,
      });
    }
  }

  control_redo(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;

    if (this.editor.historyController) {
      this.editor.selectController.unSelectAll();
      this.editor.lineController.markDirtyAll();
      this.editor.events.callEvent(Events.ON_CHANGE, {
        action: "redo",
        text: "",
        beforeRow: 0,
        beforeColumn: 0,
        afterRow: 0,
        afterColumn: 0,
      });
    }
  }

  control_find(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;

    this.editor.searchController.toggle();
  }
  control_replace(s, c, m, a) {}

  control_open_command(s, c, m, a) {
    if (this.editor.panel instanceof CMD) this.editor.panel.close();
    else this.editor.Ccmd.open();
  }

  control_delete_line(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    if (this.editor.lineController.lines.length == 0) return;

    this.editor.lineController.supLine(this.editor.cursorController.row - 1);
    this.editor.lineController.refresh();
    this.editor.cursorController.setCursorPosition(
      this.editor.cursorController.row,
      this.editor.cursorController.column,
    );
  }

  control_select_all(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    if (this.editor.lineController.lines.length == 0) return;

    this.editor.selectController.selectAll(true);
  }

  control_toggle_file_explorer(s, c, m, a) {
    if (this.editor.sidebarManager) {
      this.editor.sidebarManager.toggleMenu("file-explorer");
    }
  }

  control_toggle_search(s, c, m, a) {
    if (this.editor.sidebarManager) {
      this.editor.sidebarManager.toggleMenu("search");
    }
  }

  control_toggle_agent(s, c, m, a) {
    if (this.editor.sidebarManager) {
      this.editor.sidebarManager.toggleMenu("agent");
    }
  }

  // --- Key functions ---

  key_escape(s, c, m, a) {
    const openAgentSelectors = document.querySelectorAll(
      ".agent-sidebar-model-menu:not(.hidden)",
    );
    if (openAgentSelectors.length > 0) {
      openAgentSelectors.forEach((menu) => menu.classList.add("hidden"));
      return;
    }

    if (this.editor.searchController.isOpen) {
      this.editor.searchController.close();
      return;
    }

    if (this.editor.panel !== undefined) {
      this.editor.panel.close();
      return;
    }

    this.editor.selectController.unSelectAll();
  }

  key_tab(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    if (
      this.editor.smartTypingController?.handleTab(s, {
        ctrlKey: c,
        metaKey: m,
        altKey: a,
      })
    ) {
      return;
    }

    this.editor.writerController.write(" ".repeat(CONFIG_GET("tab_width")));
  }

  key_delete(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    if (this.editor.lineController.lines.length == 0) return;
    if (m || a) return;

    this.editor.tabManager.activeFile.historyX = undefined;
    const lc = this.editor.lineController;
    let x = this.editor.cursorController.column;
    let y = this.editor.cursorController.row;

    let cursor;

    if (this.editor.selectController.containsSelected) {
      cursor = this.editor.writerController.deleteSelection();
    } else {
      const lineNode = lc.lines[y - 1];
      const l = lineNode ? lineNode.getText() : "";

      let start, end;
      if (x < l.length) {
        start = { row: y, column: x };
        end = { row: y, column: x + 1 };
      } else if (y < lc.lines.length) {
        start = { row: y, column: x };
        end = { row: y + 1, column: 0 };
      } else {
        return;
      }

      cursor = this.editor.writerController.deleteRange(start, end);
    }

    if (cursor) {
      lc.refresh();
      this.editor.cursorController.setCursorPosition(cursor.row, cursor.column);
    }
  }

  key_backspace(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    if (this.editor.lineController.lines.length == 0) return;
    if (m || a) return;

    this.editor.tabManager.activeFile.historyX = undefined;
    const lc = this.editor.lineController;
    let x = this.editor.cursorController.column;
    let y = this.editor.cursorController.row;

    let cursor;

    if (this.editor.selectController.containsSelected) {
      cursor = this.editor.writerController.deleteSelection();
    } else {
      if (
        !c &&
        this.editor.smartTypingController?.handleBackspace({
          ctrlKey: c,
          metaKey: m,
          altKey: a,
        })
      ) {
        return;
      }

      if (c) {
        if (x == 0 && y == 1) return;
        cursor = this.editor.writerController.deleteWord
          ? this.editor.writerController.deleteWord(x, y)
          : null;
      } else {
        if (x == 0 && y == 1) return;

        let start, end;
        if (x > 0) {
          start = { row: y, column: x - 1 };
          end = { row: y, column: x };
        } else {
          const prevLineNode = lc.lines[y - 2];
          const prevLen = prevLineNode ? prevLineNode.getText().length : 0;
          start = { row: y - 1, column: prevLen };
          end = { row: y, column: 0 };
        }

        cursor = this.editor.writerController.deleteRange(start, end);
      }
    }

    if (cursor) {
      lc.refresh();
      const screenRow = lc.getDisplayIndexForCursor(cursor.row) - lc.startIndex;
      if (screenRow <= lc.marginLines) {
        const targetRow = Math.max(0, lc.startIndex - 1);
        lc.scrollTo(targetRow);
      }
      this.editor.cursorController.setCursorPosition(cursor.row, cursor.column);
    }
  }

  key_enter(s, c, m, a) {
    if (
      this.editor.smartTypingController?.handleEnter({
        ctrlKey: c,
        metaKey: m,
        altKey: a,
      })
    ) {
      return;
    }

    this.editor.writerController.write("\n");
  }

  key_arrow_up(s, c, m, a) {
    if (this.editor.tabManager.activeFile) {
      if (this.editor.lineController.lines.length == 0) return;
      let x = this.editor.cursorController.column;
      let y = this.editor.cursorController.row;

      if (s) {
        if (!this.editor.selectController.containsSelected) {
          this.editor.selectController.startSelect = {
            column: x,
            row: y,
          };
        }
        this.editor.selectController.isMouseDown = true;
      } else if (this.editor.selectController.containsSelected) {
        this.editor.selectController.unSelectAll();
      }

      if (this.editor.tabManager.activeFile.historyX == undefined)
        this.editor.tabManager.activeFile.historyX = x;

      if (y == 1) {
        if (this.editor.tabManager.activeFile.historyX != 0)
          this.editor.tabManager.activeFile.historyX = 0;
        else {
          this.editor.selectController.isMouseDown = false;
          return;
        }
      } else y -= 1;

      this.editor.cursorController.setCursorPosition(
        y,
        this.editor.tabManager.activeFile.historyX,
      );

      const lc = this.editor.lineController;
      const screenRow = lc.getDisplayIndexForCursor(y) - lc.startIndex;
      if (screenRow <= lc.marginLines) {
        const targetRow = Math.max(0, lc.startIndex - 1);
        lc.scrollTo(targetRow);
      }

      if (s) {
        this.editor.selectController.move();
        this.editor.selectController.isMouseDown = false;
      }
    }
  }

  key_arrow_down(s, c, m, a) {
    if (this.editor.tabManager.activeFile) {
      if (this.editor.lineController.lines.length == 0) return;
      let x = this.editor.cursorController.column;
      let y = this.editor.cursorController.row;

      if (s) {
        if (!this.editor.selectController.containsSelected) {
          this.editor.selectController.startSelect = {
            column: x,
            row: y,
          };
        }
        this.editor.selectController.isMouseDown = true;
      } else if (this.editor.selectController.containsSelected) {
        this.editor.selectController.unSelectAll();
      }

      if (this.editor.tabManager.activeFile.historyX == undefined)
        this.editor.tabManager.activeFile.historyX = x;

      if (y == this.editor.lineController.lines.length) {
        const lineNode = this.editor.lineController.lines[y - 1];
        const lineLength = lineNode ? lineNode.getText().length : 0;
        if (this.editor.tabManager.activeFile.historyX != lineLength)
          this.editor.tabManager.activeFile.historyX = lineLength;
        else {
          this.editor.selectController.isMouseDown = false;
          return;
        }
      } else y += 1;

      this.editor.cursorController.setCursorPosition(
        y,
        this.editor.tabManager.activeFile.historyX,
      );

      const lc = this.editor.lineController;
      const screenRow = lc.getDisplayIndexForCursor(y) - lc.startIndex;
      if (screenRow >= lc.maxLines - lc.marginLines) {
        const targetRow = lc.startIndex + 1;
        lc.scrollTo(targetRow);
      }

      if (s) {
        this.editor.selectController.move();
        this.editor.selectController.isMouseDown = false;
      }
    }
  }

  key_arrow_left(s, c, m, a) {
    const lc = this.editor.lineController;
    if (this.editor.tabManager.activeFile) {
      if (lc.lines.length == 0) return;
      this.editor.tabManager.activeFile.historyX = undefined;
      let x = this.editor.cursorController.column;
      let y = this.editor.cursorController.row;

      if (s) {
        if (!this.editor.selectController.containsSelected) {
          this.editor.selectController.startSelect = {
            column: x,
            row: y,
          };
        }
        this.editor.selectController.isMouseDown = true;
      } else if (this.editor.selectController.containsSelected) {
        this.editor.selectController.unSelectAll();
      }

      if (y == 1 && x == 0) return;

      if (a) {
        const lineNode = lc.lines[y - 1];
        const l = lineNode ? lineNode.getText() : "";
        const words = this.editor.writerController.splitWord(l);
        let count = 0;

        for (let i = 0; i < words.length; i++) {
          const word = words[i];
          if (x - (count + word.length) <= 0) {
            x = count;
            break;
          }
          count += word.length;
        }
      } else if (m) {
        this.key_home(s, c, m, a);
        return;
      } else {
        if (x == 0) {
          y -= 1;
          const prevLineNode = lc.lines[y - 1];
          x = prevLineNode ? prevLineNode.getText().length : 0;
        } else {
          x -= 1;
        }
      }

      this.editor.cursorController.setCursorPosition(y, x);

      const screenCol = x - lc.offsetX;
      if (screenCol < lc.marginChars) {
        const targetCol = Math.max(0, lc.offsetX - 1);
        lc.scrollTo(undefined, targetCol);
      }

      if (s) {
        this.editor.selectController.move();
        this.editor.selectController.isMouseDown = false;
      }
    }
  }

  key_arrow_right(s, c, m, a) {
    const lc = this.editor.lineController;
    if (this.editor.tabManager.activeFile) {
      if (lc.lines.length == 0) return;
      this.editor.tabManager.activeFile.historyX = undefined;
      let x = this.editor.cursorController.column;
      let y = this.editor.cursorController.row;

      if (s) {
        if (!this.editor.selectController.containsSelected) {
          this.editor.selectController.startSelect = {
            column: x,
            row: y,
          };
        }
        this.editor.selectController.isMouseDown = true;
      } else if (this.editor.selectController.containsSelected) {
        this.editor.selectController.unSelectAll();
      }

      const lineNode = lc.lines[y - 1];
      const lineLength = lineNode ? lineNode.getText().length : 0;

      if (y == lc.lines.length && x == lineLength) return;

      if (c || a) {
        const l = lineNode ? lineNode.getText() : "";
        const words = this.editor.writerController.splitWord(l);
        let count = 0;

        for (let i = 0; i < words.length; i++) {
          const word = words[i];
          count += word.length;
          if (x - count < 0) {
            x = count;
            break;
          }
        }
        if (x === lineLength && y < lc.lines.length) {
          y += 1;
          x = 0;
        }
      } else {
        if (x == lineLength) {
          y += 1;
          x = 0;
        } else {
          x += 1;
        }
      }

      this.editor.cursorController.setCursorPosition(y, x);

      const screenCol = x - lc.offsetX;
      if (screenCol >= lc.maxCharacters - lc.marginChars) {
        const targetCol = lc.offsetX + 1;
        lc.scrollTo(undefined, targetCol);
      }

      if (s) {
        this.editor.selectController.move();
        this.editor.selectController.isMouseDown = false;
      }
    }
  }

  key_home(s, c, m, a) {
    if (this.editor.lineController.lines.length == 0) return;
    if (
      this.editor.smartTypingController?.handleHome(s, {
        ctrlKey: c,
        metaKey: m,
        altKey: a,
      })
    ) {
      return;
    }
    let y = this.editor.cursorController.row;
    this.editor.cursorController.setCursorPosition(y, 0);
  }

  key_end(s, c, m, a) {
    if (this.editor.lineController.lines.length == 0) return;
    let y = this.editor.cursorController.row;
    const lineNode =
      this.editor.lineController.lines[this.editor.cursorController.row - 1];
    let x = lineNode ? lineNode.getText().length : 0;
    this.editor.cursorController.setCursorPosition(y, x);
  }

  key_insert(s, c, m, a) {
    let wc = this.editor.writerController;
    wc.insertMode = !wc.insertMode;
  }
}
