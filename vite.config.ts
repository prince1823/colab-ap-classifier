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
    // Output renderer into its own subdirectory so we can safely clean it
    // without wiping dist/main/ or dist/preload/ produced by tsc.
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
