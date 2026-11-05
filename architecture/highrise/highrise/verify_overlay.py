"""Draw the traced reference plans over the original renderings, to check the tracing.

The renderings are not in the repo. Download them into the repo's git-ignored out/zuobang/ first
(`python -m highrise.fetch_refs`), then run `python -m highrise.verify_overlay`
from architecture/highrise/.
Calibration: pixel origin of the first dimension tick (ox, oy) and px per mm, as read
off each drawing's own dimension strings. Lingxiu plans were read on a 2x upscale.
"""
import os
import sys
from PIL import Image, ImageDraw

from highrise.refplans import PLANS

CAL = {  # id: (file, upscale, ox, oy, px_per_mm) ; ox/oy/s measured on the upscaled image
    "xa-C6": ("1-2304111AS9.jpg", 1, 62, 327, 0.0698),
    "xa-C2": ("1-2304111AT6.jpg", 1, 165, 357, 0.0699),
    "xa-C1": ("1-2304111AT7.jpg", 1, 140, 327, 0.0698),
    "xa-C5": ("1-2304111AT7-50.jpg", 1, 87, 315, 0.0699),
    "xa-B5": ("1-2304111AT7-51.jpg", 1, 215, 373, 0.0696),
    "xa-B1": ("1-2304111AU2.jpg", 1, 200, 455, 0.0703),
    "xa-A4": ("1-2304111AU3.jpg", 1, 245, 333, 0.0698),
    "xa-B2": ("1-2304111AU3-50.jpg", 1, 205, 343, 0.0697),
    "lx-A3": ("1-140R11TA0.jpg", 2, 653, 293, 0.0637),
    "lx-C1": ("1-140R11TA0-51.jpg", 2, 637, 247, 0.0605),
    "lx-E1": ("1-140R11TA1.jpg", 2, 622, 233, 0.0637),
    "lx-F2": ("1-140R11TA1-50.jpg", 2, 565, 278, 0.0635),
}
COL = {"LR": (230, 120, 40), "DR": (230, 170, 40), "KT": (200, 40, 40), "KW": (200, 80, 80),
       "BRM": (40, 90, 200), "BR": (60, 150, 230), "ST": (120, 80, 200), "BAM": (20, 160, 160),
       "BA": (40, 190, 170), "EN": (90, 160, 60), "HL": (130, 190, 90), "CL": (150, 110, 70),
       "SR": (120, 120, 120), "NA": (190, 90, 160), "BL": (60, 170, 60), "BLN": (60, 170, 60),
       "CORE": (60, 60, 60)}


def overlay(plan, imgdir):
    f, up, ox, oy, s = CAL[plan["id"]]
    im = Image.open(os.path.join(imgdir, f)).convert("RGB")
    if up != 1:
        im = im.resize((im.width * up, im.height * up), Image.LANCZOS)
    d = ImageDraw.Draw(im, "RGBA")
    for rid, rm in plan["rooms"].items():
        c = COL.get(rm["type"], (0, 0, 0))
        for x0, y0, x1, y1 in rm["rects"]:
            box = [ox + x0 * s, oy + y0 * s, ox + x1 * s, oy + y1 * s]
            d.rectangle(box, fill=c + (60,), outline=c + (255,), width=3)
        x0, y0, _, _ = rm["rects"][0]
        d.text((ox + x0 * s + 6, oy + y0 * s + 6), f"{rid}:{rm['type']}", fill=(0, 0, 0, 255))
    return im


def main(imgdir="../../out/zuobang", out="../../out/zuobang/overlay"):
    os.makedirs(out, exist_ok=True)
    for p in PLANS:
        overlay(p, imgdir).save(os.path.join(out, p["id"] + ".png"))
        print("wrote", os.path.join(out, p["id"] + ".png"))


if __name__ == "__main__":
    main(*sys.argv[1:])
