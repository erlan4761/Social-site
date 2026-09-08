import { defineConfig } from 'vite';
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
      '/api': 'http://localhost:3001',
      '/uploads': 'http://localhost:3001',
    },
  },
}));
