import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Separate cache for the browser test so it does not disturb a running dev server
  cacheDir: process.env['MWO_VITE_CACHE'] ?? undefined,
  server: {
    host: '127.0.0.1',
    port: 5173,
    // Do not silently switch to another port
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env['MWO_API_PORT'] ?? 4680}` },
  },
});
