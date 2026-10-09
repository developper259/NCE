import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import xtermStyles from "@xterm/xterm/css/xterm.css?inline";
import { TerminalPanel } from "./TerminalPanel.js";

if (!document.querySelector("style[data-nce-xterm]")) {
  const style = document.createElement("style");
  style.dataset.nceXterm = "true";
  style.textContent = xtermStyles;
  document.head.appendChild(style);
}

window.NCE_TERMINAL_RUNTIME = Object.freeze({
  createPanel: (editor) => new TerminalPanel(editor, Terminal, FitAddon, WebLinksAddon),
});
