import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {fileURLToPath, URL} from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {alias: {'@': fileURLToPath(new URL('.', import.meta.url))}},
  define: {'process.env.NODE_ENV': JSON.stringify('production')},
  build: {
    outDir: 'studio/ui-build', emptyOutDir: true,
    lib: {entry: 'studio/react/entry.tsx', name: 'WebsiteOSUI', formats: ['iife'], fileName: () => 'ui.js', cssFileName: 'ui'},
  },
});
