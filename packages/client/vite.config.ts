import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'examples',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'examples/index.html'),
      },
    },
  },
});
