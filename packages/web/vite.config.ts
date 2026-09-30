import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@ai-harness/core': path.resolve(import.meta.dirname, '../core/src/index.ts'),
    },
  },
  server: {
    port: 3080,
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3099',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
