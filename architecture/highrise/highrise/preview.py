"""Quick shaded previews of a .mesh.json (numpy z-buffer, no GPU): exterior view and a cut-away floor.

    python -m highrise.preview <model.mesh.json> <out.png> [--cut STOREY] [--az DEG] [--el DEG]
"""
import base64
import json
import math
import sys

import numpy as np
from PIL import Image


def load(path, cut=None, hide=("roof", "parapet", "tower")):
    M = json.load(open(path))
    tris, cols = [], []
    for g in M["mesh"]:
        if cut is not None and (g["storey"] > cut or g["role"] in hide):
            continue
        p = np.frombuffer(base64.b64decode(g["pos"]), np.float32).reshape(-1, 3)
        f = np.frombuffer(base64.b64decode(g["idx"]), np.uint32).reshape(-1, 3)
        t = p[f]
        if cut is not None:
            top = M["meta"]["raise"] + cut * M["meta"]["storey_h"] + 1.35
            keep = t[:, :, 1].min(axis=1) < top
            t = t[keep]
            t[:, :, 1] = np.minimum(t[:, :, 1], top)
        tris.append(t)
        c = np.array([int(g["color"][i:i + 2], 16) for i in (1, 3, 5)], np.float32) / 255
        a = 0.45 if g["role"] == "window" else 1.0
        cols.append(np.tile(np.r_[c, a], (len(t), 1)))
    return np.concatenate(tris), np.concatenate(cols), M["meta"]


def render(tris, cols, W=1600, H=1200, az=-35, el=28, bg=(0.92, 0.91, 0.87)):
    a, e = math.radians(az), math.radians(el)
    R = np.array([[math.cos(a), 0, -math.sin(a)], [0, 1, 0], [math.sin(a), 0, math.cos(a)]])
    E = np.array([[1, 0, 0], [0, math.cos(e), -math.sin(e)], [0, math.sin(e), math.cos(e)]])
    P = tris.reshape(-1, 3) - tris.reshape(-1, 3).mean(axis=0)
    P = (E @ (R @ P.T)).T.reshape(-1, 3, 3)
    n = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-9
    light = np.array([-0.4, 0.75, 0.55]); light /= np.linalg.norm(light)
    shade = 0.45 + 0.55 * np.abs(n @ light)
    xs, ys = P[:, :, 0], -P[:, :, 1]
    span = max(xs.max() - xs.min(), ys.max() - ys.min()) * 1.08
    sc = min(W, H) / span
    X = (xs - (xs.max() + xs.min()) / 2) * sc + W / 2
    Y = (ys - (ys.max() + ys.min()) / 2) * sc + H / 2
    Z = P[:, :, 2]
    img = np.ones((H, W, 3), np.float32) * np.array(bg, np.float32)
    zb = np.full((H, W), -np.inf, np.float32)   # camera on +z: larger z is nearer
    order = np.argsort(cols[:, 3])[::-1]          # opaque first, glass last
    for i in order:
        x, y, z = X[i], Y[i], Z[i]
        x0, x1 = int(max(0, math.floor(x.min()))), int(min(W - 1, math.ceil(x.max())))
        y0, y1 = int(max(0, math.floor(y.min()))), int(min(H - 1, math.ceil(y.max())))
        if x1 < x0 or y1 < y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        d = (y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2])
        if abs(d) < 1e-9:
            continue
        l0 = ((y[1] - y[2]) * (gx - x[2]) + (x[2] - x[1]) * (gy - y[2])) / d
        l1 = ((y[2] - y[0]) * (gx - x[2]) + (x[0] - x[2]) * (gy - y[2])) / d
        l2 = 1 - l0 - l1
        m = (l0 >= -1e-4) & (l1 >= -1e-4) & (l2 >= -1e-4)
        if not m.any():
            continue
        zz = l0 * z[0] + l1 * z[1] + l2 * z[2]
        sub = zb[y0:y1 + 1, x0:x1 + 1]
        upd = m & (zz > sub)
        c = cols[i, :3] * shade[i]
        al = cols[i, 3]
        im = img[y0:y1 + 1, x0:x1 + 1]
        im[upd] = im[upd] * (1 - al) + c * al
        if al >= 1:
            sub[upd] = zz[upd]
    return Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))


if __name__ == "__main__":
    args = sys.argv[1:]
    cut = int(args[args.index("--cut") + 1]) if "--cut" in args else None
    az = float(args[args.index("--az") + 1]) if "--az" in args else -35
    el = float(args[args.index("--el") + 1]) if "--el" in args else (28 if cut is None else 55)
    t, c, meta = load(args[0], cut)
    render(t, c, az=az, el=el).save(args[1])
