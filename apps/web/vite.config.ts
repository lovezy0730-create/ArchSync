import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.ARCHSYNC_API ?? 'http://127.0.0.1:4310';

/**
 * Two build modes:
 * - default (`vite dev` / `vite build`): local full mode, proxies /api + /ws
 *   to the Fastify server.
 * - `--mode pages` (`pnpm build:pages`): GitHub Pages static bundle served
 *   from the repository sub-path /ArchSync/ with build-time JSON snapshots;
 *   no server requests exist in that bundle at all.
 */
export default defineConfig(({ mode }) => {
  const pages = mode === 'pages';
  return {
    plugins: [react()],
    // GitHub Pages serves the site at https://<user>.github.io/ArchSync/
    base: pages ? '/ArchSync/' : '/',
    resolve: pages
      ? {
          // The static bundle must not reference /api endpoints at all
          // (verify:pages enforces it). Alias the registry API to a stub with
          // identical signatures; the real client is server-mode only.
          alias: [{ find: /registry-api(\.js)?$/, replacement: '/src/lib/registry-api-stub.ts' }],
        }
      : undefined,
    define: {
      'import.meta.env.VITE_ARCHSYNC_MODE': JSON.stringify(pages ? 'static' : 'server'),
    },
    server: pages
      ? { port: 4174 }
      : {
          port: 5173,
          proxy: {
            '/api': { target: API_TARGET, changeOrigin: true },
            '/healthz': { target: API_TARGET, changeOrigin: true },
            '/ws': { target: API_TARGET, ws: true, changeOrigin: true },
          },
        },
    build: { outDir: 'dist', sourcemap: false },
  };
});
