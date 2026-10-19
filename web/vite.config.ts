import { defineConfig } from 'vite';

// GitHub Pages project site: https://<user>.github.io/crucible-optimizer/
export default defineConfig({
  root: import.meta.dirname,
  base: process.env.CRUCIBLE_BASE ?? '/crucible-optimizer/',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
});
