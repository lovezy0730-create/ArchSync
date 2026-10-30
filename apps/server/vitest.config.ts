import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // node:sqlite is an experimental built-in not in vite's core module list;
    // mark it external so vitest delegates it to Node instead of resolving
    // it as an npm package.
    server: {
      deps: {
        external: [/^node:sqlite$/],
      },
    },
  },
});
