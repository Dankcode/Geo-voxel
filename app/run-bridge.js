// Run bridge (2026-11-12): lets the house viewer start a generation request on this computer when it is served by
// `npm run app`, instead of showing a command to copy. The viewer posts the request (the same fields its Regenerate
// and Request generation panels collect); this plugin checks every field, builds the run_request.py argument list
// itself (no shell) and runs it with the Python that has FreeCAD, one request at a time, with --open-in-freecad so the
// model opens in a running FreeCAD when its MCP add-on's RPC server is on (architecture/pipeline/freecad_link.py).
//
//   GET  /api/run/status   → { ok, token, python, freecad: { rpc }, job }   (same-origin only)
//   POST /api/run          → { id }   body: a request; header X-Run-Token from status
//   GET  /api/run/job      → { id, state: running|done|failed, log, result }
//
// Python: GEO_VOXEL_PYTHON if set, else $CONDA_PREFIX/bin/python (an activated environment), else
// `micromamba run -n houses python` (architecture/environment.yml), else python3.
// Only this computer can reach it (Vite listens on localhost); a request from another site is refused: it cannot read
// the token, and the Origin must be this server's.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';

const STYLE = /^[a-z_]{1,40}$/, ID = /^[A-Za-z0-9_\-]{1,80}$/, KEY = /^[A-Za-z0-9_\-~.]{1,120}$/, ROOMS_KEYS = /^(\d|garage)$/;
const ROOM_KINDS = /^[a-z_]{1,24}$/;
const int = (v, lo, hi) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`bad number ${v}`); return n; };
const num = (v, lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`bad number ${v}`); return n; };
const pick = (re, v, what) => { if (typeof v !== 'string' || !re.test(v)) throw new Error(`bad ${what}`); return v; };

/** The run_request.py arguments for a viewer request, every field checked. */
export function argsFor(req) {
    const a = [];
    if (req.type === 'area') {
        const [lat, lon] = req.center || [];
        a.push('--lat', String(num(lat, -90, 90)), '--lon', String(num(lon, -180, 180)), '--blocks', String(num(req.blocks, 1, 2)),
            '--style', req.style ? pick(STYLE, req.style, 'style') : 'auto');
        if (req.styles && Object.keys(req.styles).length) {
            const st = {};
            for (const [k, v] of Object.entries(req.styles)) st[pick(/^\d{1,15}$/, k, 'osm id')] = pick(STYLE, v, 'style');
            a.push('--styles', JSON.stringify(st));
        }
    } else if (req.type === 'regenerate') {
        a.push('--regenerate', pick(ID, req.area, 'area'), pick(KEY, req.key, 'key'));
        if (req.storeys != null) a.push('--storeys', String(int(req.storeys, 1, 2)));
        if (req.rooms && Object.keys(req.rooms).length) {
            const rooms = {};
            for (const [k, v] of Object.entries(req.rooms)) {
                pick(ROOMS_KEYS, k, 'floor');
                if (k === 'garage') { rooms.garage = int(v, 0, 2); continue; }
                rooms[k] = {};
                for (const [kind, n] of Object.entries(v || {})) rooms[k][pick(ROOM_KINDS, kind, 'room')] = int(n, 0, 8);
            }
            a.push('--rooms', JSON.stringify(rooms));
        }
        if (req.style) a.push('--style', pick(STYLE, req.style, 'style'));
        if (req.seed != null) a.push('--seed', String(int(req.seed, 1, 9999)));
    } else if (req.type === 'highrise') {
        a.push('--highrise', pick(ID, req.design, 'design'), '--storeys', String(int(req.storeys, 7, 40)),
            '--dwellings', String(int(req.dwellings, 2, 6)), '--gfa', String(int(req.gfa, 60, 200)));
        if (req.bedrooms != null) a.push('--bedrooms', String(int(req.bedrooms, 1, 5)));
        if (req.bathrooms != null) a.push('--bathrooms', String(int(req.bathrooms, 1, 3)));
        if (req.style && req.style !== 'plain') a.push('--style', pick(STYLE, req.style, 'style'));
        if (req.seed != null) a.push('--seed', String(int(req.seed, 1, 9999)));
    } else if (req.type === 'restyle') {
        a.push('--restyle', pick(ID, req.area, 'area'), pick(KEY, req.key, 'key'), pick(STYLE, req.style, 'style'));
    } else throw new Error('unknown request type');
    return a;
}

