class EmptyMenu {
  constructor(e) {
    this.editor = e;
    this.actions = ["new_file", "open_file", "open_folder", "find_file"];

    this.emptyMenuOBJ = document.querySelector(".empty-menu");

    this.refresh();
  }

  parseKeyToIcons(keyString) {
    const parts = keyString.split("+");
    const icons = [];

    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed === "Meta") {
        icons.push('<i class="fi fi-rr-command"></i>');
      } else if (trimmed === "Ctrl") {
        icons.push('<i class="fi fi-rr-control"></i>');
      } else if (trimmed === "Shift") {
        icons.push('<i class="fi fi-rr-arrow-up"></i>');
      } else if (trimmed === "Alt") {
        icons.push('<i class="fi fi-rr-option"></i>');
      } else {
        icons.push(trimmed);
      }
    }

    return icons;
  }

  refresh() {
    const emptyMenu = document.querySelector(".empty-menu");
    if (!emptyMenu) return;

    emptyMenu.innerHTML = "";

    const logo = document.createElement("img");
    logo.src = "../../assets/logo/NCE/dark-logo.png";
    logo.className = "empty-menu-logo";
    logo.alt = "NCE Logo";
    emptyMenu.appendChild(logo);

    for (const action of this.actions) {
      const keybinding = CONFIG_KEYBINDING_GET_ACTION(action);
      if (!keybinding) continue;

      const button = document.createElement("button");
      button.onclick = () => this.editor.keyBinding.exec(keybinding);

      const buttonText = document.createElement("span");
      buttonText.className = "button-text";
      buttonText.textContent = keybinding.description;

      const keybindingDiv = document.createElement("div");
      keybindingDiv.className = "keybinding";

      const keyIcons = this.parseKeyToIcons(keybinding.key);
      for (const icon of keyIcons) {
        const keySpan = document.createElement("span");
        keySpan.className = "key";
        keySpan.innerHTML = icon;
        keybindingDiv.appendChild(keySpan);
      }

      button.appendChild(buttonText);
      button.appendChild(keybindingDiv);
      emptyMenu.appendChild(button);
    }
  }

  hide() {
    this.emptyMenuOBJ.style.display = "none";
  }

  show() {
    this.emptyMenuOBJ.style.display = "flex";
  }
}
