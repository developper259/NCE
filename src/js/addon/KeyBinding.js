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

  // Control functions
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
    //this.editor.api.quit();
    this.editor.tabManager.closeFiles();
  }
  async control_copy(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;

    let txt = this.editor.selectController.containsSelected;

    if (!txt) {
      txt = this.editor.lineController.lines[this.editor.cursor.row - 1];
    }
    try {
      await navigator.clipboard.writeText(txt);
    } catch (err) {
      console.error("Erreur lors de la copie : ", err);
    }
  }

  async control_paste(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    try {
      const text = await navigator.clipboard.readText();
      this.editor.writerController.write(text);
    } catch (err) {
      console.error("Erreur lors du collage : ", err);
    }
  }

  async control_cut(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;

    let txt = this.editor.selectController.containsSelected;
    this.control_copy();
    if (txt) this.key_backspace();
    else {
      if (this.editor.lineController.lines.length != this.editor.cursor.row)
        this.editor.lineController.supLine(this.editor.cursor.row - 1);
      else
        this.editor.lineController.changeLine("", this.editor.cursor.row - 1);

      this.editor.lineController.refresh();
      this.editor.cursor.setCursorPosition(this.editor.cursor.row, 0);
    }
  }
  control_undo(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;

    if (this.editor.historyController) {
      //const result = this.editor.historyController.undo();

      this.editor.selectController.unSelectAll();
      this.editor.lineController.markDirtyAll();
      this.editor.events.callEvent(Events.ON_CHANGE, {
        action: "undo",
        text: result?.text || "",
        beforeRow: result?.start?.row || 0,
        beforeColumn: result?.start?.column || 0,
        afterRow: result?.start?.row || 0,
        afterColumn: result?.start?.column || 0,
      });
    }
  }

  control_redo(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;

    if (this.editor.historyController) {
      //const result = this.editor.historyController.redo();

      this.editor.selectController.unSelectAll();
      this.editor.lineController.markDirtyAll();
      this.editor.events.callEvent(Events.ON_CHANGE, {
        action: "redo",
        text: result?.text || "",
        beforeRow: result?.end?.row || 0,
        beforeColumn: result?.end?.column || 0,
        afterRow: result?.end?.row || 0,
        afterColumn: result?.end?.column || 0,
      });
    }
  }

  control_find(s, c, m, a) {}
  control_replace(s, c, m, a) {}
  control_open_command(s, c, m, a) {
    if (this.editor.panel instanceof CMD) this.editor.panel.close();
    else this.editor.Ccmd.open();
  }
  control_delete_line(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    if (this.editor.lineController.lines.length == 0) return;

    this.editor.lineController.supLine(this.editor.cursor.row - 1);
    this.editor.lineController.refresh();
    this.editor.cursor.setCursorPosition(
      this.editor.cursor.row,
      this.editor.cursor.column,
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

  // Key functions
  key_escape(s, c, m, a) {
    if (this.editor.panel == undefined) return;
    else this.editor.panel.close();
  }
  key_tab(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    this.editor.writerController.write("\t");
  }
  key_delete(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    if (this.editor.lineController.lines.length == 0) return;
    if (m || a) return;
    this.editor.tabManager.activeFile.historyX = undefined;
    const pos = this.editor.cursor.getCursorReelPosition();
    if (!pos) return;
    let x = pos.column;
    let y = pos.row;

    let cursor;

    if (!this.editor.selectController.containsSelected) {
      let newLine = "";
      const l = this.editor.lineController.lines[y - 1];
      if (x == 0 && this.editor.lineController.lines[y - 1].length == 0) {
        y -= 1;
        x = this.editor.lineController.lines[y].length;
        newLine = l + this.editor.lineController.lines[y];
        this.editor.lineController.supLine(y);
        cursor = pos;
      } else {
        x = x + 1;
        cursor = this.editor.writerController.delete(x, y);
      }
    } else {
      cursor = this.editor.writerController.deleteSelection();
    }

    this.editor.lineController.refresh();
    this.editor.cursor.setCursorPosition(cursor.row, cursor.column);
  }
  key_backspace(s, c, m, a) {
    if (!this.editor.tabManager.activeFile) return;
    if (this.editor.lineController.lines.length == 0) return;
    if (m || a) return;

    this.editor.tabManager.activeFile.historyX = undefined;
    const pos = this.editor.cursor.getCursorReelPosition();
    if (!pos) return;
    let x = pos.column;
    let y = pos.row;

    let cursor;
    const lc = this.editor.lineController;

    if (!this.editor.selectController.containsSelected) {
      let newLine = "";
      const l = lc.lines[y - 1];
      if (c) {
        if (s) {
          if (x == 0) {
            y -= 1;
            x = lc.lines[y - 1].length;
            newLine = lc.lines[y - 1] + l;
            lc.supLine(y);
          } else {
            newLine = lc.lines[y - 1].slice(x);
            x = 0;
          }
          lc.changeLine(newLine, y - 1);

          lc.refresh();
          this.editor.cursor.setCursorPosition(y, x);
          return;
        } else {
          if (x == 0 && y == 1) return;
          cursor = this.editor.writerController.deleteWord(x, y);
        }
      } else {
        if (x == 0 && y == 1) return;
        cursor = this.editor.writerController.delete(x, y);
      }
    } else {
      cursor = this.editor.writerController.deleteSelection();
    }

    const screenRow = y - lc.startIndex;

    if (screenRow <= lc.marginLines) {
      const targetRow = Math.max(0, lc.startIndex - 1);
      lc.scrollTo(targetRow);
    }
    this.editor.cursor.setCursorPosition(cursor.row, cursor.column);
  }

  key_enter(s, c, m, a) {
    this.editor.writerController.write("\n");
  }
  key_arrow_up(s, c, m, a) {
    if (this.editor.tabManager.activeFile) {
      if (this.editor.lineController.lines.length == 0) return;
      const pos = this.editor.cursor.getCursorReelPosition();
      if (!pos) return;
      let x = pos.column;
      let y = pos.row;

      if (s) {
        if (this.editor.selectController.containsSelected.length == 0) {
          this.editor.selectController.startSelect = {
            column: x,
            row: y,
          };
        }
        this.editor.selectController.isMouseDown = true;
      } else if (this.editor.selectController.containsSelected.length != 0) {
        this.editor.selectController.unSelectAll();
        return;
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

      this.editor.cursor.setCursorPosition(
        y,
        this.editor.tabManager.activeFile.historyX,
      );

      const lc = this.editor.lineController;
      const screenRow = y - lc.startIndex;
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
      const pos = this.editor.cursor.getCursorReelPosition();
      if (!pos) return;
      let x = pos.column;
      let y = pos.row;

      if (s) {
        if (this.editor.selectController.containsSelected.length == 0) {
          this.editor.selectController.startSelect = {
            column: x,
            row: y,
          };
        }
        this.editor.selectController.isMouseDown = true;
      } else if (this.editor.selectController.containsSelected.length != 0) {
        this.editor.selectController.unSelectAll();
        return;
      }

      if (this.editor.tabManager.activeFile.historyX == undefined)
        this.editor.tabManager.activeFile.historyX = x;

      if (y == this.editor.lineController.lines.length) {
        if (
          this.editor.tabManager.activeFile.historyX !=
          this.editor.lineController.lines[y - 1].length
        )
          this.editor.tabManager.activeFile.historyX =
            this.editor.lineController.lines[y - 1].length;
        else {
          this.editor.selectController.isMouseDown = false;
          return;
        }
      } else y += 1;

      this.editor.cursor.setCursorPosition(
        y,
        this.editor.tabManager.activeFile.historyX,
      );

      const lc = this.editor.lineController;
      const screenRow = y - lc.startIndex;
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
      if (lc.length == 0) return;
      this.editor.tabManager.activeFile.historyX = undefined;
      const pos = this.editor.cursor.getCursorReelPosition();
      if (!pos) return;
      let x = pos.column;
      let y = pos.row;

      if (s) {
        if (this.editor.selectController.containsSelected.length == 0) {
          this.editor.selectController.startSelect = {
            column: x,
            row: y,
          };
        }
        this.editor.selectController.isMouseDown = true;
      } else if (this.editor.selectController.containsSelected.length != 0) {
        this.editor.selectController.unSelectAll();
        return;
      }

      if (y == 1 && x == 0) return;

      if (a) {
        const l = lc.lines[y - 1];
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
          x = lc.lines[y - 1].length;
        } else {
          x -= 1;
        }
      }

      this.editor.cursor.setCursorPosition(y, x);

      const screenCol = x - lc.offsetX;
      if (screenCol < lc.marginChars) {
        const targetCol = lc.offsetX - 1;
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
      const pos = this.editor.cursor.getCursorReelPosition();
      if (!pos) return;
      let x = pos.column;
      let y = pos.row;

      if (s) {
        if (this.editor.selectController.containsSelected.length == 0) {
          this.editor.selectController.startSelect = {
            column: x,
            row: y,
          };
        }
        this.editor.selectController.isMouseDown = true;
      } else if (this.editor.selectController.containsSelected.length != 0) {
        this.editor.selectController.unSelectAll();
        return;
      }

      if (y == lc.lines.length && x == lc.lines[y - 1].length) return;

      if (c || a) {
        const l = this.editor.lineController.lines[y - 1];
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
      } else if (m) {
        this.key_end(s, c, m, a);
        return;
      } else {
        let length = this.editor.lineController.lines[y - 1].length;

        if (x == length) {
          y += 1;
          x = 0;
        } else {
          x += 1;
        }
      }

      this.editor.cursor.setCursorPosition(y, x);

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
    let y = this.editor.cursor.row;
    this.editor.cursor.setCursorPosition(y, 0);
  }
  key_end(s, c, m, a) {
    if (this.editor.lineController.lines.length == 0) return;
    let y = this.editor.cursor.row;
    let x = this.editor.lineController.lines[this.editor.cursor.row - 1].length;
    this.editor.cursor.setCursorPosition(y, x);
  }
  key_insert(s, c, m, a) {
    let wc = this.editor.writerController;
    wc.insertMode = !wc.insertMode;
  }
}
