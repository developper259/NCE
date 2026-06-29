class FileExplorer extends Sidebar {
  constructor() {
    super("file-explorer", "File Explorer", "fi fi-rr-folder");
    this.position = "left";
    this.files = [
      {
        name: "src",
        type: "folder",
        expanded: true,
        children: [
          { name: "index.html", type: "file" },
          { name: "main.js", type: "file" },
          { name: "styles.css", type: "file" },
          {
            name: "components",
            type: "folder",
            expanded: true,
            children: [
              { name: "Button.js", type: "file" },
              { name: "Header.js", type: "file" },
            ],
          },
        ],
      },
      {
        name: "assets",
        type: "folder",
        expanded: false,
        children: [
          { name: "logo.png", type: "file" },
          { name: "icon.svg", type: "file" },
        ],
      },
      { name: "README.md", type: "file" },
      { name: "package.json", type: "file" },
    ];
  }

  render() {
    const container = document.createElement("div");

    const header = document.createElement("div");
    header.className = "sidebar-menu-header";
    header.textContent = "Explorer";
    container.appendChild(header);

    this.renderFiles(this.files, 0, container);
    return container;
  }

  renderFiles(files, depth, container) {
    for (const file of files) {
      const padding = depth * 16;
      const fileItem = document.createElement("div");
      fileItem.className = "file-item";
      fileItem.dataset.path = file.name;
      fileItem.style.paddingLeft = `${padding}px`;

      if (file.type === "folder") {
        const icon = file.expanded ? "fi fi-rr-folder-open" : "fi fi-rr-folder";
        const iconElement = document.createElement("i");
        iconElement.className = `${icon} file-icon`;
        fileItem.appendChild(iconElement);

        const nameElement = document.createElement("span");
        nameElement.className = "file-name";
        nameElement.textContent = file.name;
        fileItem.appendChild(nameElement);

        container.appendChild(fileItem);

        if (file.expanded && file.children) {
          this.renderFiles(file.children, depth + 1, container);
        }
      } else {
        const icon = this.getFileIcon(file.name);
        const iconElement = document.createElement("i");
        iconElement.className = `${icon} file-icon`;
        fileItem.appendChild(iconElement);

        const nameElement = document.createElement("span");
        nameElement.className = "file-name";
        nameElement.textContent = file.name;
        fileItem.appendChild(nameElement);

        container.appendChild(fileItem);
      }
    }
  }

  getFileIcon(filename) {
    const ext = filename.split(".").pop().toLowerCase();
    const icons = {
      js: "fi fi-rr-js",
      html: "fi fi-rr-html5",
      css: "fi fi-rr-css3",
      json: "fi fi-rr-file-code",
      md: "fi fi-rr-markdown",
      png: "fi fi-rr-image",
      svg: "fi fi-rr-image",
      jpg: "fi fi-rr-image",
    };
    return icons[ext] || "fi fi-rr-file";
  }

  onOpen() {
    this.refresh();
  }

  toggleFolder(folderName) {
    const toggleFolder = (files) => {
      for (const file of files) {
        if (file.name === folderName && file.type === "folder") {
          file.expanded = !file.expanded;
          return true;
        }
        if (file.children && toggleFolder(file.children)) {
          return true;
        }
      }
      return false;
    };
    toggleFolder(this.files);
    this.refresh();
  }
}
