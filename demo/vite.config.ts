import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { validateBase } from './scripts/base-path.mjs';

export default defineConfig({
  root: import.meta.dirname,
  base: validateBase(process.env.DEMO_BASE ?? '/'),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1600 },
});
