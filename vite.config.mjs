import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import { rendererEntrypointPlugin } from "./scripts/renderer-entrypoint.mjs";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.join(projectRoot, "src");

export default defineConfig({
  root: sourceRoot,
  base: "./",
  plugins: [rendererEntrypointPlugin()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: path.join(projectRoot, "dist/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: path.join(sourceRoot, "html/index.html"),
        terminal: path.join(sourceRoot, "js/terminal/entry.js"),
      },
      output: {
        entryFileNames: (chunk) => chunk.name === "terminal"
          ? "js/terminal/entry.js"
          : "assets/[name]-[hash].js",
        chunkFileNames: "js/terminal/[name]-[hash].js",
      },
    },
  },
});
