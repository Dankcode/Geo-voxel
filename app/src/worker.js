// Generation runs off the main thread: the town engine takes 1–10 s for a map.
import { generate, GENERATORS } from '../../src/town.js';
import { tactics } from '../../src/plugins/tactics.js';

self.onmessage = ({ data: job }) => {
    if (job.type === 'catalog') { self.postMessage({ type: 'catalog', generators: GENERATORS }); return; }
    try {
        const r = generate({ generator: job.generator, theme: job.theme, seed: job.seed, params: job.params || {}, geo: job.geo || null, plugins: job.tactics ? [tactics()] : [] });
        const { grid, ...rest } = r;
        const data = grid.data;
        self.postMessage({ id: job.id, ok: true, result: { ...rest, grid: { width: grid.width, depth: grid.depth, height: grid.height, data, palette: grid.palette } } }, [data.buffer]);
    } catch (e) {
        self.postMessage({ id: job.id, ok: false, error: e.message, stack: e.stack });
    }
};
