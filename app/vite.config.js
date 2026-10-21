import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The app imports the library (../src) and the town engine (../engine) directly; examples/ are served as-is.
export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    base: './',
    server: { port: 5180, fs: { allow: ['..'] } },
    worker: { format: 'es' },
    build: { outDir: '../dist-app', emptyOutDir: true, target: 'es2022' }
});
