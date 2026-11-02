import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  envDir: '../..',
  // Relative Pfade, damit die App unter https://<user>.github.io/<repo>/ funktioniert.
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: { port: 5173 },
  preview: { port: 4173 },
});
