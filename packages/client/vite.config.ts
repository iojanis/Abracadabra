import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "examples",
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "examples/index.html"),
      },
    },
  },
});
