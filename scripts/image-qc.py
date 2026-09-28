# /// script
# dependencies = ["pillow", "numpy"]
# ///
"""image-qc: ADVISORY exposure screen (Canon/visual-style.md).

*** THIS IS NOT THE REAL GATE. The real gate is a vision audit -- an agent that
LOOKS at every frame. Histograms cannot judge this show's photography. ***

History, so nobody re-learns it the hard way:
  - ep01 v1 genuinely was too dark (median luma 19, 3.8% midtones, "black on black
    on black" per a first viewer). A measurement gate was the right instinct.
  - The first gate keyed on mean brightness and failed correct low-key SPACE shots,
    because a starfield frame is legitimately mostly black.
  - Recalibrated to midtone presence, it still flagged 27 of 55 frames. A vision
    audit of those same frames found **zero** readability failures -- including the
    episode's best image (the shard waking in a cupped hand: luma 14, 1% midtones,
    and perfect). A tiny bright subject against deliberate darkness is the house
    style, and no histogram can distinguish it from mud.
  - What the eyes DID find, and no statistic ever could: 10 canon violations --
    the Vesk rigger drawn as a human, Opha drawn as a spider, a ship sitting on
    solid ground. Content errors, not exposure errors.

So: this script reports distribution and shouts about catastrophic blackouts only.
Frames it flags are candidates for a LOOK, never automatic re-rolls.
"""
import glob, json, os, sys
import numpy as np
from PIL import Image

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
    ep = os.environ.get("ARGUMENTS", "").split()[0] if os.environ.get("ARGUMENTS") else ""
    if not ep:
        sys.exit("image-qc: episode id missing (first token of ARGUMENTS)")
    paths = sorted(glob.glob(f"Production/{ep}/images/*.png"))
    if not paths:
        sys.exit(f"image-qc: no images under Production/{ep}/images/")

    rows = [(p, stats(p)) for p in paths]
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

    print(f"\nIMAGE_QC_OK (no catastrophic frames). "
          f"REMINDER: this screen cannot judge composition, species, or canon — "
          f"run the vision audit before accepting a set.")

main()
