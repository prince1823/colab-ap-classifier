import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
  root: './',
  publicDir: 'public',
  build: {
    // Don't wipe dist/ — tsc outputs main process + preload into dist/main/
    emptyOutDir: false,
  },
  server: {
    port: 5173,
  },
});
