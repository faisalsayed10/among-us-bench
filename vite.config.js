import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  // Multi-page: / is the game, /results/ is the leaderboard.
  build: {
    target: 'es2022',  // top-level await
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        results: resolve(__dirname, 'results/index.html'),
      },
    },
  },
});
