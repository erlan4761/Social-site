import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Витрина живёт в подкаталоге репозитория на GitHub Pages, поэтому в режиме
// demo все пути собираются относительно /Social-site/.
export default defineConfig(({ mode }) => ({
  base: mode === 'demo' ? '/Social-site/' : '/',
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in dev, so the session cookie just works.
    proxy: {
      '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:3001',
      '/uploads': process.env.API_PROXY_TARGET ?? 'http://localhost:3001',
    },
  },
  // Тесты интерфейса и витрины: jsdom вместо браузера, заглушки — в setup.
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
}));
