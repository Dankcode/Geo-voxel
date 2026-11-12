import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import runBridge from './run-bridge.js';

// The app imports the library (../src) and the town engine (../engine) directly; examples/ are served as-is.
// runBridge: the house viewer's Regenerate / Request generation buttons run run_request.py on this computer and open
// the result in FreeCAD (app/run-bridge.js); only `npm run app` has it, a static copy of the viewer shows the command.
export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    base: './',
    server: { port: 5180, host: 'localhost', fs: { allow: ['..'] } },
    plugins: [runBridge()],
    worker: { format: 'es' },
    build: { outDir: '../dist-app', emptyOutDir: true, target: 'es2022' }
});
