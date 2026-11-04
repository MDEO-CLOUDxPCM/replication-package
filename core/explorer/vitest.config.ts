import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // the dependency cache always in node_modules/.vite (a run whose root resolved without the package wrote ./.vite)
  cacheDir: path.resolve(__dirname, 'node_modules/.vite'),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'web/src'),
      '@contract': path.resolve(__dirname, 'contract'),
      '@layout': path.resolve(__dirname, 'layout'),
    },
  },
  // the case packets' own tests live with their cases (cases/<case>/explorer-packet/tests)
  test: { dir: '../..', include: ['core/explorer/tests/**/*.test.ts', 'cases/*/explorer-packet/**/*.test.ts'], exclude: ['**/node_modules/**', 'build/**'], environment: 'node', testTimeout: 30000 },
});
