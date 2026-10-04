# /// script
# dependencies = ["pillow", "numpy"]
# ///
"""image-qc: ADVISORY exposure screen over one episode's rendered stills.

*** THIS IS NOT THE REAL GATE. The real gate is a vision audit -- an agent that
LOOKS at every frame. Histograms cannot judge a show's photography. ***

History, so nobody re-learns it the hard way (measured on a low-key show whose
house style is a small bright subject against deliberate darkness):
  - One episode's first cut genuinely was too dark (median luma 19, 3.8% midtones,
    "black on black on black" per a first viewer). A measurement gate was the right
    instinct.
  - The first gate keyed on mean brightness and failed correct low-key SPACE shots,
    because a starfield frame is legitimately mostly black.
  - Recalibrated to midtone presence, it still flagged 27 of 55 frames. A vision
    audit of those same frames found **zero** readability failures -- including the
    episode's best image (luma 14, 1% midtones, and perfect). No histogram can
    distinguish a deliberate low-key frame from mud.
  - What the eyes DID find, and no statistic ever could: ten canon violations --
    a species drawn as the wrong species, a ship sitting on solid ground. Content
    errors, not exposure errors.

So: this script reports distribution and shouts about catastrophic blackouts only.
Frames it flags are candidates for a LOOK, never automatic re-rolls.

Usage: image-qc.py <episode> [--show-root <path>]
"""
import glob, json, os, sys
import numpy as np
from PIL import Image

from lib import showconfig as sc

# Catastrophe-only thresholds. A frame must be BOTH near-black overall AND devoid
# of shape to fail -- i.e. generation actually broke. Real frames in this show sit
# far below any "broadcast" floor and are correct.
MEAN_MIN = 10.0
MID_MIN = 1.0
ADVISE_MID = 5.0     # advisory only: worth a human look, NOT a failure

def stats(path):
    a = np.asarray(Image.open(path).convert("L"), dtype=np.uint8)
    h = np.bincount(a.ravel(), minlength=256); tot = a.size
    return {"mean": float(a.mean()),
            "crushed": float(h[:16].sum()/tot*100),
            "mid": float(h[64:192].sum()/tot*100),
            "high": float(h[192:].sum()/tot*100)}

def main():
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    prod = sc.production_dir(cfg)
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("image-qc: episode id missing "
                 "(usage: image-qc.py <episode> [--show-root <path>])")
    images = f"{prod}/{ep}/images"
    paths = sorted(glob.glob(f"{images}/*.png"))
    if not paths:
        sys.exit(f"image-qc: no images under {images}/")

    rows = []
    for pos, p in enumerate(paths, 1):
        sc.progress(pos, len(paths), "frames")
        rows.append((p, stats(p)))
    broken = [(p, s) for p, s in rows if s["mean"] < MEAN_MIN and s["mid"] < MID_MIN]
    look   = [(p, s) for p, s in rows if s["mid"] < ADVISE_MID and (p, s) not in broken]

    M = np.array([s["mean"] for _, s in rows])
    D = np.array([s["mid"] for _, s in rows])
    print(f"image-qc (ADVISORY): {len(rows)} frames | "
          f"luma median {np.median(M):.1f} (min {M.min():.0f}) | "
          f"midtones median {np.median(D):.1f}% (min {D.min():.1f}%)")

    if look:
        print(f"\n{len(look)} frame(s) are very dark — worth a LOOK, not an automatic re-roll:")
        for p, s in look:
            print(f"  {os.path.basename(p):42} luma {s['mean']:5.1f}  mid {s['mid']:4.1f}%")

    if broken:
        print(f"\n{len(broken)} frame(s) look CATASTROPHIC (near-black AND shapeless):")
        for p, s in broken:
            print(f"  {os.path.basename(p):42} luma {s['mean']:5.1f}  mid {s['mid']:4.1f}%")
        print("\nIf a look confirms they are mud, delete and re-run image-generate:")
        print("  rm " + " ".join(f'"{p}"' for p, _ in broken))
        sys.exit(f"IMAGE_QC_FAIL {len(broken)}/{len(rows)} frames appear broken")

    print("\nREMINDER: this screen cannot judge composition, species, or canon — "
          "run the vision audit before accepting a set.")
    # The last line is this step's RESULT.
    print(f"IMAGE_QC_OK {len(rows)} frames (no catastrophic frames)")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"image-qc: {err}")
