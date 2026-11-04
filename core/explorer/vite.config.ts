import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PORT = Number(process.env.EXPLORER_API_PORT ?? 5181);

export default defineConfig({
  root: path.resolve(__dirname, 'web'),
  // the dependency cache always in node_modules/.vite (a run whose root resolved without the package wrote ./.vite)
  cacheDir: path.resolve(__dirname, 'node_modules/.vite'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'web/src'),
      '@contract': path.resolve(__dirname, 'contract'),
      '@layout': path.resolve(__dirname, 'layout'),
    },
  },
  server: {
    port: Number(process.env.EXPLORER_WEB_PORT ?? 5180),
    strictPort: true,
    proxy: { '/api': `http://localhost:${API_PORT}` },
  },
  // orthoflow (TALA, WebAssembly) is loaded in the layout worker; keep it out of dependency pre-bundling
  optimizeDeps: { exclude: ['orthoflow'] },
  worker: { format: 'es' },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
});
