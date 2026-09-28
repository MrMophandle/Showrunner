# /// script
# dependencies = []
# ///
"""image-sheet: prompts.json -> a human-readable IMAGE-SHEET.md for the episode.

The showrunner's shot list at a glance: every image, who renders it (the local
engine vs Nano Banana), whether it's in place yet, and — for the Nano Banana
shots — a clean brief to paste into Nano Banana. Standard artifact per episode.

Usage: uv run .archon/scripts/image-sheet.py   (ARGUMENTS or argv = episode id)
Writes Production/<ep>/images/IMAGE-SHEET.md.
"""
import json, os, re, sys

# strip the standard scaffolding so an ambient shot shows just its subject
_PREFIX = re.compile(r"^.*?(?:ducting overhead, |deep teal-black starfield, |starfield, )", re.S)
_SUFFIX = re.compile(r",?\s*low-key but clearly exposed.*$", re.S)

def subject(prompt):
    s = _PREFIX.sub("", prompt or "")
    s = _SUFFIX.sub("", s).strip().rstrip(",")
    return (s[:1].upper() + s[1:]) if s else (prompt or "")[:120]

def main():
    ep = os.environ.get("ARGUMENTS", "").split()[0] if os.environ.get("ARGUMENTS") else (sys.argv[1] if len(sys.argv) > 1 else "")
    if not ep:
        sys.exit("image-sheet: episode id missing")
    base = f"Production/{ep}/images"
    doc = json.load(open(f"{base}/prompts.json"))
    shots = doc["shots"]
    def present(sid): return os.path.exists(f"{base}/{sid}.png")

    nano = [s for s in shots if s.get("type") == "character"]
    local = [s for s in shots if s.get("type") != "character"]
    n_done = sum(present(s["id"]) for s in nano)
    l_done = sum(present(s["id"]) for s in local)

    L = []
    L.append(f"# {ep} — Image Sheet")
    L.append("")
    L.append(f"**{len(shots)} images total** — "
             f"**{len(nano)} by you** (Nano Banana), **{len(local)} by the engine** (local Z-Image).")
    L.append("")
    L.append("Rule (visual-style.md): the local engine renders environments, props, and "
             "faceless human extras only — **never a named character or any alien**. "
             "Everything with an identity is a Nano Banana shot.")
    L.append("")

    # ── YOUR SHOTS ────────────────────────────────────────────────────────
    todo = [s for s in nano if not present(s["id"])]
    done = [s for s in nano if present(s["id"])]
    L.append("---")
    L.append(f"## 🎨 Your shots — Nano Banana  ({n_done}/{len(nano)} in place)")
    L.append("")
    L.append("Make each in Nano Banana using the named reference sheet(s) from "
             "`Canon/characters/` (they carry the likeness — the brief describes the "
             f"shot). Save as **exactly** the filename shown into `Production/{ep}/images/`.")
    L.append("")
    L.append(f"### To make  ({len(todo)})")
    L.append("")
    for s in todo:
        refs = ", ".join(s.get("refs", [])) or "—"
        L.append(s["id"] + ".png")                       # bare filename, own line — easy copy
        L.append("")
        L.append(f"refs: **{refs}**  ·  {s.get('scene','')}")
        L.append("")
        L.append("> " + (s.get("brief", "").strip() or "*(no brief)*").replace("\n", "\n> "))
        L.append("")
    if done:
        L.append(f"### Already in place  ({len(done)})")
        L.append("")
        for s in done:
            refs = ", ".join(s.get("refs", [])) or "—"
            L.append(f"- ✅ {s['id']}.png  ·  refs: {refs}  ·  {s.get('scene','')}")
        L.append("")

    # ── ENGINE SHOTS ──────────────────────────────────────────────────────
    L.append("---")
    L.append(f"## ⚙️ Engine shots — local Z-Image  ({l_done}/{len(local)} in place)")
    L.append("")
    L.append("Generated automatically on your GPU. Listed for reference — nothing for you to do.")
    L.append("")
    L.append("| ✓ | File | Subject |")
    L.append("|---|------|---------|")
    for s in local:
        mark = "✅" if present(s["id"]) else "⬜"
        L.append(f"| {mark} | `{s['id']}.png` | {subject(s.get('prompt',''))[:110]} |")
    L.append("")

    out = f"{base}/IMAGE-SHEET.md"
    open(out, "w").write("\n".join(L) + "\n")
    print(f"IMAGE_SHEET {ep}: {out}  ({len(nano)} nano [{n_done} done], {len(local)} local [{l_done} done])")

main()
