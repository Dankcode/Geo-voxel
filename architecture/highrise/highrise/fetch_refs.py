"""Download the 12 zuobang.net renderings the reference plans were traced from.

    python -m highrise.fetch_refs [dest]     (default: ../../out/zuobang, git-ignored)

The images belong to zuobang.net; they are fetched for local checking only
and are never committed.
"""
import os
import sys
import urllib.request

from highrise.refplans import PLANS


def main(dest="../../out/zuobang"):
    os.makedirs(dest, exist_ok=True)
    for p in PLANS:
        f = os.path.join(dest, p["src"].rsplit("/", 1)[1])
        if os.path.exists(f):
            continue
        req = urllib.request.Request(p["src"], headers={"User-Agent": "geo-voxel-reference-check"})
        with urllib.request.urlopen(req, timeout=30) as r, open(f, "wb") as o:
            o.write(r.read())
        print("fetched", f)


if __name__ == "__main__":
    main(*sys.argv[1:])
