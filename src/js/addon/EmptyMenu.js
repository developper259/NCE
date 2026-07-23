class EmptyMenu {
  constructor(e) {
    this.editor = e;
    this.actions = ["new_file", "open_file", "open_folder", "find_file"];

    this.refresh();
  }

  parseKeyToElements(keyString) {
    if (!keyString) return [];
    
    const parts = keyString.split("+");
    const elements = [];

    const modifierIcons = {
      "Meta": "fi fi-rr-command",
      "Ctrl": "fi fi-rr-control",
      "Shift": "fi fi-rr-arrow-up",
      "Alt": "fi fi-rr-option"
    };

    for (const part of parts) {
      const trimmed = part.trim();
      const iconClass = modifierIcons[trimmed];

      if (iconClass) {
        const i = document.createElement("i");
        i.className = iconClass;
        elements.push(i);
      } else {
        const span = document.createElement("span");
        span.className = "key-text";
        span.textContent = trimmed;
        elements.push(span);
      }
    }

    return elements;
  }

  refresh() {
    if (!this.editor.emptyMenuOBJ) return;

    const fragment = document.createDocumentFragment();

    const logo = document.createElement("img");
    logo.src = "../../assets/logo/NCE/dark-logo.png";
    logo.className = "empty-menu-logo";
    logo.alt = "NCE Logo";
    fragment.appendChild(logo);

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

      const keyElements = this.parseKeyToElements(keybinding.key);
      for (const element of keyElements) {
        const keySpan = document.createElement("span");
        keySpan.className = "key";
        keySpan.replaceChildren(element);
        keybindingDiv.appendChild(keySpan);
      }

      button.appendChild(buttonText);
      button.appendChild(keybindingDiv);
      fragment.appendChild(button);
    }

    this.editor.emptyMenuOBJ.replaceChildren(fragment);

  }

  hide() {
    this.editor.emptyMenuOBJ.style.display = "none";
  }

  show() {
    this.editor.emptyMenuOBJ.style.display = "flex";
  }
}
