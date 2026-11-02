import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = 'http://localhost:3000';

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ['/api', '/mcp', '/oauth', '/.well-known', '/authorize', '/token', '/register', '/revoke', '/healthz'].map((p) => [p, api]),
    ),
  },
});