function findPython() {
    if (process.env.GEO_VOXEL_PYTHON) return { cmd: process.env.GEO_VOXEL_PYTHON, pre: [], label: process.env.GEO_VOXEL_PYTHON };
    const cp = process.env.CONDA_PREFIX && join(process.env.CONDA_PREFIX, 'bin', 'python');
    if (cp && existsSync(cp)) return { cmd: cp, pre: [], label: cp };
    if (spawnSync('micromamba', ['--version'], { stdio: 'ignore' }).status === 0)
        return { cmd: 'micromamba', pre: ['run', '-n', 'houses', 'python'], label: 'micromamba run -n houses python' };
    return { cmd: 'python3', pre: [], label: 'python3' };
}

function freecadPing(timeout = 800) {
    const body = '<?xml version="1.0"?><methodCall><methodName>ping</methodName><params/></methodCall>';
    return new Promise(res => {
        const r = httpRequest({ host: process.env.FREECAD_RPC_HOST || 'localhost', port: +(process.env.FREECAD_RPC_PORT || 9875), path: '/RPC2',
            method: 'POST', headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body) }, timeout },
            resp => { let t = ''; resp.on('data', d => { t += d; }); resp.on('end', () => res(/<boolean>1<\/boolean>/.test(t))); });
        r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); });
        r.end(body);
    });
}

export default function runBridge() {
    const repo = resolve(new URL('..', import.meta.url).pathname);
    const script = join(repo, 'architecture', 'pipeline', 'run_request.py');
    const token = randomBytes(18).toString('hex');
    let py = null, job = null, seq = 0;
    const send = (res, code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };
    // this computer only: the Host must be localhost (no DNS rebinding) and any Origin must be this server's
    const sameOrigin = req => {
        const h = req.headers.host || '', o = req.headers.origin;
        if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(h)) return false;
        return !o || o === `http://${h}`;
    };
    const jobView = () => job && { id: job.id, state: job.state, log: job.log.slice(-12000), result: job.result, args: job.args, started: job.started, ended: job.ended };
    return {
        name: 'geo-voxel-run-bridge',
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                const url = (req.url || '').split('?')[0];
                if (!url.startsWith('/api/run')) return next();
                if (!sameOrigin(req)) return send(res, 403, { error: 'other origin' });
                try {
                    if (req.method === 'GET' && url === '/api/run/status') {
                        py ??= findPython();
                        return send(res, 200, { ok: true, token, python: py.label, freecad: { rpc: await freecadPing() }, job: jobView() });
                    }
                    if (req.method === 'GET' && url === '/api/run/job') return send(res, 200, jobView() || { state: 'none' });
                    if (req.method === 'POST' && url === '/api/run') {
                        if (req.headers['x-run-token'] !== token) return send(res, 403, { error: 'bad token' });
                        if (!/application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'json only' });
                        if (job?.state === 'running') return send(res, 409, { error: 'a request is already running', job: jobView() });
                        let raw = '';
                        for await (const c of req) { raw += c; if (raw.length > 20000) return send(res, 413, { error: 'too large' }); }
                        const body = JSON.parse(raw);
                        const args = argsFor(body.request || {});
                        if (body.openInFreecad !== false) args.push('--open-in-freecad');
                        py ??= findPython();
                        const argv = [...py.pre, script, ...args];
                        job = { id: ++seq, state: 'running', log: '', result: null, args, started: Date.now(), ended: null };
                        const me = job;
                        const p = spawn(py.cmd, argv, { cwd: repo, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
                        const take = d => {
                            me.log += d.toString();
                            const m = me.log.match(/^RESULT (\{.*\})$/m);
                            if (m) { try { me.result = JSON.parse(m[1]); } catch { } }
                            if (me.log.length > 400000) me.log = me.log.slice(-200000);
                        };
                        p.stdout.on('data', take); p.stderr.on('data', take);
                        p.on('error', e => { me.log += `\n${e.message}\n`; me.state = 'failed'; me.ended = Date.now(); });
                        p.on('close', code => { if (me.state === 'running') { me.state = code === 0 ? 'done' : 'failed'; me.ended = Date.now(); } });
                        server.config.logger.info(`[run bridge] ${py.label} run_request.py ${args.join(' ')}`);
                        return send(res, 202, { id: job.id });
                    }
                    return send(res, 404, { error: 'not found' });
                } catch (e) {
                    return send(res, 400, { error: String(e.message || e) });
                }
            });
        }
    };
}
