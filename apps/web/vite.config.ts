import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.ARCHSYNC_API ?? 'http://127.0.0.1:4310';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/healthz': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
