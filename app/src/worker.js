// Building runs off the main thread: straightening and the town engine take 2–10 s for a real place.
import { generate } from '../../src/town.js';
import { tactics } from '../../src/plugins/tactics.js';

self.onmessage = ({ data: job }) => {
    try {
        const r = generate({ generator: 'place', geo: job.geo, seed: job.seed, params: job.params || {}, plugins: job.tactics ? [tactics()] : [] });
        const { grid, ...rest } = r, data = grid.data;
        self.postMessage({ id: job.id, ok: true, result: { ...rest, grid: { width: grid.width, depth: grid.depth, height: grid.height, data, palette: grid.palette } } }, [data.buffer]);
    } catch (e) {
        self.postMessage({ id: job.id, ok: false, error: e.message, stack: e.stack });
    }
};
